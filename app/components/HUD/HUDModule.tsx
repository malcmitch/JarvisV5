'use client';

import { motion, useDragControls } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { sfx } from '../../lib/sfx';

const SCAN_DURATION = 0.7;
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface HUDModuleProps {
  id: string;
  title?: string;
  initialX?: number;
  initialY?: number;
  width?: number | string;
  height?: number | string;
  children: React.ReactNode;
  onDelete?: (id: string) => void;
  className?: string;
  isExpanded?: boolean;
  onToggleExpand?: (id: string) => void;
  onResize?: (id: string, width: number, height: number) => void;
  /** When false the widget stays hidden; scan fires the moment this becomes true */
  scanReady?: boolean;
  /** Full-bleed content (e.g. PDF iframe) without inner padding or scroll */
  embedContent?: boolean;
  /** Larger panel when expanded (for document viewing) */
  expandedSize?: 'standard' | 'large';
  /** Fired once per drag release with the final (possibly snapped) position */
  onPositionChange?: (id: string, x: number, y: number) => void;
  /** Given a raw drop position + size, return the snapped position (grid / edge / sibling-widget magnetism) */
  snapFn?: (x: number, y: number, width: number, height: number) => { x: number; y: number };
  /** Framer drag constraints — keeps a thrown widget from leaving the HUD area */
  dragConstraints?: React.RefObject<Element | null>;
}

export function HUDModule({
  id,
  title,
  initialX = 0,
  initialY = 0,
  width = 300,
  height = 200,
  children,
  onDelete,
  className,
  isExpanded = false,
  onToggleExpand,
  onResize,
  scanReady = true,
  embedContent = false,
  expandedSize = 'standard',
  onPositionChange,
  snapFn,
  dragConstraints,
}: HUDModuleProps) {
  const dragControls = useDragControls();
  const [isHovered, setIsHovered] = useState(false);
  const [scanActive, setScanActive] = useState(scanReady);
  const [scanned, setScanned]     = useState(scanReady); // skip scan if already ready on mount
  const isDraggingRef = useRef(false);
  const resizeRef = useRef({ startX: 0, startY: 0, startWidth: 0, startHeight: 0 });
  // Position at the moment the current drag began — combined with Framer's
  // reported offset on release to compute the drop point without waiting on
  // inertia to settle.
  const dragStartPos = useRef({ x: initialX, y: initialY });
  // Small per-widget offset so multiple widgets don't scan in perfect lockstep
  const scanDelay = useRef(Math.random() * 0.25);

  // Keep the drag-start snapshot in sync with the committed position whenever
  // we're not mid-drag (covers external updates like snap-to-grid or resize).
  useEffect(() => {
    if (!isDraggingRef.current) {
      dragStartPos.current = { x: initialX, y: initialY };
    }
  }, [initialX, initialY]);

  // Fire scan the moment scanReady flips true
  useEffect(() => {
    if (scanReady && !scanActive) {
      setScanActive(true);
      setScanned(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanReady]);

  /**
   * Expanded size and position, in pixels.
   *
   * Framer maps `x` and `translateX` onto the same transform, so setting both
   * (as this previously did with '50vw' and '-50%') means one is discarded and
   * the panel lands off-screen. Computing the centre ourselves keeps expanded
   * and dragged states in one coordinate system: plain numeric transforms.
   */
  const expandedBox = (() => {
    const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
    const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
    const w = expandedSize === 'large' ? Math.min(960, vw * 0.9) : vw * 0.6;
    const h = expandedSize === 'large' ? Math.min(vh * 0.88, 1200) : vh * 0.6;
    return {
      width: w,
      height: h,
      x: Math.max(0, (vw - w) / 2),
      y: Math.max(0, (vh - h) / 2),
    };
  })();

  // Re-render on viewport resize so an expanded panel stays centred rather
  // than keeping the centre it was given when it opened.
  const [, setViewportTick] = useState(0);
  useEffect(() => {
    const onResize = () => setViewportTick((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Animation variants
  const variants = {
    minimized: {
      x: initialX,
      y: initialY,
      width: width,
      height: height,
      zIndex: isHovered ? 10 : 1,
      scale: 1,
      opacity: 1
    },
    expanded: {
      x: expandedBox.x,
      y: expandedBox.y,
      width: expandedBox.width,
      height: expandedBox.height,
      zIndex: 50,
      scale: 1,
      opacity: 1
    },
    exit: {
      opacity: 0,
      scale: 0.9,
      transition: { duration: 0.2 }
    }
  };

  const handleResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Only allow resizing if width/height are numbers
    if (typeof width !== 'number' || typeof height !== 'number') return;

    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: width,
      startHeight: height
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!onResize) return;
      const deltaX = moveEvent.clientX - resizeRef.current.startX;
      const deltaY = moveEvent.clientY - resizeRef.current.startY;
      
      const newWidth = Math.max(200, resizeRef.current.startWidth + deltaX);
      const newHeight = Math.max(150, resizeRef.current.startHeight + deltaY);
      
      onResize(id, newWidth, newHeight);
    };

    const handlePointerUp = () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  };

  // Trackpad pinch (and ctrl+scroll) resizes the widget in place. Chromium
  // reports a pinch gesture as a wheel event with ctrlKey set — deltaY < 0
  // means "pinch out" (grow), deltaY > 0 means "pinch in" (shrink).
  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey || isExpanded || !onResize) return;
    if (typeof width !== 'number' || typeof height !== 'number') return;
    e.preventDefault();
    const scale = 1 - e.deltaY * 0.01;
    const newWidth = Math.min(1200, Math.max(200, Math.round(width * scale)));
    const newHeight = Math.min(1200, Math.max(150, Math.round(height * (newWidth / width))));
    onResize(id, newWidth, newHeight);
  };

  // Anywhere on the widget's chrome can start a drag — not just the thin
  // title bar. Real interactive descendants (buttons, inputs, links, the
  // resize handle) opt out via closest() so clicks/typing/scrolling inside
  // widget content still work normally.
  const handlePanelPointerDown = (e: React.PointerEvent) => {
    if (isExpanded) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, select, [data-no-drag]')) return;
    dragControls.start(e);
  };

  return (
    <motion.div
      drag={!isExpanded} // Disable drag when expanded
      dragControls={dragControls}
      dragMomentum={!isExpanded}
      dragElastic={0.08}
      dragTransition={{ power: 0.35, timeConstant: 200, modifyTarget: (t) => t }}
      dragConstraints={dragConstraints}
      dragListener={false} // Only drag via controls
      initial={{ x: initialX, y: initialY, opacity: 1, scale: 1 }}
      animate={isExpanded ? "expanded" : "minimized"}
      variants={variants}
      exit="exit"
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      onWheel={handleWheel}
      onPointerDown={handlePanelPointerDown}
      onDragStart={() => {
        isDraggingRef.current = true;
        dragStartPos.current = { x: initialX, y: initialY };
      }}
      onDragEnd={(_event, info) => {
        // Momentum keeps the widget moving after release (the "throw"); Framer
        // settles that animation itself via dragTransition. We only need the
        // immediate release point to commit to layout state and to snap.
        if (onPositionChange) {
          const rawX = dragStartPos.current.x + info.offset.x;
          const rawY = dragStartPos.current.y + info.offset.y;
          const w = typeof width === 'number' ? width : 300;
          const h = typeof height === 'number' ? height : 200;
          const snapped = snapFn ? snapFn(rawX, rawY, w, h) : { x: rawX, y: rawY };
          dragStartPos.current = snapped;
          onPositionChange(id, snapped.x, snapped.y);
        }
        // Small timeout to prevent click from firing immediately after drag
        setTimeout(() => { isDraggingRef.current = false; }, 100);
      }}
      onClick={(e) => {
        if (isDraggingRef.current || isExpanded || !onToggleExpand) return;
        // Clicks that land on a control belong to the widget, not to the
        // window chrome: typing in a compact chat widget shouldn't force it
        // open. Anything marked data-no-drag is interactive content too.
        const target = e.target as HTMLElement | null;
        if (target?.closest('input, textarea, select, button, a, [contenteditable="true"], [data-no-drag]')) {
          return;
        }
        onToggleExpand(id);
      }}
      className={cn(
        "absolute flex flex-col pointer-events-auto",
        !isExpanded && "cursor-pointer", // Show pointer when minimized to indicate clickability
        className
      )}
    >
      {/* Main Container with Clipped Corners */}
      <div 
        className={cn(
          "relative w-full h-full bg-black/80 backdrop-blur-md border border-cyan-500/30 overflow-hidden group transition-colors duration-300",
          isExpanded && "expanded"
        )}
        style={{
          clipPath: 'polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 20px 100%, 0 calc(100% - 20px))',
          boxShadow: isExpanded
            ? '0 0 50px rgba(var(--accent-rgb), 0.3)'
            : '0 0 15px rgba(var(--accent-rgb), 0.15)'
        }}
      >
        {/* ── Scan-reveal: hidden until scanReady, then sweeps top-to-bottom ── */}
        <motion.div
          className="absolute inset-0 z-10"
          animate={{ clipPath: scanActive ? 'inset(0 0 0% 0)' : 'inset(0 0 100% 0)' }}
          transition={scanActive && !scanned
            ? { duration: SCAN_DURATION, ease: 'linear', delay: scanDelay.current }
            : { duration: 0 }}
          onAnimationComplete={() => { if (scanActive) setScanned(true); }}
        >
          {/* Decorative Corner Lines */}
          <div className="absolute top-0 right-0 w-[20px] h-[1px] bg-cyan-400/80 origin-right rotate-45 translate-y-[10px] translate-x-[-4px]" />
          <div className="absolute bottom-0 left-0 w-[20px] h-[1px] bg-cyan-400/80 origin-left rotate-45 translate-y-[-10px] translate-x-[4px]" />

          {/* Header / Drag Handle — dragging now works from anywhere on the
              panel (see handlePanelPointerDown), this bar just keeps the
              grab cursor as a visual affordance and stops the click here
              from toggling expand. */}
          <div
            className={cn(
              "h-8 bg-cyan-950/30 border-b border-cyan-500/20 flex items-center justify-between px-4 select-none transition-colors",
              !isExpanded ? "cursor-grab active:cursor-grabbing" : "cursor-default"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-xs font-bold tracking-widest text-white/80 uppercase truncate flex items-center gap-2">
              {title || 'MODULE'}
              {isExpanded && <span className="text-[10px] text-cyan-400/60">EXPANDED VIEW</span>}
            </span>
            <div className="flex items-center gap-3">
              {isExpanded && (
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleExpand && onToggleExpand(id); }}
                  className="text-cyan-500 hover:text-cyan-300 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
                  </svg>
                </button>
              )}
              {onDelete && !isExpanded && (
                <button
                  onClick={(e) => { e.stopPropagation(); sfx('app_close', 0.6); onDelete(id); }}
                  className="text-cyan-500/50 hover:text-red-400 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Content Area */}
          <div
            className={cn(
              embedContent
                ? 'h-[calc(100%-2rem)] min-h-0 overflow-hidden p-0'
                : 'h-[calc(100%-2rem)] overflow-y-auto overflow-x-hidden p-4 text-white/80 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent'
            )}
          >
            {children}
          </div>

          {/* Corner Accents */}
          <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-cyan-400" />
          <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-cyan-400" />

          {/* Resize Handle — generous hit area so it's easy to grab with a mouse or finger */}
          {!isExpanded && onResize && (
            <div
              data-no-drag
              className="absolute bottom-0 right-0 w-9 h-9 cursor-nwse-resize z-20 flex items-end justify-end p-1.5 touch-none"
              onPointerDown={handleResizeStart}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-3 h-3 border-r-2 border-b-2 border-cyan-500/60 hover:border-cyan-400 transition-colors" />
            </div>
          )}
        </motion.div>

        {/* ── Scan line — rides the leading edge of the reveal ── */}
        {scanActive && !scanned && (
          <motion.div
            className="absolute inset-x-0 pointer-events-none z-20"
            style={{
              height: 2,
              background: 'linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.5) 15%, rgba(34,211,238,1) 50%, rgba(34,211,238,0.5) 85%, transparent 100%)',
              boxShadow: '0 0 12px 5px rgba(34,211,238,0.35)',
            }}
            initial={{ top: 0 }}
            animate={{ top: '100%' }}
            transition={{ duration: SCAN_DURATION, ease: 'linear', delay: scanDelay.current }}
          />
        )}
      </div>
      
      {/* Outer Glow / Border visual fix for clip-path */}
      <div
        className="absolute inset-[-1px] -z-10 pointer-events-none opacity-50"
        style={{
          backgroundColor: 'rgba(var(--accent-rgb), 0.3)',
          clipPath: 'polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 20px 100%, 0 calc(100% - 20px))',
        }}
      />
    </motion.div>
  );
}
