'use client';

/**
 * Camille Gesture Control — webcam hand-gesture input for the whole app.
 *
 * Semantics (tuned from feel-testing):
 *   - One finger extended (index only)   → pointer mode: cursor follows the
 *     index fingertip 1:1 (smoothed), NOT the whole hand's centroid.
 *   - Pinch (thumb tip ~ index tip)       → click (quick) / drag (hold+move).
 *   - Two fingers extended (index+middle) → scroll mode: vertical hand
 *     movement scrolls whatever is under the cursor.
 *   - Two open palms (all fingers, both hands) held briefly → pause/resume
 *     tracking, so you can step away or talk with your hands without the
 *     cursor flying around.
 *   - Escape key, or the toggle, → instant off.
 *
 * Runs entirely in the renderer: local MediaPipe HandLandmarker (npm package,
 * local WASM + model — no CDN, no network dependency), synthetic DOM pointer
 * events onto the real Camille UI. Camera frames never leave the machine.
 *
 * Safety: any element whose text/aria-label matches the DANGER pattern
 * (delete, stop print, pay, quit, etc.) requires a ~900ms pinch-hold instead
 * of a quick pinch, with a visible confirm ring.
 */

import { useEffect, useRef } from 'react';

const WASM_PATH = '/mediapipe/wasm';
const HAND_MODEL = '/mediapipe/models/hand_landmarker.task';

type Landmark = { x: number; y: number; z: number };
type Hand = Landmark[];

const DANGER_PATTERN =
  /delete|remove|stop\s*print|cancel\s*print|pay|purchase|revoke|kill|disconnect|log\s*out|quit|clear\s*history|force|reset\s*(all|everything)/i;

const CONFIRM_HOLD_MS = 900;
const PAUSE_HOLD_MS = 650;
/** Pinch-closed threshold to START a grab. Slightly more forgiving than the
 *  old single threshold so a slightly-imprecise pinch still registers. */
const PINCH_ON = 0.065;
/** Pinch-open threshold to RELEASE a grab. Deliberately wider than PINCH_ON
 *  (hysteresis) — without this gap, landmark jitter during a drag flickers
 *  across the threshold several times a second and drops whatever you're
 *  holding mid-drag. Once pinched, the fingers have to open noticeably
 *  farther than the pinch-on distance before we let go. */
const PINCH_OFF = 0.095;
/** Fixed synthetic pointer id + identity used for every gesture-driven
 *  pointer event in a session, so pointer-capture (sliders, framer-motion
 *  drag) and libraries that special-case "the primary pointer" behave the
 *  same as they would for a real mouse. */
const GESTURE_POINTER_ID = 1899;
/** Extension test: tip must be this much farther from the wrist than the
 *  corresponding PIP joint to count as "extended". */
const EXTEND_RATIO = 1.15;
/** Cursor smoothing — exponential moving average toward the raw fingertip
 *  target each frame. Lower = smoother/laggier, higher = snappier/jitterier. */
const CURSOR_SMOOTH = 0.35;
/** Scroll-mode smoothing is looser since we only care about delta, not
 *  absolute precision. */
const SCROLL_SMOOTH = 0.5;

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
/** Hysteresis: once pinched, require the fingers to open past PINCH_OFF (not
 *  just back above PINCH_ON) before we call it released. Landmark noise
 *  wobbles the tip distance by a few thousandths every frame; with a single
 *  threshold that wobble crosses it repeatedly during a hold, so a "grab"
 *  kept getting dropped and re-picked-up mid-drag. */
function isPinching(hand: Hand, wasPinching = false) {
  return dist(hand[4], hand[8]) < (wasPinching ? PINCH_OFF : PINCH_ON);
}
function fingerExtended(hand: Hand, tip: number, pip: number) {
  return dist(hand[tip], hand[0]) > dist(hand[pip], hand[0]) * EXTEND_RATIO;
}
function extendedFingers(hand: Hand) {
  return {
    index: fingerExtended(hand, 8, 6),
    middle: fingerExtended(hand, 12, 10),
    ring: fingerExtended(hand, 16, 14),
    pinky: fingerExtended(hand, 20, 18),
  };
}
function isOpenPalm(hand: Hand) {
  const f = extendedFingers(hand);
  return f.index && f.middle && f.ring && f.pinky && !isPinching(hand);
}
/** One finger up: index extended, the rest curled — the "pointer" pose. */
function isPointerPose(hand: Hand) {
  const f = extendedFingers(hand);
  return f.index && !f.middle && !f.ring && !f.pinky && !isPinching(hand);
}
/** Two fingers up: index + middle extended, ring/pinky curled — "scroll". */
function isScrollPose(hand: Hand) {
  const f = extendedFingers(hand);
  return f.index && f.middle && !f.ring && !f.pinky && !isPinching(hand);
}

function findScrollable(el: Element | null): Element | null {
  let node: Element | null = el;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    const scrollableY = /(auto|scroll)/.test(style.overflowY);
    if (scrollableY && node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  return null;
}

function elementIsDangerous(el: Element | null): boolean {
  if (!el) return false;
  const target = el.closest('button, [role="button"], a, [role="menuitem"]') || el;
  const text = ((target as HTMLElement).innerText || target.getAttribute('aria-label') || '').trim();
  return DANGER_PATTERN.test(text);
}

// isPrimary/pointerType/pointerId matter a lot here: framer-motion's drag
// gesture (used by HUD widgets, the lock-screen digits, etc.) explicitly
// checks isPrimaryPointer(event) before it will even start a drag, and a
// bare `new PointerEvent(...)` defaults isPrimary to false / pointerType to
// "" — so without these fields every framer-motion draggable silently
// ignored gesture pinches. A fixed pointerId also keeps setPointerCapture
// (sliders, custom drag handles) coherent across one pinch interaction.
function pointerOpts(clientX: number, clientY: number, buttons: 0 | 1): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
    pointerId: GESTURE_POINTER_ID,
    isPrimary: true,
    pointerType: 'mouse',
    button: 0,
    buttons,
  };
}
function synthClick(el: Element, clientX = 0, clientY = 0) {
  const down = pointerOpts(clientX, clientY, 1);
  const up = pointerOpts(clientX, clientY, 0);
  el.dispatchEvent(new PointerEvent('pointerdown', down));
  el.dispatchEvent(new MouseEvent('mousedown', down));
  el.dispatchEvent(new PointerEvent('pointerup', up));
  el.dispatchEvent(new MouseEvent('mouseup', up));
  el.dispatchEvent(new MouseEvent('click', up));
}
function synthPointer(type: 'pointerdown' | 'pointermove' | 'pointerup', el: Element, clientX: number, clientY: number) {
  const opts = pointerOpts(clientX, clientY, type === 'pointerup' ? 0 : 1);
  el.dispatchEvent(new PointerEvent(type, opts));
  const mtype = type === 'pointerdown' ? 'mousedown' : type === 'pointerup' ? 'mouseup' : 'mousemove';
  el.dispatchEvent(new MouseEvent(mtype, opts));
}

type Interaction =
  | { kind: 'confirm'; el: Element; start: number }
  | { kind: 'drag'; el: Element; start: number; lastX: number; lastY: number; moved: boolean }
  | { kind: 'press-empty'; start: number }
  | null;

type Status = 'idle' | 'requesting-camera' | 'loading-model' | 'ready' | 'paused' | 'error';

export function GestureControlWidget({ enabled, onStatusChange }: { enabled: boolean; onStatusChange?: (s: Status, label: string) => void }) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let landmarker: { detectForVideo: (v: HTMLVideoElement, t: number) => { landmarks: Hand[] }; close: () => void } | null = null;
    let rafId = 0;
    let lastVideoTime = -1;
    let status: Status = 'requesting-camera';
    let paused = false;
    let interaction: Interaction = null;
    let confirmFiredWaitingRelease = false;
    let pauseArmedSince: number | null = null;
    let scrollAnchorY: number | null = null;
    let scrollTargetEl: Element | null = null;
    // Tracks whether we were pinching last frame, so isPinching() can apply
    // the wider release threshold (hysteresis) instead of flickering on
    // landmark jitter mid-drag.
    let wasPinching = false;
    // Smoothed cursor position, in client pixels. Starts at screen center.
    let curX = window.innerWidth / 2;
    let curY = window.innerHeight / 2;
    let haveCursor = false;

    const setStatus = (s: Status, label = '') => {
      status = s;
      onStatusChange?.(s, label);
    };

    const setCursorVisual = (mode: 'point' | 'pinch' | 'drag' | 'scroll') => {
      const el = cursorRef.current;
      if (!el) return;
      el.style.display = 'block';
      el.style.background =
        mode === 'drag' ? 'rgba(255,196,101,.35)'
        : mode === 'pinch' ? 'rgba(101,255,170,.35)'
        : mode === 'scroll' ? 'rgba(200,140,255,.35)'
        : 'rgba(101,212,255,.18)';
      el.style.borderColor =
        mode === 'drag' ? '#ffc465' : mode === 'pinch' ? '#65ffaa' : mode === 'scroll' ? '#c88cff' : '#65d4ff';
    };

    const hitTestAt = (x: number, y: number): Element | null => {
      const c = cursorRef.current;
      if (c) c.style.display = 'none';
      const el = document.elementFromPoint(x, y);
      if (c) c.style.display = 'block';
      return el;
    };

    const moveCursorTo = (x: number, y: number) => {
      const c = cursorRef.current;
      if (!c) return;
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    };

    const stopInteraction = () => {
      if (interaction?.kind === 'drag') {
        synthPointer('pointerup', interaction.el, interaction.lastX, interaction.lastY);
      }
      interaction = null;
      confirmFiredWaitingRelease = false;
      if (ringRef.current) ringRef.current.style.borderColor = 'rgba(255,157,157,0)';
    };

    const handlePinchStart = (x: number, y: number) => {
      const el = hitTestAt(x, y);
      if (!el) return;
      if (elementIsDangerous(el)) {
        interaction = { kind: 'confirm', el, start: performance.now() };
        return;
      }
      // Prefer the nearest semantically-clickable ancestor (button/link/
      // input/etc.) so a quick pinch-and-release maps to one clean click on
      // the right element. For everything else — 3D model viewports, HUD
      // widget drag panels, canvas-based drag zones, custom sliders — grab
      // the exact element under the fingertip. Those all wire up their own
      // pointermove/pointerup listeners (often on window/document rather
      // than the element itself), and since our synthetic PointerEvents
      // bubble, dispatching on the hit element still reaches them. Without
      // this, only form-control-ish elements were ever "grabbable" and
      // dragging a 3D model or a HUD widget did nothing.
      const clickable = el.closest(
        'button, [role="button"], a, input, textarea, [role="menuitem"], [role="tab"], [role="radio"], [role="checkbox"]',
      );
      const target = clickable ?? (el === document.body || el === document.documentElement ? null : el);
      if (!target) {
        interaction = { kind: 'press-empty', start: performance.now() };
        return;
      }
      interaction = { kind: 'drag', el: target, start: performance.now(), lastX: x, lastY: y, moved: false };
      synthPointer('pointerdown', target, x, y);
    };

    const handlePinchMove = (x: number, y: number) => {
      if (!interaction) return;
      if (interaction.kind === 'drag') {
        const moved = Math.hypot(x - interaction.lastX, y - interaction.lastY) > 3 || interaction.moved;
        interaction.moved = moved;
        interaction.lastX = x;
        interaction.lastY = y;
        synthPointer('pointermove', interaction.el, x, y);
      } else if (interaction.kind === 'confirm') {
        const elapsed = performance.now() - interaction.start;
        const frac = Math.min(1, elapsed / CONFIRM_HOLD_MS);
        if (ringRef.current) {
          ringRef.current.style.borderColor = `rgba(255,157,157,${0.25 + frac * 0.6})`;
          ringRef.current.style.transform = `scale(${1 + frac * 0.35})`;
        }
        if (elapsed >= CONFIRM_HOLD_MS && !confirmFiredWaitingRelease) {
          confirmFiredWaitingRelease = true;
          synthClick(interaction.el, x, y);
        }
      }
    };

    const handlePinchEnd = () => {
      if (interaction?.kind === 'drag') {
        synthPointer('pointerup', interaction.el, interaction.lastX, interaction.lastY);
        if (!interaction.moved) synthClick(interaction.el, interaction.lastX, interaction.lastY);
      }
      stopInteraction();
    };

    const applyGestures = (hands: Hand[]) => {
      if (!hands.length) {
        if (interaction) handlePinchEnd();
        scrollAnchorY = null;
        scrollTargetEl = null;
        pauseArmedSince = null;
        wasPinching = false;
        haveCursor = false;
        if (cursorRef.current) cursorRef.current.style.display = 'none';
        setStatus(paused ? 'paused' : 'ready', 'Show a hand');
        return;
      }

      // Two open palms (both hands fully open) held briefly → pause/resume.
      if (hands.length >= 2 && hands.every(isOpenPalm)) {
        if (pauseArmedSince === null) pauseArmedSince = performance.now();
        const elapsed = performance.now() - pauseArmedSince;
        setStatus(paused ? 'paused' : 'ready', `${paused ? 'Resuming' : 'Pausing'}... ${Math.min(100, Math.round((elapsed / PAUSE_HOLD_MS) * 100))}%`);
        if (elapsed >= PAUSE_HOLD_MS) {
          paused = !paused;
          setStatus(paused ? 'paused' : 'ready', '');
          if (bannerRef.current) bannerRef.current.style.display = paused ? 'block' : 'none';
          pauseArmedSince = null;
          wasPinching = false;
          stopInteraction();
        }
        return;
      }
      pauseArmedSince = null;
      if (paused) return;

      const hand = hands[0];
      // Raw target: fingertip position, mirrored (selfie view) into client px.
      const targetX = (1 - hand[8].x) * window.innerWidth;
      const targetY = hand[8].y * window.innerHeight;

      const pinching = isPinching(hand, wasPinching);
      wasPinching = pinching;
      const scrolling = !pinching && isScrollPose(hand);

      const smooth = scrolling ? SCROLL_SMOOTH : CURSOR_SMOOTH;
      if (!haveCursor) {
        curX = targetX;
        curY = targetY;
        haveCursor = true;
      } else {
        curX += (targetX - curX) * smooth;
        curY += (targetY - curY) * smooth;
      }
      moveCursorTo(curX, curY);

      if (pinching) {
        if (!interaction) handlePinchStart(curX, curY);
        else handlePinchMove(curX, curY);
        setCursorVisual(interaction?.kind === 'drag' ? 'drag' : 'pinch');
        setStatus('ready', interaction?.kind === 'confirm' ? 'Hold to confirm...' : interaction?.kind === 'drag' ? 'Click / drag' : 'Pinching');
        scrollAnchorY = null;
        scrollTargetEl = null;
        return;
      }

      if (interaction) handlePinchEnd();

      if (scrolling) {
        setCursorVisual('scroll');
        const elUnder = hitTestAt(curX, curY);
        const target = findScrollable(elUnder);
        if (target && scrollTargetEl === target && scrollAnchorY !== null) {
          target.scrollTop += (curY - scrollAnchorY) * 2.4;
        }
        scrollTargetEl = target;
        scrollAnchorY = curY;
        setStatus('ready', target ? 'Scrolling' : 'Two fingers · no scrollable content here');
        return;
      }

      scrollAnchorY = null;
      scrollTargetEl = null;

      if (isPointerPose(hand)) {
        setCursorVisual('point');
        setStatus('ready', 'Point to move · pinch to click · two fingers to scroll');
        return;
      }

      // Any other pose (fist, three+ fingers, etc.) — keep cursor visible but idle.
      setCursorVisual('point');
      setStatus('ready', 'Point with one finger, pinch, or two-finger scroll');
    };

    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelled = true;
        cleanup();
        onStatusChange?.('idle', '');
      }
    };

    function loop() {
      rafId = requestAnimationFrame(loop);
      const v = videoRef.current;
      if (!landmarker || !v || v.readyState < 2) return;
      if (v.currentTime === lastVideoTime) return;
      lastVideoTime = v.currentTime;
      const result = landmarker.detectForVideo(v, performance.now());
      applyGestures(result.landmarks || []);
    }

    function cleanup() {
      if (rafId) cancelAnimationFrame(rafId);
      landmarker?.close?.();
      landmarker = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      document.removeEventListener('keydown', onEscape, true);
      stopInteraction();
      if (cursorRef.current) cursorRef.current.style.display = 'none';
      if (bannerRef.current) bannerRef.current.style.display = 'none';
    }

    (async () => {
      try {
        setStatus('requesting-camera');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 960 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();

        setStatus('loading-model');
        const vision = await import('@mediapipe/tasks-vision');
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
        if (cancelled) return;
        landmarker = (await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.55,
          minTrackingConfidence: 0.55,
        })) as unknown as typeof landmarker;
        if (cancelled) return;

        document.addEventListener('keydown', onEscape, true);
        setStatus('ready', 'Point to move · pinch to click · two fingers to scroll');
        loop();
      } catch {
        setStatus('error', 'Camera or model failed to start.');
        cleanup();
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [enabled, onStatusChange]);

  if (!enabled) return null;

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[2000000000] pointer-events-none">
      <div
        ref={cursorRef}
        style={{
          position: 'fixed',
          width: 26,
          height: 26,
          margin: '-13px 0 0 -13px',
          borderRadius: '50%',
          border: '2px solid #65d4ff',
          background: 'rgba(101,212,255,.18)',
          boxShadow: '0 0 16px rgba(101,212,255,.5)',
          transition: 'background .1s, border-color .1s',
          display: 'none',
        }}
      >
        <div
          ref={ringRef}
          style={{
            position: 'absolute',
            inset: -6,
            borderRadius: '50%',
            border: '2px solid rgba(255,157,157,0)',
            transition: 'border-color .1s',
          }}
        />
      </div>

      <div
        ref={bannerRef}
        style={{
          position: 'fixed',
          left: '50%',
          bottom: 26,
          transform: 'translateX(-50%)',
          padding: '10px 16px',
          borderRadius: 999,
          background: 'rgba(30,10,10,.85)',
          color: '#ffb4b4',
          font: '800 12px/1 -apple-system,sans-serif',
          letterSpacing: '.04em',
          display: 'none',
          border: '1px solid rgba(255,120,120,.4)',
          backdropFilter: 'blur(8px)',
        }}
      >
        GESTURE TRACKING PAUSED — show two open palms to resume
      </div>

      <div
        style={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          width: 150,
          aspectRatio: '4/3',
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid rgba(255,255,255,.18)',
          boxShadow: '0 10px 26px rgba(0,0,0,.5)',
          background: '#000',
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
        />
        <div
          style={{
            position: 'absolute',
            left: 6,
            bottom: 5,
            padding: '3px 6px',
            borderRadius: 6,
            background: 'rgba(0,0,0,.6)',
            color: '#dbe8f5',
            font: '800 8px/1 -apple-system,sans-serif',
            letterSpacing: '.1em',
          }}
        >
          GESTURE CAM
        </div>
      </div>
    </div>
  );
}
