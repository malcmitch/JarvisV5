'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { motion } from 'framer-motion';
import * as THREE from 'three';
import { PageHeader } from '../PageHeader';
import { sfx } from '../../lib/sfx';

// ── Assets ────────────────────────────────────────────────────────────────────
const BOARD_URL = '/models/Onewheel/onewheel_pint.glb';
const DOG_URL = '/models/Onewheel/robot_dog_unitree_go1.glb';
const SHOES_URL = '/models/Onewheel/shoes/Meshy_AI_Armored_Cyber_Boot_0807202326_texture.glb';
const BOOT_URLS = [
  '/models/Onewheel/boots/rightToe.glb',
  '/models/Onewheel/boots/rightHeel.glb',
  '/models/Onewheel/boots/rightShin.glb',
  '/models/Onewheel/boots/rightCalf.glb',
  '/models/Onewheel/boots/rightActuators.glb',
] as const;

const ACCENT = '#22d3ee';
const ACCENT_DIM = 'rgba(34,211,238,';
const ORANGE = '#ff8a1f';

// ═══════════════════════════════════════════════════════════════════════════════
// TUNABLES — adjust these when you want bigger / smaller / move / rotate
// ═══════════════════════════════════════════════════════════════════════════════
/** Hide exporter leftovers (e.g. Plane_Floor) before bounds + holo. */
const BOARD_HIDE_NAME_RE = /plane|floor|shadow/i;

/**
 * Pose uses degrees for pitch/yaw/roll so the debug panel matches what you type.
 *
 * Board / dog: pitch/yaw/roll are that object's home orientation (independent).
 *
 * Paired boots/shoes:
 *   x/y/z = pair center, spread = half L↔R gap
 *   pitch/yaw/roll = COMBINED — rotates both feet around the pair center
 *   localPitch/Yaw/Roll = INDIVIDUAL — same local orientation applied to each foot
 */
type AddonPose = {
  size: number;
  x: number;
  y: number;
  z: number;
  /** Half-distance from pair center to each foot (pairs only). */
  spread?: number;
  pitch: number;
  yaw: number;
  roll: number;
  /** Per-foot local orientation (pairs only; applied identically to L and R). */
  localPitch?: number;
  localYaw?: number;
  localRoll?: number;
};

const DEFAULT_BOARD: AddonPose = {
  size: 3.6,
  x: 0, y: 0, z: 0,
  pitch: 0, yaw: 0, roll: -23,
};

const DEFAULT_DOG: AddonPose = {
  size: 3.9,
  x: 0, y: 0.72, z: 0,
  pitch: 0, yaw: 0, roll: 22,
};

/** Mag-lock OBJ boots — 3× size; combined + individual RPY. */
const DEFAULT_BOOTS: AddonPose = {
  size: 3.45,
  x: 0, y: 0.42, z: 0.05,
  spread: 0.55,
  pitch: -90, yaw: 0, roll: 0,
  localPitch: 0, localYaw: 0, localRoll: 0,
};

/** Textured cyber shoes — size 1; both toes forward (mirror only, no 180° flip). */
const DEFAULT_SHOES: AddonPose = {
  size: 1,
  x: 0, y: 0.42, z: 0.05,
  spread: 0.55,
  pitch: 0, yaw: 90, roll: 0,
  localPitch: 0, localYaw: 0, localRoll: 0,
};

/** Orange thruster glow under each sole — flat wide disks. */
const GLOW_RADIUS = 0.16;
const GLOW_HEIGHT = 0.014;
const GLOW_Y = -0.01;

function GlowSoleDisk({ matRef }: { matRef: React.RefObject<THREE.MeshBasicMaterial | null> }) {
  return (
    <>
      <mesh position={[0, GLOW_Y, 0]}>
        <cylinderGeometry args={[GLOW_RADIUS, GLOW_RADIUS, GLOW_HEIGHT, 40]} />
        <meshBasicMaterial
          ref={matRef}
          color={ORANGE}
          transparent
          opacity={0.85}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <pointLight position={[0, GLOW_Y, 0]} color={ORANGE} intensity={2.4} distance={2.4} />
    </>
  );
}

const DOUBLE_TAP_MS = 380;
const POSE_STORAGE_KEY = 'jarvis_onewheel_poses';

/** Roll-only ride wobble — oscillates around each saved default, shared board pivot. */
const ROLL_WOBBLE_AMP_DEG = 7;
const ROLL_WOBBLE_SPEED = 1.25;

type SavedPoses = {
  board: AddonPose;
  dog: AddonPose;
  boots: AddonPose;
  shoes: AddonPose;
};

function loadSavedPoses(): SavedPoses | null {
  try {
    const raw = localStorage.getItem(POSE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedPoses>;
    if (!parsed.board || !parsed.dog || !parsed.boots || !parsed.shoes) return null;
    return {
      board: { ...DEFAULT_BOARD, ...parsed.board },
      dog: { ...DEFAULT_DOG, ...parsed.dog },
      boots: { ...DEFAULT_BOOTS, ...parsed.boots },
      shoes: { ...DEFAULT_SHOES, ...parsed.shoes },
    };
  } catch {
    return null;
  }
}

function savePoses(poses: SavedPoses) {
  localStorage.setItem(POSE_STORAGE_KEY, JSON.stringify(poses));
}

function degToRad3(pitch: number, yaw: number, roll: number): [number, number, number] {
  return [
    THREE.MathUtils.degToRad(pitch),
    THREE.MathUtils.degToRad(yaw),
    THREE.MathUtils.degToRad(roll),
  ];
}

function degToRadPose(p: AddonPose): [number, number, number] {
  return degToRad3(p.pitch, p.yaw, p.roll);
}

function degToRadLocal(p: AddonPose): [number, number, number] {
  return degToRad3(p.localPitch ?? 0, p.localYaw ?? 0, p.localRoll ?? 0);
}

function poseToQuaternion(p: Pick<AddonPose, 'pitch' | 'yaw' | 'roll'>) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(p.pitch),
      THREE.MathUtils.degToRad(p.yaw),
      THREE.MathUtils.degToRad(p.roll),
      'XYZ',
    ),
  );
}

/**
 * Express an absolute home pose in the board's local frame so add-ons can ride
 * the shared roll wobble pivot without drifting off the deck.
 */
function absoluteToRelativePose(child: AddonPose, board: AddonPose): AddonPose {
  const boardQ = poseToQuaternion(board);
  const childQ = poseToQuaternion(child);
  const relQ = boardQ.clone().invert().multiply(childQ);
  const relE = new THREE.Euler().setFromQuaternion(relQ, 'XYZ');

  const relPos = new THREE.Vector3(
    child.x - board.x,
    child.y - board.y,
    child.z - board.z,
  ).applyQuaternion(boardQ.clone().invert());

  return {
    ...child,
    x: relPos.x,
    y: relPos.y,
    z: relPos.z,
    pitch: THREE.MathUtils.radToDeg(relE.x),
    yaw: THREE.MathUtils.radToDeg(relE.y),
    roll: THREE.MathUtils.radToDeg(relE.z),
  };
}

// ── Hologram shader (fresnel + scanlines, with skinning for GLBs) ─────────────
const HOLO_VERTEX = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vWorldY;
  varying vec2 vUv;
  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    vNormal = normalize(normalMatrix * objectNormal);
    #include <begin_vertex>
    #include <skinning_vertex>
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;
    vUv = uv;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const HOLO_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform float uDetail;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vWorldY;
  varying vec2 vUv;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 2.2);
    float scan = 0.82 + 0.18 * sin(vWorldY * 46.0 - uTime * 2.4);
    float lum = dot(texture2D(uMap, vUv).rgb, vec3(0.299, 0.587, 0.114));
    float contrast = clamp((lum - 0.45) * 2.2 + 0.5, 0.0, 1.0);
    float detail = uHasMap * uDetail;
    float deviation = abs(contrast - 0.5) * 2.0;
    float alpha = (0.04 + 1.1 * fres + 0.55 * detail * deviation) * scan * uIntensity;
    vec3 col = uColor * (0.3 + fres * 2.2 + 1.6 * detail * contrast * contrast) * scan;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

const TRUE_ORIGINALS = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();

let whiteTexture: THREE.Texture | null = null;
function getWhiteTexture(): THREE.Texture {
  if (!whiteTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1, 1);
    whiteTexture = new THREE.CanvasTexture(c);
  }
  return whiteTexture;
}

function makeHologramMaterial(
  color: THREE.Color,
  intensity: number,
  map: THREE.Texture | null,
  detail: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uTime: { value: 0 },
      uIntensity: { value: intensity },
      uMap: { value: map ?? getWhiteTexture() },
      uHasMap: { value: map ? 1 : 0 },
      uDetail: { value: detail },
    },
    vertexShader: HOLO_VERTEX,
    fragmentShader: HOLO_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function makeGlowTexture(color: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, color);
  grad.addColorStop(0.4, color + '66');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bounds in `root`'s local space (strips parent scale/position).
 * CRITICAL: never use raw matrixWorld for fit-to-size — after the model is
 * parented under a scaled group, world bounds already include that scale, so
 * `size / maxDim` compounds and 1→2→1 blows up to enormous sizes.
 */
function computeLocalSceneBox(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isMesh || !m.visible) return;
    if (m.isSkinnedMesh) {
      m.skeleton.update();
      m.computeBoundingBox();
      if (!m.boundingBox) return;
      tmp.copy(m.boundingBox).applyMatrix4(m.matrixWorld).applyMatrix4(invRoot);
    } else {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      if (!m.geometry.boundingBox) return;
      tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld).applyMatrix4(invRoot);
    }
    box.union(tmp);
  });
  return box;
}

function applyHolo(
  root: THREE.Object3D,
  colorHex: string,
  intensity = 1,
  detail = 0.55,
): THREE.ShaderMaterial[] {
  const color = new THREE.Color(colorHex);
  const mats: THREE.ShaderMaterial[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!TRUE_ORIGINALS.has(m)) TRUE_ORIGINALS.set(m, m.material);
    const orig = TRUE_ORIGINALS.get(m);
    const first = Array.isArray(orig) ? orig[0] : orig;
    const map = (first as THREE.MeshStandardMaterial | undefined)?.map ?? null;
    const mat = makeHologramMaterial(color, intensity, map, detail);
    m.material = mat;
    mats.push(mat);
  });
  return mats;
}

function restoreOriginals(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const orig = TRUE_ORIGINALS.get(m);
    if (orig) m.material = orig;
  });
}

type AddonId = 'dog' | 'boots' | 'shoes';

/** Hide meshes whose name matches (e.g. exporter floor planes). */
function hideMeshesByName(root: THREE.Object3D, re: RegExp) {
  root.traverse((o) => {
    if (re.test(o.name)) o.visible = false;
  });
}

// ── Normalized GLB under a fixed target size ─────────────────────────────────
function FittedGltf({
  url,
  size,
  color = ACCENT,
  feetOnGround = true,
  hideNameRe,
  /** When true, keep baked textures / PBR mats. When false, apply hologram. */
  textured = false,
}: {
  url: string;
  size: number;
  color?: string;
  feetOnGround?: boolean;
  hideNameRe?: RegExp;
  textured?: boolean;
}) {
  const { scene: cached } = useGLTF(url);
  const scene = useMemo(() => {
    const cloned = cached.clone(true);
    if (hideNameRe) hideMeshesByName(cloned, hideNameRe);
    return cloned;
  }, [cached, hideNameRe]);
  const holoMats = useRef<THREE.ShaderMaterial[]>([]);

  // Measure LOCAL bounds once per scene. Size is only a multiplier after that —
  // never re-fit from world bounds (that compounds with the parent scale).
  const layout = useMemo(() => {
    const box = computeLocalSceneBox(scene);
    const sVec = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(sVec.x, sVec.y, sVec.z) || 1;
    if (feetOnGround) {
      return { maxDim, offset: [-center.x, -box.min.y, -center.z] as const };
    }
    return { maxDim, offset: [-center.x, -center.y, -center.z] as const };
  }, [scene, feetOnGround]);

  const scale = size / layout.maxDim;
  const offset = layout.offset;

  useEffect(() => {
    if (textured) {
      // Ensure maps render correctly under our lights
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const std = mat as THREE.MeshStandardMaterial;
          if (std?.map) std.map.colorSpace = THREE.SRGBColorSpace;
          if (std?.emissiveMap) std.emissiveMap.colorSpace = THREE.SRGBColorSpace;
          std.needsUpdate = true;
        }
      });
      return;
    }
    holoMats.current = applyHolo(scene, color, 1, 0.55);
    return () => {
      restoreOriginals(scene);
      for (const mat of holoMats.current) mat.dispose();
      holoMats.current = [];
    };
  }, [scene, color, textured]);

  useFrame((state) => {
    if (textured) return;
    for (const mat of holoMats.current) {
      // eslint-disable-next-line react-hooks/immutability
      mat.uniforms.uTime.value = state.clock.elapsedTime;
    }
  });

  return (
    <group scale={scale}>
      <group position={offset}>
        <primitive object={scene} />
      </group>
    </group>
  );
}

/** Hologram wrapper — same API as before. */
function HoloGltf(props: Omit<Parameters<typeof FittedGltf>[0], 'textured'>) {
  return <FittedGltf {...props} textured={false} />;
}

// ── Combined right-boot OBJ assembly (5 parts) — unit-normalized ─────────────
function useBootRightGroup() {
  const parts = useGLTF([...BOOT_URLS]);
  return useMemo(() => {
    const root = new THREE.Group();
    for (const p of parts) {
      const clone = p.scene.clone(true);
      root.add(clone);
    }
    // Normalize once in local space: feet at y=0, max dim = 1 (parent applies pose.size)
    const box = computeLocalSceneBox(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = 1 / maxDim;
    root.position.set(-center.x * s, -box.min.y * s, -center.z * s);
    root.scale.setScalar(s);
    const wrap = new THREE.Group();
    wrap.add(root);
    return wrap;
  }, [parts]);
}

function HoloBootPair({
  installedAt,
  pose,
  onEject,
}: {
  installedAt: number;
  pose: AddonPose;
  onEject: () => void;
}) {
  const rightSrc = useBootRightGroup();
  const right = useMemo(() => rightSrc.clone(true), [rightSrc, installedAt]);
  const left = useMemo(() => rightSrc.clone(true), [rightSrc, installedAt]);

  const holoMats = useRef<THREE.ShaderMaterial[]>([]);
  const glowMatR = useRef<THREE.MeshBasicMaterial>(null);
  const glowMatL = useRef<THREE.MeshBasicMaterial>(null);
  const lastTap = useRef(0);
  const pairRot = degToRadPose(pose);
  const localRot = degToRadLocal(pose);
  const spread = pose.spread ?? 0.55;

  useEffect(() => {
    holoMats.current = [
      ...applyHolo(right, ACCENT, 1.15, 0.35),
      ...applyHolo(left, ACCENT, 1.15, 0.35),
    ];
    return () => {
      restoreOriginals(right);
      restoreOriginals(left);
      for (const mat of holoMats.current) mat.dispose();
      holoMats.current = [];
    };
  }, [right, left]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    for (const mat of holoMats.current) {
      // eslint-disable-next-line react-hooks/immutability
      mat.uniforms.uTime.value = t;
    }
    const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 5.5));
    if (glowMatR.current) glowMatR.current.opacity = pulse;
    if (glowMatL.current) glowMatL.current.opacity = pulse;
  });

  const handleTap = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      sfx('app_close', 0.5);
      onEject();
    }
    lastTap.current = now;
  };

  return (
    <group
      onPointerDown={handleTap}
      position={[pose.x, pose.y, pose.z]}
      rotation={pairRot}
    >
      {/* Combined RPY on parent; identical local RPY on each foot */}
      <group position={[spread, 0, 0]}>
        <group rotation={localRot} scale={pose.size}>
          <primitive object={right} />
          <GlowSoleDisk matRef={glowMatR} />
        </group>
      </group>
      <group position={[-spread, 0, 0]} scale={[-1, 1, 1]}>
        <group rotation={localRot} scale={pose.size}>
          <primitive object={left} />
          <GlowSoleDisk matRef={glowMatL} />
        </group>
      </group>
    </group>
  );
}

function DogAddon({ pose, onEject }: { pose: AddonPose; onEject: () => void }) {
  const lastTap = useRef(0);
  const handleTap = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      sfx('app_close', 0.5);
      onEject();
    }
    lastTap.current = now;
  };
  return (
    <group position={[pose.x, pose.y, pose.z]} rotation={degToRadPose(pose)} onPointerDown={handleTap}>
      <HoloGltf url={DOG_URL} size={pose.size} color="#7dd3fc" feetOnGround />
    </group>
  );
}

/** Textured cyber shoes — L/R pair, keeps GLB PBR textures (no hologram). */
function TexturedShoePair({ pose, onEject }: { pose: AddonPose; onEject: () => void }) {
  const lastTap = useRef(0);
  const glowMatR = useRef<THREE.MeshBasicMaterial>(null);
  const glowMatL = useRef<THREE.MeshBasicMaterial>(null);
  const handleTap = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      sfx('app_close', 0.5);
      onEject();
    }
    lastTap.current = now;
  };
  const pairRot = degToRadPose(pose);
  const localRot = degToRadLocal(pose);
  const spread = pose.spread ?? 0.55;

  useFrame((state) => {
    const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 5.5));
    if (glowMatR.current) glowMatR.current.opacity = pulse;
    if (glowMatL.current) glowMatL.current.opacity = pulse;
  });

  return (
    <group
      onPointerDown={handleTap}
      position={[pose.x, pose.y, pose.z]}
      rotation={pairRot}
    >
      <group position={[spread, 0, 0]}>
        <group rotation={localRot}>
          <FittedGltf url={SHOES_URL} size={pose.size} feetOnGround textured />
          <group scale={pose.size}>
            <GlowSoleDisk matRef={glowMatR} />
          </group>
        </group>
      </group>
      {/* Mirror only — same individual local RPY on both (no extra 180°) */}
      <group position={[-spread, 0, 0]} scale={[-1, 1, 1]}>
        <group rotation={localRot}>
          <FittedGltf url={SHOES_URL} size={pose.size} feetOnGround textured />
          <group scale={pose.size}>
            <GlowSoleDisk matRef={glowMatL} />
          </group>
        </group>
      </group>
    </group>
  );
}

// ── Main assembly: board + addons ────────────────────────────────────────────
function HoloAssembly({
  yawRef,
  pitchUserRef,
  zoomRef,
  dogAttached,
  bootsAttached,
  bootsInstalledAt,
  shoesAttached,
  boardPose,
  dogPose,
  bootsPose,
  shoesPose,
  onEjectDog,
  onEjectBoots,
  onEjectShoes,
}: {
  yawRef: React.MutableRefObject<number>;
  pitchUserRef: React.MutableRefObject<number>;
  zoomRef: React.MutableRefObject<number>;
  dogAttached: boolean;
  bootsAttached: boolean;
  bootsInstalledAt: number;
  shoesAttached: boolean;
  boardPose: AddonPose;
  dogPose: AddonPose;
  bootsPose: AddonPose;
  shoesPose: AddonPose;
  onEjectDog: () => void;
  onEjectBoots: () => void;
  onEjectShoes: () => void;
}) {
  const rootRef = useRef<THREE.Group>(null);
  const rideRef = useRef<THREE.Group>(null);
  const wobbleT = useRef(0);
  const glowTex = useMemo(() => makeGlowTexture(ACCENT), []);

  // Keep add-on homes locked to the board while debug edits absolute poses
  const dogRel = useMemo(() => absoluteToRelativePose(dogPose, boardPose), [dogPose, boardPose]);
  const bootsRel = useMemo(() => absoluteToRelativePose(bootsPose, boardPose), [bootsPose, boardPose]);
  const shoesRel = useMemo(() => absoluteToRelativePose(shoesPose, boardPose), [shoesPose, boardPose]);

  /* eslint-disable react-hooks/immutability */
  useFrame((_, delta) => {
    const g = rootRef.current;
    if (g) {
      g.rotation.y += (yawRef.current - g.rotation.y) * Math.min(1, delta * 10);
      g.rotation.x += (pitchUserRef.current - g.rotation.x) * Math.min(1, delta * 10);
      const z = zoomRef.current;
      g.scale.setScalar(g.scale.x + (z - g.scale.x) * Math.min(1, delta * 8));
    }

    // Shared roll wobble around saved board defaults (add-ons are children → stay locked)
    const ride = rideRef.current;
    if (ride) {
      wobbleT.current += delta;
      const wobble =
        Math.sin(wobbleT.current * ROLL_WOBBLE_SPEED)
        * THREE.MathUtils.degToRad(ROLL_WOBBLE_AMP_DEG);
      ride.position.set(boardPose.x, boardPose.y, boardPose.z);
      ride.rotation.set(
        THREE.MathUtils.degToRad(boardPose.pitch),
        THREE.MathUtils.degToRad(boardPose.yaw),
        THREE.MathUtils.degToRad(boardPose.roll) + wobble,
      );
    }
  });
  /* eslint-enable react-hooks/immutability */

  return (
    <group ref={rootRef}>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02}>
        <circleGeometry args={[2.8, 48]} />
        <meshBasicMaterial map={glowTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.4} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.01}>
        <ringGeometry args={[2.2, 2.26, 72]} />
        <meshBasicMaterial color={ACCENT} transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
      </mesh>

      {/* Board pivot: default pose + roll wobble. Add-ons use board-relative homes. */}
      <group ref={rideRef}>
        <HoloGltf
          url={BOARD_URL}
          size={boardPose.size}
          color={ACCENT}
          feetOnGround
          hideNameRe={BOARD_HIDE_NAME_RE}
        />

        {dogAttached && <DogAddon pose={dogRel} onEject={onEjectDog} />}

        {bootsAttached && (
          <Suspense fallback={null}>
            <HoloBootPair installedAt={bootsInstalledAt} pose={bootsRel} onEject={onEjectBoots} />
          </Suspense>
        )}

        {shoesAttached && (
          <Suspense fallback={null}>
            <TexturedShoePair pose={shoesRel} onEject={onEjectShoes} />
          </Suspense>
        )}
      </group>
    </group>
  );
}

// ── Debug pose panel ─────────────────────────────────────────────────────────
/** Stable number field — never commits empty / "0." / NaN as 0 mid-edit. */
function PoseField({
  label,
  value,
  step,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const [text, setText] = useState(() => formatPoseNum(value));

  useEffect(() => {
    setText(formatPoseNum(value));
  }, [value]);

  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) {
      setText(formatPoseNum(value));
      return;
    }
    let v = n;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    v = Math.round(v * 1000) / 1000;
    onChange(v);
    setText(formatPoseNum(v));
  };

  return (
    <label className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-white/50">
      <span className="w-8 shrink-0 text-cyan-500/80">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        step={step}
        onChange={(e) => {
          const raw = e.target.value;
          // Allow typing intermediates like "", "-", "0.", ".5"
          if (raw !== '' && !/^-?\d*\.?\d*$/.test(raw)) return;
          setText(raw);
          if (raw === '' || raw === '-' || raw === '.' || raw === '-.' || raw.endsWith('.')) return;
          const n = parseFloat(raw);
          if (!Number.isFinite(n)) return;
          let v = n;
          if (min != null) v = Math.max(min, v);
          if (max != null) v = Math.min(max, v);
          v = Math.round(v * 1000) / 1000;
          if (v !== value) onChange(v);
        }}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(text);
            (e.target as HTMLInputElement).blur();
          }
          // Arrow keys nudge by step without the number-input scroll chaos
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            let v = (Number.isFinite(value) ? value : 0) + dir * step;
            if (min != null) v = Math.max(min, v);
            if (max != null) v = Math.min(max, v);
            v = Math.round(v * 1000) / 1000;
            onChange(v);
            setText(formatPoseNum(v));
          }
        }}
        onWheel={(e) => {
          // Blur so wheel scrolls the panel instead of nuking the value
          (e.target as HTMLInputElement).blur();
        }}
        className="w-full bg-black/50 border border-cyan-500/25 rounded px-1.5 py-0.5 text-cyan-100 text-[10px] focus:outline-none focus:border-cyan-400"
      />
    </label>
  );
}

function formatPoseNum(n: number) {
  if (!Number.isFinite(n)) return '0';
  // Trim noisy float tails (3.4500000001 → 3.45)
  return String(Math.round(n * 1000) / 1000);
}

function PoseEditor({
  title,
  color,
  pose,
  onChange,
  paired,
}: {
  title: string;
  color: string;
  pose: AddonPose;
  onChange: (p: AddonPose) => void;
  /** Boots/shoes: combined RPY (pair) + individual RPY (same on each foot) */
  paired?: boolean;
}) {
  const set = (key: keyof AddonPose, v: number) => onChange({ ...pose, [key]: v });
  return (
    <div className="border rounded p-2 space-y-1.5" style={{ borderColor: `${color}55`, background: `${color}0d` }}>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.25em]" style={{ color }}>
        {title}
      </div>
      <PoseField label="Size" value={pose.size} step={0.1} min={0.2} max={20} onChange={(v) => set('size', v)} />
      <div className="grid grid-cols-3 gap-1">
        <PoseField label="X" value={pose.x} step={0.05} onChange={(v) => set('x', v)} />
        <PoseField label="Y" value={pose.y} step={0.05} onChange={(v) => set('y', v)} />
        <PoseField label="Z" value={pose.z} step={0.05} onChange={(v) => set('z', v)} />
      </div>
      {paired && (
        <PoseField label="Sprd" value={pose.spread ?? 0.55} step={0.05} min={0} onChange={(v) => set('spread', v)} />
      )}

      <div className="font-mono text-[8px] uppercase tracking-wider text-white/30 pt-1">
        {paired ? 'Combined (pair center)' : 'Orientation'}
      </div>
      <div className="grid grid-cols-3 gap-1">
        <PoseField label="Pitch" value={pose.pitch} step={1} onChange={(v) => set('pitch', v)} />
        <PoseField label="Yaw" value={pose.yaw} step={1} onChange={(v) => set('yaw', v)} />
        <PoseField label="Roll" value={pose.roll} step={1} onChange={(v) => set('roll', v)} />
      </div>

      {paired && (
        <>
          <div className="font-mono text-[8px] uppercase tracking-wider text-white/30 pt-1">
            Individual (same on each foot)
          </div>
          <div className="grid grid-cols-3 gap-1">
            <PoseField label="Pitch" value={pose.localPitch ?? 0} step={1} onChange={(v) => set('localPitch', v)} />
            <PoseField label="Yaw" value={pose.localYaw ?? 0} step={1} onChange={(v) => set('localYaw', v)} />
            <PoseField label="Roll" value={pose.localRoll ?? 0} step={1} onChange={(v) => set('localRoll', v)} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Static preview for the right rail ────────────────────────────────────────
function AddonPreview({ url, kind }: { url?: string; kind: AddonId }) {
  if (kind === 'dog' && url) {
    return <HoloGltf url={url} size={1.6} color="#7dd3fc" feetOnGround={false} />;
  }
  if (kind === 'shoes' && url) {
    return <FittedGltf url={url} size={1.5} feetOnGround={false} textured />;
  }
  return <BootPreview />;
}

function BootPreview() {
  const right = useBootRightGroup();
  const scene = useMemo(() => right.clone(true), [right]);
  const mats = useRef<THREE.ShaderMaterial[]>([]);
  useEffect(() => {
    mats.current = applyHolo(scene, ACCENT, 1.1, 0.3);
    return () => {
      restoreOriginals(scene);
      mats.current.forEach((m) => m.dispose());
    };
  }, [scene]);
  useFrame((s) => {
    for (const m of mats.current) {
      // eslint-disable-next-line react-hooks/immutability
      m.uniforms.uTime.value = s.clock.elapsedTime;
    }
  });
  return <primitive object={scene} />;
}

function SceneLights() {
  return (
    <>
      <ambientLight intensity={0.65} color="#9ec0e0" />
      <directionalLight position={[4, 6, 3]} intensity={1.15} color="#ffffff" />
      <directionalLight position={[-3, 2, -4]} intensity={0.45} color="#6a9ad0" />
      <directionalLight position={[0, 3, -2]} intensity={0.35} color="#ffd6a8" />
    </>
  );
}

function CameraLook() {
  const { camera } = useThree();
  useEffect(() => {
    camera.lookAt(0, 0.35, 0);
  }, [camera]);
  return null;
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function OnewheelPage({ onNavigateHome }: { onNavigateHome: () => void }) {
  const [dogAttached, setDogAttached] = useState(false);
  const [bootsAttached, setBootsAttached] = useState(false);
  const [bootsInstalledAt, setBootsInstalledAt] = useState(0);
  const [shoesAttached, setShoesAttached] = useState(false);
  const [drag, setDrag] = useState<{ id: AddonId; x: number; y: number } | null>(null);
  const [hoverDrop, setHoverDrop] = useState(false);
  const [debugPose, setDebugPose] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const [boardPose, setBoardPose] = useState<AddonPose>(DEFAULT_BOARD);
  const [dogPose, setDogPose] = useState<AddonPose>(DEFAULT_DOG);
  const [bootsPose, setBootsPose] = useState<AddonPose>(DEFAULT_BOOTS);
  const [shoesPose, setShoesPose] = useState<AddonPose>(DEFAULT_SHOES);

  // Hydrate saved home poses once (avoids 4× localStorage reads in useState inits)
  useEffect(() => {
    const saved = loadSavedPoses();
    if (!saved) return;
    setBoardPose(saved.board);
    setDogPose(saved.dog);
    setBootsPose(saved.boots);
    setShoesPose(saved.shoes);
  }, []);

  const leftRef = useRef<HTMLDivElement>(null);
  const yawRef = useRef(0);
  const pitchUserRef = useRef(0.22);
  const zoomRef = useRef(1);

  const overLeft = (x: number, y: number) => {
    const el = leftRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const beginOrbit = (e: React.PointerEvent) => {
    if (drag) return;
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev: PointerEvent) => {
      yawRef.current += (ev.clientX - lastX) * 0.008;
      pitchUserRef.current = THREE.MathUtils.clamp(
        pitchUserRef.current + (ev.clientY - lastY) * 0.005,
        -0.6,
        0.85,
      );
      lastX = ev.clientX;
      lastY = ev.clientY;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const next = zoomRef.current * (e.deltaY > 0 ? 0.92 : 1.08);
    zoomRef.current = THREE.MathUtils.clamp(next, 0.45, 2.4);
  };

  const beginAddonDrag = (id: AddonId, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    sfx('select', 0.4);
    setDrag({ id, x: e.clientX, y: e.clientY });

    const move = (ev: PointerEvent) => {
      setDrag({ id, x: ev.clientX, y: ev.clientY });
      setHoverDrop(overLeft(ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const ok = overLeft(ev.clientX, ev.clientY);
      setDrag(null);
      setHoverDrop(false);
      if (!ok) return;
      sfx('select_confirm', 0.75);
      if (id === 'dog') setDogAttached(true);
      else if (id === 'boots') {
        setBootsAttached(true);
        setBootsInstalledAt(Date.now());
      } else if (id === 'shoes') setShoesAttached(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const addons: { id: AddonId; name: string; sub: string; color: string; url?: string }[] = [
    {
      id: 'dog',
      name: 'Unitree Go1',
      sub: 'Robot dog mount · rides on deck',
      color: '#7dd3fc',
      url: DOG_URL,
    },
    {
      id: 'boots',
      name: 'Mag-Lock Boots',
      sub: 'Paired left/right · mag-lock attach',
      color: ORANGE,
    },
    {
      id: 'shoes',
      name: 'Cyber Shoes',
      sub: 'Textured armor · mirrored L/R pair',
      color: '#e8b86d',
      url: SHOES_URL,
    },
  ];

  const addonActive = (id: AddonId) =>
    id === 'dog' ? dogAttached : id === 'boots' ? bootsAttached : shoesAttached;

  const dragLabel =
    drag?.id === 'boots' ? 'Mag-Lock Boots'
      : drag?.id === 'shoes' ? 'Cyber Shoes'
        : 'Unitree Go1';
  const dragColor =
    drag?.id === 'boots' ? ORANGE
      : drag?.id === 'shoes' ? '#e8b86d'
        : '#7dd3fc';

  return (
    <motion.div
      className="fixed inset-0 z-[50] overflow-hidden flex flex-col"
      style={{ background: '#020814' }}
      initial={{ x: '100%', filter: 'blur(24px)', opacity: 0 }}
      animate={{ x: 0, filter: 'blur(0px)', opacity: 1 }}
      exit={{ x: '-100%', filter: 'blur(24px)', opacity: 0 }}
      transition={{ duration: 0.65, ease: [0.4, 0, 0.2, 1] }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 90% 60% at 35% 95%, rgba(14,80,160,0.28) 0%, transparent 60%), radial-gradient(ellipse 50% 40% at 85% 10%, rgba(255,120,40,0.08) 0%, transparent 70%)',
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundImage: `radial-gradient(circle, ${ACCENT_DIM}0.12) 1px, transparent 1px)`, backgroundSize: '30px 30px' }}
      />

      <PageHeader
        title="Project OneWheel"
        onNavigateHome={onNavigateHome}
        accent="cyan"
        right={(
          <button
            type="button"
            onClick={() => { sfx('click_sfx', 0.4); setDebugPose((v) => !v); }}
            className="font-mono text-[9px] uppercase tracking-[0.25em] px-3 py-1.5 transition-colors"
            style={{
              color: debugPose ? ACCENT : 'rgba(255,255,255,0.4)',
              border: `1px solid ${debugPose ? `${ACCENT}88` : 'rgba(255,255,255,0.15)'}`,
              background: debugPose ? `${ACCENT}22` : 'transparent',
            }}
          >
            Debug {debugPose ? 'ON' : 'OFF'}
          </button>
        )}
      />

      <div className="flex-1 flex min-h-0 relative z-10">
        {/* Center / left viewer */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          <div className="absolute top-6 inset-x-0 z-10 pointer-events-none flex flex-col items-center text-center px-4">
            <h2
              className="font-mono font-black uppercase leading-none"
              style={{
                color: ACCENT,
                fontSize: 'clamp(2.4rem, 5.5vw, 4.25rem)',
                letterSpacing: '0.18em',
                textShadow: `0 0 28px ${ACCENT}aa, 0 0 60px ${ACCENT}55, 0 2px 0 rgba(0,0,0,0.55)`,
                WebkitTextStroke: `1px ${ACCENT}66`,
              }}
            >
              Project OneWheel
            </h2>
            <p
              className="font-mono font-bold uppercase mt-3"
              style={{
                color: 'rgba(255,255,255,0.45)',
                fontSize: 'clamp(0.65rem, 1.1vw, 0.85rem)',
                letterSpacing: '0.35em',
                textShadow: '0 0 12px rgba(34,211,238,0.25)',
              }}
            >
              Holographic deck
              {dogAttached ? ' · Go1 mounted' : ''}
              {bootsAttached ? ' · Mag-boots locked' : ''}
              {shoesAttached ? ' · Cyber shoes on' : ''}
              {!dogAttached && !bootsAttached && !shoesAttached ? ' · Awaiting add-ons' : ''}
            </p>
          </div>

          <div
            ref={leftRef}
            className="flex-1 min-h-0 cursor-grab active:cursor-grabbing"
            style={{
              touchAction: 'none',
              outline: hoverDrop ? `1px solid ${ACCENT}` : 'none',
              boxShadow: hoverDrop ? `inset 0 0 40px ${ACCENT_DIM}0.2)` : 'none',
            }}
            onPointerDown={beginOrbit}
            onWheel={onWheel}
          >
            <Canvas
              dpr={[1, 2]}
              camera={{ position: [0, 1.8, 5.4], fov: 38 }}
              gl={{ alpha: true, antialias: true }}
            >
              <SceneLights />
              <CameraLook />
              <Suspense fallback={null}>
                <HoloAssembly
                  yawRef={yawRef}
                  pitchUserRef={pitchUserRef}
                  zoomRef={zoomRef}
                  dogAttached={dogAttached}
                  bootsAttached={bootsAttached}
                  bootsInstalledAt={bootsInstalledAt}
                  shoesAttached={shoesAttached}
                  boardPose={boardPose}
                  dogPose={dogPose}
                  bootsPose={bootsPose}
                  shoesPose={shoesPose}
                  onEjectDog={() => setDogAttached(false)}
                  onEjectBoots={() => setBootsAttached(false)}
                  onEjectShoes={() => setShoesAttached(false)}
                />
              </Suspense>
            </Canvas>
          </div>

          {debugPose && (
            <div
              className="absolute left-3 bottom-12 z-20 w-[300px] max-h-[55%] overflow-y-auto space-y-2 p-2 rounded pointer-events-auto"
              style={{
                background: 'rgba(2,8,20,0.92)',
                border: `1px solid ${ACCENT}44`,
                boxShadow: `0 0 24px ${ACCENT_DIM}0.2)`,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40 px-1">
                Pose debug · degrees · live
              </div>
              <PoseEditor title="OneWheel" color={ACCENT} pose={boardPose} onChange={setBoardPose} />
              <PoseEditor title="Unitree Go1" color="#7dd3fc" pose={dogPose} onChange={setDogPose} />
              <PoseEditor title="Mag-Lock Boots" color={ORANGE} pose={bootsPose} onChange={setBootsPose} paired />
              <PoseEditor title="Cyber Shoes" color="#e8b86d" pose={shoesPose} onChange={setShoesPose} paired />
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    savePoses({ board: boardPose, dog: dogPose, boots: bootsPose, shoes: shoesPose });
                    sfx('select_confirm', 0.55);
                    setSaveFlash(true);
                    window.setTimeout(() => setSaveFlash(false), 1200);
                  }}
                  className="py-1.5 font-mono text-[9px] uppercase tracking-[0.25em] rounded border transition-colors"
                  style={{
                    color: saveFlash ? ACCENT : 'rgba(255,255,255,0.55)',
                    borderColor: saveFlash ? `${ACCENT}88` : 'rgba(34,211,238,0.25)',
                    background: saveFlash ? `${ACCENT}22` : 'transparent',
                  }}
                >
                  {saveFlash ? 'Saved' : 'Save defaults'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    localStorage.removeItem(POSE_STORAGE_KEY);
                    setBoardPose(DEFAULT_BOARD);
                    setDogPose(DEFAULT_DOG);
                    setBootsPose(DEFAULT_BOOTS);
                    setShoesPose(DEFAULT_SHOES);
                    sfx('app_close', 0.4);
                  }}
                  className="py-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-white/40 hover:text-cyan-300 border border-white/10 rounded"
                >
                  Factory reset
                </button>
              </div>
            </div>
          )}

          <div className="absolute bottom-4 inset-x-0 flex justify-center pointer-events-none">
            <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/25">
              Drag to orbit · Scroll to zoom · Double-tap add-on to remove
            </span>
          </div>
        </div>

        {/* Right: add-ons */}
        <div
          className="w-[340px] shrink-0 flex flex-col border-l"
          style={{ borderColor: `${ACCENT_DIM}0.12)` }}
        >
          <div className="px-4 py-3 border-b" style={{ borderColor: `${ACCENT_DIM}0.12)` }}>
            <div className="font-mono text-[8px] uppercase tracking-[0.4em] text-white/30">Add-On Bay</div>
            <div className="font-mono text-[12px] font-bold uppercase tracking-[0.3em] mt-0.5" style={{ color: ACCENT }}>
              Modular Payload
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 p-3 flex flex-col gap-3">
            {addons.map((a) => {
              const active = addonActive(a.id);
              return (
                <div
                  key={a.id}
                  className="relative flex flex-col border select-none"
                  style={{
                    borderColor: active ? `${a.color}88` : `${ACCENT_DIM}0.18)`,
                    background: active ? `${a.color}10` : 'rgba(2,8,20,0.55)',
                    boxShadow: active ? `0 0 18px ${a.color}22` : 'none',
                    touchAction: 'none',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    cursor: active ? 'default' : 'grab',
                  }}
                  onPointerDown={(e) => {
                    if (active) return;
                    e.preventDefault();
                    beginAddonDrag(a.id, e);
                  }}
                >
                  <div className="px-3 pt-2.5 pb-1 flex items-start justify-between gap-2 pointer-events-none">
                    <div>
                      <div
                        className="font-mono text-[11px] font-bold uppercase tracking-[0.25em]"
                        style={{ color: a.color, textShadow: `0 0 12px ${a.color}66` }}
                      >
                        {a.name}
                      </div>
                      <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-white/30 mt-0.5">
                        {a.sub}
                      </div>
                    </div>
                    {active && (
                      <span
                        className="font-mono text-[8px] uppercase tracking-[0.2em] px-1.5 py-0.5"
                        style={{ color: a.color, border: `1px solid ${a.color}55` }}
                      >
                        Mounted
                      </span>
                    )}
                  </div>

                  <div className="relative h-40 pointer-events-none">
                    <Canvas
                      dpr={[1, 1.5]}
                      camera={{ position: [0, 0.6, 2.8], fov: 38 }}
                      gl={{ alpha: true, antialias: true }}
                      style={{ pointerEvents: 'none' }}
                    >
                      <ambientLight intensity={0.55} color="#8ab4d8" />
                      <directionalLight position={[2, 3, 2]} intensity={0.8} />
                      <Suspense fallback={null}>
                        <AddonPreview url={a.url} kind={a.id} />
                      </Suspense>
                    </Canvas>
                  </div>

                  <div className="px-3 pb-3 pt-1 pointer-events-none">
                    <div
                      className="w-full py-2 font-mono text-[9px] uppercase tracking-[0.3em] text-center"
                      style={{
                        color: a.color,
                        border: `1px solid ${a.color}55`,
                        background: 'rgba(2,8,20,0.7)',
                        boxShadow: `0 0 14px ${a.color}22`,
                        clipPath: 'polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)',
                        opacity: active ? 0.4 : 1,
                      }}
                    >
                      {active ? 'Already mounted' : '⇠ Drag anywhere to mount'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="px-4 py-3 border-t font-mono text-[8px] uppercase tracking-[0.25em] text-white/25" style={{ borderColor: `${ACCENT_DIM}0.1)` }}>
            Boots auto-mirror L/R · Orange thrusters pulse under soles
          </div>
        </div>
      </div>

      {drag && (
        <div
          className="fixed z-[60] pointer-events-none flex items-center gap-2 px-4 py-2"
          style={{
            left: drag.x,
            top: drag.y,
            transform: 'translate(-50%, -120%)',
            background: 'rgba(2,8,20,0.9)',
            border: `1px solid ${dragColor}`,
            boxShadow: `0 0 24px ${dragColor}66`,
            clipPath: 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
          }}
        >
          <span className="w-2 h-2 rounded-full animate-ping" style={{ background: dragColor }} />
          <span className="font-mono text-[10px] uppercase tracking-[0.25em]" style={{ color: dragColor }}>
            {dragLabel}
          </span>
        </div>
      )}
    </motion.div>
  );
}

useGLTF.preload(BOARD_URL);
useGLTF.preload(DOG_URL);
useGLTF.preload(SHOES_URL);
