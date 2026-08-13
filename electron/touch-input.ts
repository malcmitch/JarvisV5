/**
 * USB touch-screen support (ILITEK IR touch film / frame).
 *
 * macOS enumerates these panels as HID digitizers but has no native
 * touchscreen concept, so the touch reports are simply discarded by the OS.
 * This service opens the raw HID device, parses the multi-touch reports and
 * replays them into the Camille window as synthetic mouse events
 * (tap = click, touch-drag = click-drag). Nothing else about the app changes:
 * if no panel is plugged in, this service just idles.
 *
 * Requires the "Input Monitoring" permission on macOS (one-time grant in
 * System Settings → Privacy & Security). Open failures surface as a
 * permission notification instead of crashing.
 *
 * Report format (from the ILITEK HID report descriptor, report ID 4):
 *   byte 0            report ID (0x04)
 *   bytes 1..50       10 finger slots × 5 bytes:
 *                       [0]   bits 0-5 contact ID, bit 6 tip switch (finger down)
 *                       [1,2] X, little-endian, logical 0..16384
 *                       [3,4] Y, little-endian, logical 0..16384
 */

import { BrowserWindow, screen, shell } from 'electron';

const ILITEK_VENDOR_ID = 0x222a;
const TOUCH_USAGE_PAGE = 0x0d; // Digitizer
const TOUCH_USAGE = 0x04;      // Touch Screen
const REPORT_ID_TOUCH = 0x04;
const LOGICAL_MAX = 16384;
const FINGER_BYTES = 5;
const MAX_FINGERS = 10;
const POLL_MS = 2500;
/** Cap synthetic mouse-move rate; the panel reports up to 1000 Hz. */
const MOVE_THROTTLE_MS = 8;
/** Tap-vs-pinch disambiguation: hold mouseDown until the finger moves this
 *  far or this long, so a second finger can start a pinch without the first
 *  touch having committed any click. */
const TAP_SLOP_PX = 8;
const TAP_HOLD_MS = 120;
/** When a drag must be aborted because a pinch started, nudge the pointer
 *  before releasing so the up isn't within any click threshold. */
const PINCH_CANCEL_NUDGE_PX = 48;

export interface TouchInputStatus {
  connected: boolean;
  product?: string;
  /** macOS refused to open the device (Input Monitoring not granted). */
  permissionDenied?: boolean;
}

interface HidDeviceInfo {
  vendorId: number;
  productId: number;
  path?: string;
  product?: string;
  usagePage?: number;
  usage?: number;
}

interface HidDevice {
  on(event: 'data', cb: (data: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  close(): void;
}

interface NodeHidModule {
  devices(): HidDeviceInfo[];
  HID: new (path: string) => HidDevice;
}

function loadNodeHid(): NodeHidModule | null {
  try {
    // Lazy + guarded: a missing/unbuilt native module must never take down
    // the whole app — touch support silently becomes unavailable instead.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node-hid') as NodeHidModule;
  } catch (err) {
    console.error('[touch] node-hid unavailable, touch-screen support disabled:', err);
    return null;
  }
}

export class TouchInputService {
  status: TouchInputStatus = { connected: false };

  private hid: NodeHidModule | null = null;
  private device: HidDevice | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private permissionNotified = false;
  private loggedUnknownReports = 0;

  /** Injection state for the primary (first-down) finger */
  private down = false;
  private activeContactId = -1;
  private lastX = 0;
  private lastY = 0;
  private lastMoveAt = 0;
  /** First touch waiting to be classified as tap, drag, or pinch */
  private pending: { x: number; y: number; id: number; at: number } | null = null;

  /** Two-finger pinch state (translated into mouseWheel zoom events) */
  private pinchActive = false;
  private pinchLastDist = 0;
  /** After a pinch, ignore leftover fingers until the panel is clear */
  private waitForClear = false;

  constructor(
    private getWindow: () => BrowserWindow | null,
    private onStatus: (status: TouchInputStatus) => void,
  ) {}

  start(): void {
    this.hid = loadNodeHid();
    if (!this.hid) return;
    this.stopped = false;
    this.tryConnect();
    this.pollTimer = setInterval(() => this.tryConnect(), POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.closeDevice(false);
  }

  private setStatus(next: TouchInputStatus): void {
    const changed =
      next.connected !== this.status.connected ||
      !!next.permissionDenied !== !!this.status.permissionDenied;
    this.status = next;
    if (changed) this.onStatus(next);
  }

  private findPanel(): HidDeviceInfo | null {
    try {
      const all = this.hid!.devices();
      return (
        all.find(
          (d) =>
            d.vendorId === ILITEK_VENDOR_ID &&
            d.usagePage === TOUCH_USAGE_PAGE &&
            d.usage === TOUCH_USAGE &&
            !!d.path,
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private tryConnect(): void {
    if (this.stopped || this.device) return;
    const info = this.findPanel();
    if (!info) {
      // Panel unplugged while we were in the permission-denied state
      if (this.status.permissionDenied) this.setStatus({ connected: false });
      return;
    }

    try {
      const device = new this.hid!.HID(info.path!);
      this.device = device;
      device.on('data', (data) => this.handleReport(data));
      device.on('error', () => {
        // Fires when the USB cable is pulled mid-session
        this.closeDevice(true);
      });
      console.log(`[touch] Connected: ${info.product ?? 'touch panel'} (${info.path})`);
      this.setStatus({ connected: true, product: info.product });
    } catch (err) {
      this.device = null;
      const message = err instanceof Error ? err.message : String(err);
      const denied = /not permitted|privilege/i.test(message);
      console.error('[touch] Failed to open touch panel:', message);
      this.setStatus({ connected: false, product: info.product, permissionDenied: denied });
      if (denied && !this.permissionNotified && process.platform === 'darwin') {
        this.permissionNotified = true;
        // Opening the device adds the app to the Input Monitoring list; take
        // the user straight to the pane so they can flip the switch.
        shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
        );
      }
      // Keep polling — once permission is granted the next open succeeds.
    }
  }

  private closeDevice(notify: boolean): void {
    if (this.device) {
      try {
        this.device.close();
      } catch {
        /* already gone */
      }
      this.device = null;
    }
    this.pending = null;
    this.pinchActive = false;
    this.waitForClear = false;
    this.releaseIfDown();
    if (notify) {
      console.log('[touch] Touch panel disconnected.');
      this.setStatus({ connected: false });
    }
  }

  // ---------------------------------------------------------------- parsing

  private handleReport(data: Buffer): void {
    if (data.length < 1 + FINGER_BYTES) return;
    if (data[0] !== REPORT_ID_TOUCH) {
      if (this.loggedUnknownReports < 5) {
        this.loggedUnknownReports++;
        console.log(`[touch] Ignoring report ID 0x${data[0].toString(16)} (${data.length} bytes)`);
      }
      return;
    }

    const fingers: { id: number; x: number; y: number }[] = [];
    const count = Math.min(MAX_FINGERS, Math.floor((data.length - 1) / FINGER_BYTES));
    for (let i = 0; i < count; i++) {
      const off = 1 + i * FINGER_BYTES;
      const header = data[off];
      const tip = (header >> 6) & 0x01;
      if (!tip) continue;
      fingers.push({
        id: header & 0x3f,
        x: data.readUInt16LE(off + 1),
        y: data.readUInt16LE(off + 3),
      });
    }

    // Two or more fingers → pinch-to-zoom gesture
    if (fingers.length >= 2) {
      this.handlePinch(fingers[0], fingers[1]);
      return;
    }

    if (this.pinchActive) {
      // Pinch just ended; ignore the remaining finger until the panel clears
      this.pinchActive = false;
      this.waitForClear = true;
    }

    if (fingers.length === 0) {
      this.waitForClear = false;
      // A touch that never exceeded the tap threshold commits as a click now
      if (this.pending) this.commitTap();
      this.releaseIfDown();
      return;
    }
    if (this.waitForClear) return;

    // Single finger: keep tracking the same physical contact for the gesture
    const touch = this.down
      ? fingers.find((f) => f.id === this.activeContactId) ?? null
      : fingers[0];

    if (touch) {
      this.injectTouch(touch.id, touch.x / LOGICAL_MAX, touch.y / LOGICAL_MAX);
    } else {
      // Our finger lifted
      this.releaseIfDown();
    }
  }

  /** Quick touch-and-lift: replay it as a full click at the touch point. */
  private commitTap(): void {
    const p = this.pending!;
    this.pending = null;
    const win = this.targetWindow();
    if (!win) return;
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }

  /**
   * A pinch interrupts an already-committed drag: nudge the pointer away
   * before releasing so no click handler (which checks press-to-release
   * travel) can interpret the release as a tap on whatever was pressed.
   */
  private cancelDragForPinch(win: BrowserWindow): void {
    if (!this.down) return;
    this.down = false;
    this.activeContactId = -1;
    const cb = win.getContentBounds();
    const x = Math.max(0, Math.min(cb.width - 1, this.lastX + PINCH_CANCEL_NUDGE_PX));
    const y = Math.max(0, Math.min(cb.height - 1, this.lastY + PINCH_CANCEL_NUDGE_PX));
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers: ['leftbuttondown'] });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * Translates a two-finger pinch into mouseWheel events at the gesture's
   * midpoint: fingers apart = wheel up (zoom in), together = wheel down.
   * Pages that don't zoom just see normal two-finger scrolling.
   */
  private handlePinch(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const win = this.targetWindow();
    if (!win) return;
    // A first touch that was still pending simply never happened — this is
    // what lets two fingers land on a model without clicking it
    this.pending = null;
    // A drag can't continue once the second finger lands
    this.cancelDragForPinch(win);

    const display = screen.getDisplayMatching(win.getBounds()).bounds;
    const dist = Math.hypot(
      ((b.x - a.x) / LOGICAL_MAX) * display.width,
      ((b.y - a.y) / LOGICAL_MAX) * display.height,
    );

    if (!this.pinchActive) {
      this.pinchActive = true;
      this.pinchLastDist = dist;
      return;
    }

    const delta = dist - this.pinchLastDist;
    if (Math.abs(delta) < 2) return; // jitter
    this.pinchLastDist = dist;

    const mid = this.toWindowPoint(win, (a.x + b.x) / 2 / LOGICAL_MAX, (a.y + b.y) / 2 / LOGICAL_MAX);
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: mid.x,
      y: mid.y,
      deltaX: 0,
      deltaY: Math.round(-delta),
      canScroll: true,
    });
  }

  // -------------------------------------------------------------- injection

  /** Maps panel-normalized coords onto the display the window lives on. */
  private toWindowPoint(win: BrowserWindow, nx: number, ny: number): { x: number; y: number; inside: boolean } {
    const display = screen.getDisplayMatching(win.getBounds());
    const dx = display.bounds.x + nx * display.bounds.width;
    const dy = display.bounds.y + ny * display.bounds.height;
    const cb = win.getContentBounds();
    const x = Math.round(dx - cb.x);
    const y = Math.round(dy - cb.y);
    const inside = x >= 0 && y >= 0 && x < cb.width && y < cb.height;
    return {
      x: Math.max(0, Math.min(cb.width - 1, x)),
      y: Math.max(0, Math.min(cb.height - 1, y)),
      inside,
    };
  }

  private targetWindow(): BrowserWindow | null {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null;
    return win;
  }

  private injectTouch(contactId: number, nx: number, ny: number): void {
    const win = this.targetWindow();
    if (!win) {
      this.pending = null;
      this.releaseIfDown();
      return;
    }
    const pt = this.toWindowPoint(win, nx, ny);

    if (!this.down) {
      // Buffer the first touch: commit the mouseDown only once it's clearly
      // a drag (moved past slop or held), so a second finger can still turn
      // the gesture into a pinch without any click having been sent.
      if (!this.pending || this.pending.id !== contactId) {
        if (!pt.inside) return;
        this.pending = { x: pt.x, y: pt.y, id: contactId, at: Date.now() };
        return;
      }
      const moved = Math.hypot(pt.x - this.pending.x, pt.y - this.pending.y);
      const held = Date.now() - this.pending.at;
      if (moved < TAP_SLOP_PX && held < TAP_HOLD_MS) return;

      const start = this.pending;
      this.pending = null;
      this.down = true;
      this.activeContactId = contactId;
      this.lastX = start.x;
      this.lastY = start.y;
      this.lastMoveAt = 0;
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: start.x,
        y: start.y,
        button: 'left',
        clickCount: 1,
      });
      // Fall through so a movement-triggered commit immediately reports the
      // finger's current position too.
    }

    // Drag in progress — clamp to window edges and throttle the move rate
    const now = Date.now();
    if (now - this.lastMoveAt < MOVE_THROTTLE_MS) return;
    if (pt.x === this.lastX && pt.y === this.lastY) return;
    this.lastMoveAt = now;
    this.lastX = pt.x;
    this.lastY = pt.y;
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: pt.x,
      y: pt.y,
      modifiers: ['leftbuttondown'],
    });
  }

  private releaseIfDown(): void {
    if (!this.down) return;
    this.down = false;
    this.activeContactId = -1;
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: this.lastX,
        y: this.lastY,
        button: 'left',
        clickCount: 1,
      });
    }
  }
}
