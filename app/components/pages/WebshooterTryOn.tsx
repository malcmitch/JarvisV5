'use client';

import { Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { STLLoader } from 'three-stdlib';
import { motion } from 'framer-motion';
import * as THREE from 'three';
import { sfx } from '../../lib/sfx';

// ── Assets ────────────────────────────────────────────────────────────────────
const BASE_URL = '/models/SpiderMan/WebShooters/webshooter_base.stl';
const BUTTON_URL = '/models/SpiderMan/WebShooters/button.stl';

const WASM_PATH = '/mediapipe/wasm';
const HAND_MODEL = '/mediapipe/models/hand_landmarker.task';
const POSE_MODEL = '/mediapipe/models/pose_landmarker_lite.task';

const ACCENT = '#22d3ee';
const ACCENT_HOT = '#67e8f9';

// ── Mount tuning ─────────────────────────────────────────────────────────────
// The STL is modelled in millimetres with Y=0 at the wrist, so the tracked hand
// only has to supply a millimetres-per-pixel scale. Index MCP → pinky MCP spans
// roughly 82 mm on an adult hand.
const HAND_BREADTH_MM = 82;
/** Nudge back along the forearm from the wrist joint. */
const MOUNT_BACK_MM = 4;
/** Clearance above the tracked wrist centre so the plate rides on the skin. */
const MOUNT_LIFT_MM = 20;
/** Overall size trim. */
const MOUNT_SCALE = 1.5;
/** Per-frame landmark smoothing factor (0 = frozen, 1 = raw). */
const SMOOTH = 0.3;
/** How fast the mount chases the smoothed target. */
const FOLLOW = 9;

const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// Pose landmark indices: [wrist, elbow, shoulder] per side
const POSE_ARMS: [number, number, number][] = [
  [15, 13, 11],
  [16, 14, 12],
];

// ── Shared tracking state (written by the detector loop, read in useFrame) ───
interface HandTrack {
  handed: 'Left' | 'Right';
  /** 21 hand landmarks in overlay world space (pixels, Y up, Z toward viewer) */
  pts: THREE.Vector3[];
  elbow: THREE.Vector3 | null;
  shoulder: THREE.Vector3 | null;
}

interface TrackState {
  hands: HandTrack[];
  stamp: number;
  /** Clock stamp of the most recent thwip, watched by the web beam. */
  fireAt: number;
}

// ── Thwip gesture ────────────────────────────────────────────────────────────
// Middle and ring curled into the palm while index and pinky stay out. Ratios
// are tip-to-wrist over knuckle-to-wrist, so they are scale and depth agnostic.
const CURLED = 1.25;
const OUT_LONG = 1.55;
const OUT_SHORT = 1.35;

function reach(pts: THREE.Vector3[], mcp: number, tip: number) {
  const base = pts[mcp].distanceTo(pts[0]);
  return base > 1e-3 ? pts[tip].distanceTo(pts[0]) / base : 0;
}

function isThwip(pts: THREE.Vector3[]) {
  return (
    reach(pts, 9, 12) < CURLED &&
    reach(pts, 13, 16) < CURLED &&
    reach(pts, 5, 8) > OUT_LONG &&
    reach(pts, 17, 20) > OUT_SHORT
  );
}

/** Hand back to neutral — re-arms the trigger for the next shot. */
function isRelaxed(pts: THREE.Vector3[]) {
  return reach(pts, 9, 12) > OUT_LONG && reach(pts, 13, 16) > 1.5;
}

type Status = 'boot' | 'live' | 'error';

// ── Hologram shader (self-contained; matches the designer page) ──────────────
const HOLO_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vLocalY;
  void main() {
    vLocalY = position.y;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const HOLO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vLocalY;
  void main() {
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 1.8);
    float scan = 0.78 + 0.22 * sin(vLocalY * 0.9 - uTime * 5.0);
    float flicker = 0.94 + 0.06 * sin(uTime * 23.0 + vLocalY * 0.1);
    vec3 col = uColor * (0.28 + fresnel * 1.7) * scan * flicker;
    float alpha = clamp(0.16 + fresnel * 1.1, 0.0, 1.0) * uIntensity;
    gl_FragColor = vec4(col, alpha);
  }
`;

function makeHolo(color: string, intensity = 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uIntensity: { value: intensity },
    },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// ── Debug overlay: every tracked joint drawn with its real 3D depth ──────────
const MAX_POINTS = 2 * 21 + 2 * 2;
const MAX_SEGMENTS = 2 * (HAND_BONES.length + 2);

function TrackDebug({ trackRef }: { trackRef: React.RefObject<TrackState> }) {
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const pointsRef = useRef<THREE.InstancedMesh>(null);
  const linesRef = useRef<THREE.LineSegments>(null);

  const lineGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 6), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);
  useEffect(() => () => lineGeom.dispose(), [lineGeom]);

  /* eslint-disable react-hooks/immutability */
  useFrame(() => {
    const mesh = pointsRef.current;
    const lines = linesRef.current;
    if (!mesh || !lines) return;

    const hands = trackRef.current.hands;
    const pos = lineGeom.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;

    let p = 0;
    let v = 0;

    const push = (pt: THREE.Vector3, scale: number) => {
      if (p >= MAX_POINTS) return;
      dummy.position.copy(pt);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(p, dummy.matrix);
      p += 1;
    };

    const link = (a: THREE.Vector3, b: THREE.Vector3) => {
      if (v >= MAX_SEGMENTS * 2) return;
      arr[v * 3] = a.x; arr[v * 3 + 1] = a.y; arr[v * 3 + 2] = a.z;
      v += 1;
      arr[v * 3] = b.x; arr[v * 3 + 1] = b.y; arr[v * 3 + 2] = b.z;
      v += 1;
    };

    for (const h of hands) {
      for (let i = 0; i < h.pts.length; i += 1) push(h.pts[i], i === 0 ? 7 : 4.2);
      for (const [a, b] of HAND_BONES) link(h.pts[a], h.pts[b]);
      if (h.elbow) {
        push(h.elbow, 7);
        link(h.elbow, h.pts[0]);
        if (h.shoulder) {
          push(h.shoulder, 6);
          link(h.shoulder, h.elbow);
        }
      }
    }

    mesh.count = p;
    mesh.instanceMatrix.needsUpdate = true;
    lineGeom.setDrawRange(0, v);
    pos.needsUpdate = true;
    lineGeom.computeBoundingSphere();
  });
  /* eslint-enable react-hooks/immutability */

  return (
    <group>
      <instancedMesh ref={pointsRef} args={[undefined, undefined, MAX_POINTS]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshBasicMaterial color={ACCENT_HOT} transparent opacity={0.95} blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <lineSegments ref={linesRef} geometry={lineGeom} frustumCulled={false}>
        <lineBasicMaterial color={ACCENT} transparent opacity={0.55} blending={THREE.AdditiveBlending} depthWrite={false} />
      </lineSegments>
    </group>
  );
}

// ── Web beam ─────────────────────────────────────────────────────────────────
// Strands are modelled in the mount's millimetre space along +Y, so the beam
// inherits the wrist's position, orientation and scale for free.
const WEB_LENGTH_MM = 520;
const WEB_SPREAD_MM = 8;
const WEB_STRANDS = 3;
const WEB_TWIST = Math.PI * 3.4;
const WEB_GROW_S = 0.09;
const WEB_HOLD_S = 0.22;
const WEB_FADE_S = 0.42;

/** One helical strand running from the nozzle out to the tip. */
function makeStrand(phase: number, radiusMm: number, coreScale: number) {
  const steps = 80;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = phase + t * WEB_TWIST;
    // Flares out of the nozzle then draws back together toward the tip.
    const spread = WEB_SPREAD_MM * coreScale * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.85);
    pts.push(new THREE.Vector3(Math.cos(angle) * spread, t * WEB_LENGTH_MM, Math.sin(angle) * spread));
  }
  const geom = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps, radiusMm, 5, false);
  return { geom, indexCount: geom.index?.count ?? 0 };
}

function WebBeam({ trackRef }: { trackRef: React.RefObject<TrackState> }) {
  const group = useRef<THREE.Group>(null);
  const tip = useRef<THREE.Mesh>(null);
  const flash = useRef<THREE.Mesh>(null);

  const strands = useMemo(
    () => [
      ...Array.from({ length: WEB_STRANDS }, (_, i) =>
        makeStrand((i / WEB_STRANDS) * Math.PI * 2, 1.5, 1),
      ),
      makeStrand(0, 0.9, 0),
    ],
    [],
  );
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    [],
  );
  useEffect(() => () => {
    strands.forEach((s) => s.geom.dispose());
    mat.dispose();
  }, [strands, mat]);

  const shot = useRef(0);
  const age = useRef(Infinity);

  /* eslint-disable react-hooks/immutability */
  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;

    if (trackRef.current.fireAt !== shot.current) {
      shot.current = trackRef.current.fireAt;
      age.current = 0;
    }
    if (age.current === Infinity) { g.visible = false; return; }

    age.current += delta;
    const total = WEB_GROW_S + WEB_HOLD_S + WEB_FADE_S;
    if (age.current > total) {
      age.current = Infinity;
      g.visible = false;
      return;
    }
    g.visible = true;

    const grow = Math.min(1, age.current / WEB_GROW_S);
    const reachOut = 1 - Math.pow(1 - grow, 3);
    const fade = age.current < WEB_GROW_S + WEB_HOLD_S
      ? 1
      : 1 - (age.current - WEB_GROW_S - WEB_HOLD_S) / WEB_FADE_S;

    mat.opacity = Math.max(0, fade) * 0.95;
    strands.forEach((s) => {
      s.geom.setDrawRange(0, Math.max(6, Math.floor((s.indexCount * reachOut) / 6) * 6));
    });

    if (tip.current) {
      tip.current.position.y = reachOut * WEB_LENGTH_MM;
      const pop = Math.sin(Math.min(1, grow) * Math.PI * 0.5);
      tip.current.scale.setScalar(2 + pop * 6);
    }
    if (flash.current) {
      const f = Math.max(0, 1 - age.current / (WEB_GROW_S * 2));
      flash.current.scale.setScalar(0.6 + f * 9);
      flash.current.visible = f > 0.01;
    }
  });
  /* eslint-enable react-hooks/immutability */

  return (
    <group ref={group} visible={false}>
      {strands.map((s, i) => (
        <mesh key={i} geometry={s.geom} material={mat} frustumCulled={false} />
      ))}
      <mesh ref={tip} material={mat}>
        <sphereGeometry args={[1, 10, 8]} />
      </mesh>
      <mesh ref={flash} material={mat}>
        <sphereGeometry args={[1, 10, 8]} />
      </mesh>
    </group>
  );
}

// ── Holographic web-shooter locked to the wrist ──────────────────────────────
function HoloWristShooter({
  trackRef,
  mountFlipRef,
}: {
  trackRef: React.RefObject<TrackState>;
  mountFlipRef: React.RefObject<boolean>;
}) {
  const baseGeom = useLoader(STLLoader, BASE_URL);
  const buttonGeom = useLoader(STLLoader, BUTTON_URL);

  const baseMat = useMemo(() => makeHolo(ACCENT, 1.15), []);
  const buttonMat = useMemo(() => makeHolo(ACCENT_HOT, 1.5), []);
  useEffect(() => () => { baseMat.dispose(); buttonMat.dispose(); }, [baseMat, buttonMat]);

  // The STL is modelled Z-up in millimetres: +Y is the fork/firing end, +Z is
  // the top face, and the underside (-Z) is what rests against the forearm.
  // Model Y=0 already sits at the wrist, so only X and Z need re-anchoring.
  const fit = useMemo(() => {
    baseGeom.computeBoundingBox();
    const bb = baseGeom.boundingBox!;
    const center = bb.getCenter(new THREE.Vector3());
    buttonGeom.computeBoundingBox();
    const btn = buttonGeom.boundingBox!;
    const btnCenter = btn.getCenter(new THREE.Vector3());
    return {
      recenter: [-center.x, 0, -bb.min.z] as const,
      // Muzzle: just past the fork end, level with the middle of the plate.
      nozzle: [0, bb.max.y - 2, (bb.max.z - bb.min.z) * 0.5] as const,
      buttonRest: [
        center.x - btnCenter.x,
        center.y - btnCenter.y,
        bb.max.z - btn.max.z - 7,
      ] as const,
    };
  }, [baseGeom, buttonGeom]);

  const anchor = useRef<THREE.Group>(null);

  // Scratch vectors reused every frame
  const scratch = useMemo(() => ({
    forward: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    side: new THREE.Vector3(),
    palm: new THREE.Vector3(),
    handSide: new THREE.Vector3(),
    target: new THREE.Vector3(),
    basis: new THREE.Matrix4(),
    quat: new THREE.Quaternion(),
  }), []);
  const scaleRef = useRef(0);
  /** Last accepted normal, used to stop the mount flipping between hand sides. */
  const lastNormal = useRef(new THREE.Vector3());
  const lastFlip = useRef(false);

  /* eslint-disable react-hooks/immutability */
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    baseMat.uniforms.uTime.value = t;
    buttonMat.uniforms.uTime.value = t;

    const g = anchor.current;
    if (!g) return;

    const hand = trackRef.current.hands[0];
    if (!hand) {
      g.visible = false;
      return;
    }

    // Orientation comes from the hand alone. The pose elbow is usually out of
    // frame and its depth is jumpy, so it is only used for the debug skeleton.
    const { forward, normal, side, palm, handSide, target, basis, quat } = scratch;
    const wrist = hand.pts[0];

    // Averaging the four knuckles is far steadier than any single landmark.
    palm.copy(hand.pts[5]).add(hand.pts[9]).add(hand.pts[13]).add(hand.pts[17]).multiplyScalar(0.25);
    forward.subVectors(palm, wrist);
    handSide.subVectors(hand.pts[5], hand.pts[17]);
    const breadth = handSide.length() || 1;
    if (forward.lengthSq() < 1e-6) return;
    forward.normalize();

    // Back-of-hand normal. Chirality flips with the mirrored preview, so the
    // sign is keyed off handedness (and can be inverted from the HUD).
    normal.crossVectors(forward, handSide);
    normal.addScaledVector(forward, -normal.dot(forward));
    if (normal.lengthSq() < 1e-6) return;
    normal.normalize();
    if (hand.handed === 'Left') normal.negate();
    if (mountFlipRef.current) normal.negate();

    // Handedness occasionally mislabels for a frame; keeping the side we were
    // already on stops the shooter snapping through the hand. An explicit flip
    // from the HUD has to punch through that hysteresis.
    const flipped = mountFlipRef.current !== lastFlip.current;
    lastFlip.current = mountFlipRef.current;
    const prev = lastNormal.current;
    if (g.visible && !flipped && prev.lengthSq() > 0 && normal.dot(prev) < 0) normal.negate();
    prev.copy(normal);

    side.crossVectors(forward, normal);

    basis.makeBasis(side, forward, normal);
    quat.setFromRotationMatrix(basis);

    // Pixels per model millimetre, from the tracked knuckle span
    const scale = (breadth / HAND_BREADTH_MM) * MOUNT_SCALE;

    target.copy(wrist)
      .addScaledVector(forward, -MOUNT_BACK_MM * scale)
      .addScaledVector(normal, MOUNT_LIFT_MM * scale);

    const k = Math.min(1, delta * FOLLOW);

    if (!g.visible) {
      g.visible = true;
      g.position.copy(target);
      g.quaternion.copy(quat);
      scaleRef.current = scale;
    } else {
      g.position.lerp(target, k);
      g.quaternion.slerp(quat, k);
      scaleRef.current += (scale - scaleRef.current) * k;
    }
    g.scale.setScalar(scaleRef.current);
  });
  /* eslint-enable react-hooks/immutability */

  return (
    <group ref={anchor} visible={false}>
      <group position={[fit.recenter[0], fit.recenter[1], fit.recenter[2]]}>
        <mesh geometry={baseGeom} material={baseMat} />
        <mesh geometry={buttonGeom} material={buttonMat} position={[fit.buttonRest[0], fit.buttonRest[1], fit.buttonRest[2]]} />
        <group position={[fit.nozzle[0], fit.nozzle[1], fit.nozzle[2]]}>
          <WebBeam trackRef={trackRef} />
        </group>
      </group>
    </group>
  );
}

// ── HUD frame: same angular window as the 250 ml beaker scanner, full screen ─
function framePath(w: number, h: number) {
  const x = 14;
  const y = 14;
  const iw = Math.max(120, w - 28);
  const ih = Math.max(120, h - 28);
  const r = x + iw;
  const b = y + ih;
  const c = 30;
  const cx = x + iw / 2;

  const plateW = Math.min(420, iw * 0.4);
  const plateH = 34;
  const plateLeft = cx - plateW / 2;
  const plateRight = cx + plateW / 2;
  const flare = 16;

  return [
    `M ${x + c} ${y}`,
    `H ${plateLeft - flare}`,
    `L ${plateLeft} ${y + plateH}`,
    `H ${plateRight}`,
    `L ${plateRight + flare} ${y}`,
    `H ${r - c}`,
    `L ${r} ${y + c}`,
    `V ${b - c}`,
    `L ${r - c} ${b}`,
    `H ${x + c}`,
    `L ${x} ${b - c}`,
    `V ${y + c}`,
    `L ${x + c} ${y}`,
    'Z',
  ].join(' ');
}

function HudButton({
  label,
  on,
  onClick,
  alt = false,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  alt?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => { sfx('select', 0.4); onClick(); }}
      className="px-6 py-2.5 font-mono text-[10px] uppercase tracking-[0.32em] transition-colors"
      style={{
        color: on ? '#02121a' : ACCENT,
        background: on ? ACCENT : 'rgba(34,211,238,0.07)',
        border: `1px solid ${on ? ACCENT_HOT : 'rgba(34,211,238,0.45)'}`,
        boxShadow: on ? `0 0 22px rgba(34,211,238,0.45)` : 'none',
        clipPath: alt
          ? 'polygon(0 0, calc(100% - 10px) 0, 100% 100%, 10px 100%)'
          : 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
      }}
    >
      {label}
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function WebshooterTryOn({ onClose }: { onClose: () => void }) {
  const uid = useId().replace(/:/g, '');

  const [showDebug, setShowDebug] = useState(true);
  const [showCamera, setShowCamera] = useState(true);
  const [flipMount, setFlipMount] = useState(false);
  const [status, setStatus] = useState<Status>('boot');
  const [message, setMessage] = useState('Initialising perception stack');
  const [handCount, setHandCount] = useState(0);
  const [shots, setShots] = useState(0);
  const [box, setBox] = useState({ w: 1600, h: 900 });

  const shellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<TrackState>({ hands: [], stamp: 0, fireAt: 0 });
  /** Trigger latch — cleared on fire, reset when the hand relaxes. */
  const armed = useRef(true);
  const held = useRef(0);
  const flipRef = useRef(flipMount);
  flipRef.current = flipMount;
  const debugRef = useRef(showDebug);
  debugRef.current = showDebug;

  // Live view metrics, refreshed by the resize observer / video metadata
  const viewRef = useRef({ cw: 1600, ch: 900, vw: 1280, vh: 720 });
  const smoothRef = useRef<Record<string, THREE.Vector3[]>>({});

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      viewRef.current.cw = r.width;
      viewRef.current.ch = r.height;
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Camera + MediaPipe ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let handLandmarker: { detectForVideo: (v: HTMLVideoElement, t: number) => unknown; close: () => void } | null = null;
    let poseLandmarker: { detectForVideo: (v: HTMLVideoElement, t: number) => unknown; close: () => void } | null = null;
    let lastVideoTime = -1;

    const toWorld = (nx: number, ny: number, nz: number, out: THREE.Vector3) => {
      const { cw, ch, vw, vh } = viewRef.current;
      // Video is rendered object-cover and mirrored like a selfie view.
      const s = Math.max(cw / vw, ch / vh);
      const dw = vw * s;
      const dh = vh * s;
      const ox = (cw - dw) / 2;
      const oy = (ch - dh) / 2;
      const px = ox + (1 - nx) * dw;
      const py = oy + ny * dh;
      return out.set(px - cw / 2, ch / 2 - py, -nz * dw);
    };

    const smooth = (key: string, raw: THREE.Vector3[]) => {
      const prev = smoothRef.current[key];
      if (!prev || prev.length !== raw.length) {
        smoothRef.current[key] = raw.map((v) => v.clone());
        return smoothRef.current[key];
      }
      for (let i = 0; i < raw.length; i += 1) prev[i].lerp(raw[i], SMOOTH);
      return prev;
    };

    (async () => {
      try {
        setMessage('Requesting camera');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        viewRef.current.vw = video.videoWidth || 1280;
        viewRef.current.vh = video.videoHeight || 720;

        setMessage('Loading hand + pose models');
        const vision = await import('@mediapipe/tasks-vision');
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
        if (cancelled) return;

        handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
          numHands: 2,
          runningMode: 'VIDEO',
        });
        poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
          numPoses: 1,
          runningMode: 'VIDEO',
        });
        if (cancelled) return;

        setStatus('live');
        setMessage('Tracking');

        const wristTmp = new THREE.Vector3();
        const jointTmp = new THREE.Vector3();

        const tick = () => {
          raf = requestAnimationFrame(tick);
          const v = videoRef.current;
          if (!v || v.readyState < 2 || !handLandmarker || !poseLandmarker) return;
          if (v.currentTime === lastVideoTime) return;
          lastVideoTime = v.currentTime;
          viewRef.current.vw = v.videoWidth || viewRef.current.vw;
          viewRef.current.vh = v.videoHeight || viewRef.current.vh;

          const now = performance.now();
          const handRes = handLandmarker.detectForVideo(v, now) as {
            landmarks: { x: number; y: number; z: number }[][];
            handedness: { categoryName: string }[][];
          };
          // The body pose only feeds the debug skeleton, so skip the cost of it
          // whenever the overlay is hidden.
          const poseRes = debugRef.current
            ? (poseLandmarker.detectForVideo(v, now) as { landmarks: { x: number; y: number; z: number }[][] })
            : null;

          const poseLm = poseRes?.landmarks?.[0] ?? null;
          const arms = poseLm
            ? POSE_ARMS.map(([w, e, s]) => ({
                wrist: toWorld(poseLm[w].x, poseLm[w].y, poseLm[w].z, new THREE.Vector3()),
                elbow: toWorld(poseLm[e].x, poseLm[e].y, poseLm[e].z, new THREE.Vector3()),
                shoulder: toWorld(poseLm[s].x, poseLm[s].y, poseLm[s].z, new THREE.Vector3()),
              }))
            : [];

          const hands: HandTrack[] = [];
          const lists = handRes.landmarks ?? [];
          for (let i = 0; i < lists.length; i += 1) {
            const lm = lists[i];
            if (!lm || lm.length < 21) continue;
            const handed = (handRes.handedness?.[i]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right') as 'Left' | 'Right';
            const raw = lm.map((p) => toWorld(p.x, p.y, p.z, new THREE.Vector3()));
            const pts = smooth(`${handed}-${i}`, raw);

            // Pair the hand with the nearest tracked arm in screen space so the
            // debug forearm never depends on handedness labelling.
            wristTmp.copy(pts[0]);
            let best: (typeof arms)[number] | null = null;
            let bestD = Infinity;
            for (const arm of arms) {
              jointTmp.set(arm.wrist.x - wristTmp.x, arm.wrist.y - wristTmp.y, 0);
              const d = jointTmp.length();
              if (d < bestD) { bestD = d; best = arm; }
            }
            const near = best && bestD < Math.max(viewRef.current.cw, viewRef.current.ch) * 0.45 ? best : null;

            hands.push({
              handed,
              pts,
              elbow: near ? near.elbow : null,
              shoulder: near ? near.shoulder : null,
            });
          }

          trackRef.current.hands = hands;
          trackRef.current.stamp = now;
          setHandCount((c) => (c === hands.length ? c : hands.length));

          // One shot per gesture: the hand has to return to neutral to re-arm.
          const primary = hands[0];
          if (!primary) {
            armed.current = true;
            held.current = 0;
          } else if (isThwip(primary.pts)) {
            held.current += 1;
            if (armed.current && held.current >= 2) {
              armed.current = false;
              trackRef.current.fireAt = now;
              sfx(Math.random() < 0.5 ? 'web_thwip' : 'web_shooter', 0.85);
              setShots((s) => s + 1);
            }
          } else {
            held.current = 0;
            if (isRelaxed(primary.pts)) armed.current = true;
          }
        };

        raf = requestAnimationFrame(tick);
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Perception stack unavailable');
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      handLandmarker?.close();
      poseLandmarker?.close();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const path = useMemo(() => framePath(box.w, box.h), [box.w, box.h]);

  return (
    <motion.div
      ref={shellRef}
      className="fixed inset-0 z-[90] bg-black overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      {/* Everything inside the angular window */}
      <div className="absolute inset-0" style={{ clipPath: `path('${path}')` }}>
        <div className="absolute inset-0 bg-black" />
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            transform: 'scaleX(-1)',
            opacity: showCamera ? 1 : 0,
            filter: 'saturate(0.7) contrast(1.05)',
          }}
        />
        {showCamera && (
          <div
            className="absolute inset-0 pointer-events-none mix-blend-screen"
            style={{ background: 'radial-gradient(ellipse 80% 70% at 50% 50%, rgba(34,211,238,0.05) 0%, transparent 70%)' }}
          />
        )}

        <Canvas
          className="absolute inset-0"
          orthographic
          dpr={[1, 2]}
          camera={{ position: [0, 0, 2000], near: 1, far: 6000, zoom: 1 }}
          gl={{ alpha: true, antialias: true }}
        >
          {showDebug && <TrackDebug trackRef={trackRef} />}
          <Suspense fallback={null}>
            <HoloWristShooter trackRef={trackRef} mountFlipRef={flipRef} />
          </Suspense>
        </Canvas>
      </div>

      {/* Frame outline + label plate */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" width={box.w} height={box.h}>
        <defs>
          <filter id={`tryOnGlow-${uid}`} x="-12%" y="-12%" width="124%" height="124%">
            <feGaussianBlur stdDeviation="1.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          d={path}
          fill="none"
          stroke={ACCENT}
          strokeWidth="1.8"
          strokeLinejoin="miter"
          strokeLinecap="square"
          filter={`url(#tryOnGlow-${uid})`}
          style={{ filter: `drop-shadow(0 0 6px ${ACCENT}) drop-shadow(0 0 18px rgba(34,211,238,0.4))` }}
        />
        <text
          x={box.w / 2}
          y={14 + 34 * 0.68}
          textAnchor="middle"
          fill={status === 'live' ? ACCENT_HOT : ACCENT}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fontSize="15"
          fontWeight="700"
          letterSpacing="5"
        >
          WEB-SHOOTER FITTING
        </text>
        <g stroke={ACCENT} strokeWidth="1.3" fill="none" opacity="0.7">
          <path d={`M 58 14 V 26`} />
          <path d={`M ${box.w - 58} 14 V 26`} />
          <path d={`M 58 ${box.h - 14} V ${box.h - 26}`} />
          <path d={`M ${box.w - 58} ${box.h - 14} V ${box.h - 26}`} />
          <path d={`M 14 58 H 26`} />
          <path d={`M 14 ${box.h - 58} H 26`} />
          <path d={`M ${box.w - 14} 58 H ${box.w - 26}`} />
          <path d={`M ${box.w - 14} ${box.h - 58} H ${box.w - 26}`} />
        </g>
      </svg>

      {/* Telemetry */}
      <div className="absolute top-14 left-12 font-mono text-[9px] uppercase tracking-[0.3em] pointer-events-none">
        <div style={{ color: status === 'error' ? '#ef4444' : ACCENT }}>{message}</div>
        {status === 'live' && (
          <div className="text-white/35 mt-1">
            Hands {handCount} · Camera {showCamera ? 'On' : 'Off'} · Shots {shots}
          </div>
        )}
      </div>

      <div className="absolute bottom-[92px] inset-x-0 flex justify-center pointer-events-none">
        <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/25">
          Curl the two middle fingers to fire · relax the hand to reload
        </span>
      </div>

      {/* Controls */}
      <div className="absolute bottom-10 inset-x-0 flex justify-center gap-3 z-10">
        <HudButton label="Hand Points" on={showDebug} onClick={() => setShowDebug((v) => !v)} />
        <HudButton label="Camera View" on={showCamera} onClick={() => setShowCamera((v) => !v)} alt />
        <HudButton label="Flip Mount" on={flipMount} onClick={() => setFlipMount((v) => !v)} />
      </div>

      <button
        type="button"
        onClick={() => { sfx('select', 0.4); onClose(); }}
        className="absolute top-9 right-12 z-10 font-mono text-[9px] uppercase tracking-[0.35em] px-5 py-2 text-cyan-100/60 hover:text-white"
        style={{
          clipPath: 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
          background: 'rgba(34,211,238,0.06)',
          border: '1px solid rgba(34,211,238,0.3)',
        }}
      >
        Close
      </button>
    </motion.div>
  );
}
