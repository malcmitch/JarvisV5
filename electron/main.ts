import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  session,
  screen,
  systemPreferences,
  dialog,
  protocol,
  desktopCapturer,
} from 'electron';
import path from 'path';
import http from 'http';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import os, { networkInterfaces } from 'os';
import { WakeWordService } from './wake-word';
import { TouchInputService, TouchInputStatus } from './touch-input';
import { SocialViewsService, SocialPlatformId, SocialBounds } from './social-views';
import { handleDeepLink, registerAuthIpc, restoreSession } from './auth';
import { startAiProxy, stopAiProxy } from './ai-proxy';
import { startSelfUpdate } from './self-update';

const isDev = !app.isPackaged;
const PORT = 3000;
const HTTPS_PORT = 3443;

// Global safety net: ECONNRESET / EPIPE are harmless connection-level errors
// that happen when a phone/tablet disconnects mid-request (iOS tab kill, screen
// lock, navigation). Without this handler they surface as an uncaught exception
// and crash the entire Electron main process, which restarts the app and reloads
// every connected client. We swallow them here; all other errors are re-thrown.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
    console.warn('[jarvis] Swallowed uncaught', err.code, '— client disconnected mid-request.');
    return;
  }
  throw err;
});
process.on('unhandledRejection', (reason) => {
  const code = (reason as NodeJS.ErrnoException)?.code;
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    console.warn('[jarvis] Swallowed unhandledRejection', code);
    return;
  }
  console.error('[jarvis] Unhandled rejection:', reason);
});

/** Lets the Next.js UI load local PDFs from absolute paths inside an iframe. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'jarvis-pdf',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function registerJarvisPdfProtocol() {
  protocol.registerFileProtocol('jarvis-pdf', (request, callback) => {
    try {
      const marker = 'jarvis-pdf://';
      if (!request.url.startsWith(marker)) {
        callback({ error: -2 });
        return;
      }
      let encoded = request.url.slice(marker.length);
      while (encoded.startsWith('/')) encoded = encoded.slice(1);
      const filePath = path.normalize(decodeURIComponent(encoded));
      if (!filePath.toLowerCase().endsWith('.pdf')) {
        callback({ error: -6 });
        return;
      }
      if (!fs.existsSync(filePath)) {
        callback({ error: -6 });
        return;
      }
      callback({ path: filePath });
    } catch {
      callback({ error: -2 });
    }
  });
}

// Set Dock icon in dev mode (packaged builds use electron-builder.yml icon)
if (isDev && process.platform === 'darwin' && app.dock) {
  app.dock.setIcon(path.join(__dirname, '..', 'buildfiles', 'icon.png'));
}

// ─────────────────────────── jarvis:// sign-in deep links ───────────────────
//
// The website finishes sign-in by opening jarvis://auth?code=…, which the OS
// routes to this app. macOS delivers it to the running instance as 'open-url';
// Windows and Linux instead launch a *second* copy with the URL in argv, so the
// lock below is what turns that into a message to the instance already running.
// It also stops two copies fighting over port 3000.

// A link can arrive before the window exists — on Windows and Linux it is in the
// argv of the very launch that starts the app. Hold it until there is something
// to show the result in.
let queuedDeepLink: string | null = null;

if (isDev) {
  // In development the executable is Electron itself, so the scheme has to point
  // at this project rather than at the binary.
  app.setAsDefaultProtocolClient('jarvis', process.execPath, [path.resolve(process.argv[1] ?? '.')]);
} else {
  app.setAsDefaultProtocolClient('jarvis');
}

function findDeepLink(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith('jarvis://')) ?? null;
}

function deliverDeepLink(url: string | null) {
  if (!url) return;
  if (!appReady) {
    queuedDeepLink = url;
    return;
  }
  void handleDeepLink(url);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    deliverDeepLink(findDeepLink(argv));
  });

  // macOS. Registered outside whenReady because a cold launch triggered by the
  // link itself fires this before the app is ready.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });

  queuedDeepLink = findDeepLink(process.argv);
}

let mainWindow: BrowserWindow | null = null;
let desktopVisualWindow: BrowserWindow | null = null;
let desktopHitboxWindow: BrowserWindow | null = null;
let nextServer: ChildProcess | null = null;
/** Points the Next server at the loopback AI bridge. Empty if it failed to start. */
let aiProxyEnv: Record<string, string> = {};
let wakeWordService: WakeWordService | null = null;
let touchInputService: TouchInputService | null = null;
let socialViewsService: SocialViewsService | null = null;
// Set to true only after the Next.js server is confirmed ready and the first
// window has been created. Guards activate/reopen handlers from firing early.
let appReady = false;
let desktopModeEnabled = false;
let normalWindowBounds: Electron.Rectangle | null = null;
let desktopPanelPosition: DesktopPanelPosition = 'bottom-right';

type DesktopPanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface DesktopModeOptions {
  enabled: boolean;
  position?: DesktopPanelPosition;
  logo?: 'logo' | 'logo2';
  muted?: boolean;
}

const DESKTOP_VISUAL_SIZE = 184;
const DESKTOP_PANEL_MARGIN = 24;
const DESKTOP_LOGO_HITBOX_SIZE = 104;

function getDesktopDisplay() {
  const existingWindow = desktopVisualWindow ?? desktopHitboxWindow;
  return existingWindow
    ? screen.getDisplayMatching(existingWindow.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function getVisualBounds(position: DesktopPanelPosition): Electron.Rectangle {
  const area = getDesktopDisplay().workArea;
  const x =
    position === 'top-left' || position === 'bottom-left'
      ? area.x + DESKTOP_PANEL_MARGIN
      : area.x + area.width - DESKTOP_VISUAL_SIZE - DESKTOP_PANEL_MARGIN;
  const y =
    position === 'top-left' || position === 'top-right'
      ? area.y + DESKTOP_PANEL_MARGIN
      : area.y + area.height - DESKTOP_VISUAL_SIZE - DESKTOP_PANEL_MARGIN;

  return { x, y, width: DESKTOP_VISUAL_SIZE, height: DESKTOP_VISUAL_SIZE };
}

function getHitboxBounds(position: DesktopPanelPosition): Electron.Rectangle {
  const visual = getVisualBounds(position);
  const offset = Math.round((DESKTOP_VISUAL_SIZE - DESKTOP_LOGO_HITBOX_SIZE) / 2);
  return {
    x: visual.x + offset,
    y: visual.y + offset,
    width: DESKTOP_LOGO_HITBOX_SIZE,
    height: DESKTOP_LOGO_HITBOX_SIZE,
  };
}

function createDesktopWindow(kind: 'visual' | 'hitbox') {
  const win = new BrowserWindow({
    ...(kind === 'visual'
      ? getVisualBounds(desktopPanelPosition)
      : getHitboxBounds(desktopPanelPosition)),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: kind === 'visual' ? 'Camille Desktop Visual' : 'Camille Desktop Hitbox',
    icon: path.join(__dirname, '..', 'buildfiles', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return win;
}

function getCircularHitboxRects(): Electron.Rectangle[] {
  const rects: Electron.Rectangle[] = [];
  const radius = DESKTOP_LOGO_HITBOX_SIZE / 2;
  const step = 4;

  for (let y = 0; y < DESKTOP_LOGO_HITBOX_SIZE; y += step) {
    const yFromCenter = y + step / 2 - radius;
    const halfWidth = Math.sqrt(Math.max(0, radius * radius - yFromCenter * yFromCenter));
    rects.push({
      x: Math.round(radius - halfWidth),
      y,
      width: Math.round(halfWidth * 2),
      height: step,
    });
  }

  return rects;
}

function applyDesktopHitbox(win: BrowserWindow) {
  if (process.platform !== 'darwin' && typeof win.setShape === 'function') {
    win.setShape(getCircularHitboxRects());
  }

  if (process.platform === 'darwin') {
    win.setIgnoreMouseEvents(true, { forward: true });
  }
}

function hitboxHtml(muted = false) {
  return encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:;" />
    <style>
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }
      body {
        display: grid;
        place-items: center;
        user-select: none;
        -webkit-user-select: none;
      }
      button {
        width: ${DESKTOP_LOGO_HITBOX_SIZE}px;
        height: ${DESKTOP_LOGO_HITBOX_SIZE}px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: transparent;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <button id="hitbox" aria-label="${muted ? 'Unmute Camille' : 'Mute Camille'}"></button>
    <script>
      const button = document.getElementById('hitbox');
      let passthrough = true;
      const setPassthrough = (next) => {
        if (next === passthrough) return;
        passthrough = next;
        window.electron?.setDesktopPanelMousePassthrough?.(next);
      };
      if (navigator.platform.toLowerCase().includes('mac')) {
        window.electron?.setDesktopPanelMousePassthrough?.(true);
        window.addEventListener('mousemove', (event) => {
          const rect = button.getBoundingClientRect();
          const x = event.clientX - (rect.left + rect.width / 2);
          const y = event.clientY - (rect.top + rect.height / 2);
          setPassthrough(Math.hypot(x, y) > rect.width * 0.49);
        });
        window.addEventListener('mouseleave', () => setPassthrough(true));
      }
      button.addEventListener('click', () => window.electron?.overlayClick?.());
      window.electron?.onDesktopPanelMuted?.((muted) => {
        button.setAttribute('aria-label', muted ? 'Unmute Camille' : 'Mute Camille');
      });
    </script>
  </body>
</html>`);
}

function loadDesktopContent(logo?: 'logo' | 'logo2', muted?: boolean) {
  const params = new URLSearchParams({
    logo: logo ?? 'logo',
    muted: muted ? '1' : '0',
  });
  desktopVisualWindow?.loadURL(`http://127.0.0.1:${PORT}/desktop-overlay?${params.toString()}`);
  desktopHitboxWindow?.loadURL(`data:text/html;charset=utf-8,${hitboxHtml(muted)}`);
}

function createDesktopOverlay(logo?: 'logo' | 'logo2', muted?: boolean) {
  if (!desktopVisualWindow) {
    desktopVisualWindow = createDesktopWindow('visual');
    desktopVisualWindow.setIgnoreMouseEvents(true, { forward: true });
    desktopVisualWindow.on('closed', () => {
      desktopVisualWindow = null;
    });
  }

  if (!desktopHitboxWindow) {
    desktopHitboxWindow = createDesktopWindow('hitbox');
    applyDesktopHitbox(desktopHitboxWindow);
    desktopHitboxWindow.on('closed', () => {
      desktopHitboxWindow = null;
    });
  }

  loadDesktopContent(logo, muted);

  desktopVisualWindow.once('ready-to-show', () => {
    desktopVisualWindow?.showInactive();
  });
  desktopHitboxWindow.once('ready-to-show', () => {
    desktopHitboxWindow?.showInactive();
    desktopHitboxWindow?.moveTop();
  });

  return { visual: desktopVisualWindow, hitbox: desktopHitboxWindow };
}

function setDesktopOverlayBounds(position: DesktopPanelPosition) {
  desktopVisualWindow?.setBounds(getVisualBounds(position));
  desktopHitboxWindow?.setBounds(getHitboxBounds(position));
  if (desktopHitboxWindow) applyDesktopHitbox(desktopHitboxWindow);
}

function animateWindowTo(win: BrowserWindow, to: Electron.Rectangle) {
  const from = win.getBounds();
  const startedAt = Date.now();
  const duration = 320;

  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(timer);
      return;
    }

    const t = Math.min(1, (Date.now() - startedAt) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    win.setBounds({
      x: Math.round(from.x + (to.x - from.x) * eased),
      y: Math.round(from.y + (to.y - from.y) * eased),
      width: to.width,
      height: to.height,
    });
    if (t >= 1) clearInterval(timer);
  }, 16);
}

function animateDesktopOverlayTo(position: DesktopPanelPosition) {
  desktopPanelPosition = position;
  if (desktopVisualWindow) animateWindowTo(desktopVisualWindow, getVisualBounds(position));
  if (desktopHitboxWindow) animateWindowTo(desktopHitboxWindow, getHitboxBounds(position));
}

function closeDesktopOverlay() {
  desktopVisualWindow?.close();
  desktopVisualWindow = null;
  desktopHitboxWindow?.close();
  desktopHitboxWindow = null;
}

function setDesktopMode(options: DesktopModeOptions) {
  if (!mainWindow) return { success: false, error: 'Main window is not ready.' };

  if (options.position) desktopPanelPosition = options.position;

  if (options.enabled) {
    if (!desktopModeEnabled) {
      normalWindowBounds = mainWindow.getBounds();
    }
    desktopModeEnabled = true;
    mainWindow.hide();
    const overlay = createDesktopOverlay(options.logo, options.muted);
    setDesktopOverlayBounds(desktopPanelPosition);
    overlay.visual.setAlwaysOnTop(true, 'screen-saver');
    overlay.hitbox.setAlwaysOnTop(true, 'screen-saver');
    overlay.visual.showInactive();
    overlay.hitbox.showInactive();
    overlay.hitbox.moveTop();
    return { success: true, enabled: true, position: desktopPanelPosition };
  }

  desktopModeEnabled = false;
  closeDesktopOverlay();

  if (normalWindowBounds) {
    mainWindow.setBounds(normalWindowBounds);
  }
  mainWindow.show();
  mainWindow.focus();
  return { success: true, enabled: false };
}

function setupDesktopModeIpc() {
  ipcMain.handle('desktop-mode:set', (_event, options: DesktopModeOptions) => {
    return setDesktopMode(options);
  });

  ipcMain.handle('desktop-mode:move', (_event, position: DesktopPanelPosition) => {
    desktopPanelPosition = position;
    animateDesktopOverlayTo(position);
    return { success: true, position };
  });

  ipcMain.on('desktop-mode:overlay-clicked', () => {
    mainWindow?.webContents.send('desktop-mode:overlay-click');
  });

  ipcMain.on('desktop-mode:muted', (_event, muted: boolean) => {
    desktopVisualWindow?.webContents.send('desktop-mode:muted', muted);
    desktopHitboxWindow?.webContents.send('desktop-mode:muted', muted);
  });

  ipcMain.on('desktop-mode:mouse-passthrough', (_event, passthrough: boolean) => {
    if (process.platform !== 'darwin') return;
    desktopHitboxWindow?.setIgnoreMouseEvents(passthrough, { forward: true });
  });

  ipcMain.handle('get-audio-source-id', async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      return sources[0]?.id ?? null;
    } catch {
      return null;
    }
  });
}

function waitForServer(retries = 40, delay = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      const req = http.get(`http://127.0.0.1:${PORT}`, () => {
        req.destroy();
        resolve();
      });
      req.on('error', () => {
        if (n >= retries) {
          reject(new Error(`Next.js server did not start after ${retries} attempts`));
        } else {
          setTimeout(() => attempt(n + 1), delay);
        }
      });
      req.end();
    };
    attempt(0);
  });
}

/**
 * Kill anything already listening on our port before starting the server.
 *
 * A previous instance's Next server rewrites its process title to
 * "next-server", so name-based kills (pkill -f Camille) miss it. A stale
 * server squatting on the port serves OLD code while the new spawn dies
 * with EADDRINUSE — and waitForServer happily accepts the impostor's
 * answers. Kill by port: it cannot be fooled by a renamed process.
 */
function clearStaleServerOnPort(): void {
  if (process.platform === 'win32') return; // lsof path is POSIX-only
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('child_process') as typeof import('child_process');
    const pids = execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 5000,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s) && Number(s) !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (pids.length > 0) {
      console.warn(`[camille] cleared ${pids.length} stale server(s) on port ${PORT}`);
    }
  } catch {
    // lsof missing or timed out — proceed; EADDRINUSE will surface if real.
  }
}

function startNextServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    clearStaleServerOnPort();
    const appDir = path.join(process.resourcesPath, 'app');
    const serverPath = path.join(appDir, 'server.js');

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        nextServer?.kill();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    // utilityProcess is flaky on some Windows installs; run Node via Electron's binary.
    nextServer = spawn(process.execPath, [serverPath], {
      cwd: appDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(PORT),
        HOSTNAME: '127.0.0.1',
        NODE_ENV: 'production',
        NEXT_MANUAL_SIG_HANDLE: 'true',
        // Per-user writable location for runtime secrets (Bambu token, server
        // settings). Without this the server writes them next to server.js —
        // i.e. inside the (shared, read-only, distributable) app bundle — which
        // leaks the packager's credentials to everyone who installs the app.
        JARVIS_DATA_DIR: app.getPath('userData'),
        // The PyInstaller binaries live in Resources/scripts (extraResources),
        // outside the server's cwd. Point the server at that single copy so we
        // don't have to ship a second ~85 MB duplicate inside Resources/app.
        JARVIS_SCRIPTS_DIR: path.join(process.resourcesPath, 'scripts'),
        // Where the route handlers reach paid AI services. No API key is passed
        // here on purpose — the bridge attaches the signed-in user's token per
        // request, so a leaked child environment buys nobody anything after the
        // app closes.
        ...aiProxyEnv,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    nextServer.stdout?.on('data', (chunk) => {
      if (isDev) console.log('[next]', chunk.toString());
    });
    nextServer.stderr?.on('data', (chunk) => {
      console.error('[next]', chunk.toString());
    });

    nextServer.on('error', (err) => fail(err));

    nextServer.on('exit', (code) => {
      if (settled) return;
      const crashed = typeof code === 'number' ? code !== 0 : true;
      if (crashed) {
        fail(
          new Error(
            `Next.js server exited unexpectedly (code: ${String(code)}). If the app never loaded, check Windows Firewall / antivirus for localhost:${PORT} — or run the installer from a local folder (not a network drive).`
          )
        );
      }
    });

    waitForServer()
      .then(() => {
        if (settled) return;
        settled = true;
        resolve();
      })
      .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

async function requestMediaPermissions() {
  if (process.platform !== 'darwin') return;
  try {
    await systemPreferences.askForMediaAccess('microphone');
    await systemPreferences.askForMediaAccess('camera');
  } catch {
    // Permissions may already be granted or unavailable in sandbox
  }
}

function requestAccessibilityAndScreenRecording() {
  if (process.platform !== 'darwin') return;

  // Screen recording — triggers the system prompt the first time.
  // The app needs this for the computer-use screenshot feature (mss).
  const screenStatus = systemPreferences.getMediaAccessStatus('screen');
  if (screenStatus !== 'granted') {
    // Open System Settings directly to the Screen Recording pane so the
    // user can add Camille without hunting through menus.
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  }

  // Accessibility — needed by pyautogui for mouse/keyboard control.
  // isTrustedAccessibilityClient(true) shows the system prompt requesting trust.
  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (!trusted) {
    systemPreferences.isTrustedAccessibilityClient(true);
    // Also open System Settings as a fallback in case the prompt is missed.
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    );
  }
}

function getLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

let httpsServer: https.Server | null = null;

async function startHttpsProxy(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const selfsigned = require('selfsigned') as typeof import('selfsigned');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const httpProxy  = require('http-proxy')  as typeof import('http-proxy');

    const certPath = path.join(app.getPath('userData'), 'jarvis-tls.json');
    let pems: { private: string; cert: string };

    // Reuse cached cert so browsers only need to accept it once
    if (fs.existsSync(certPath)) {
      pems = JSON.parse(fs.readFileSync(certPath, 'utf-8')) as { private: string; cert: string };
    } else {
      const generated = await (selfsigned.generate as (attrs: unknown[], opts: unknown) => Promise<{ private: string; cert: string }>)(
        [{ name: 'commonName', value: 'jarvis.local' }],
        { days: 3650 }
      );
      pems = generated;
      fs.writeFileSync(certPath, JSON.stringify(pems));
    }

    const proxy = httpProxy.createProxyServer({
      target: `http://127.0.0.1:${PORT}`,
      ws: true,
      changeOrigin: true,
    });

    // Swallow all proxy-level errors (ECONNRESET, ECONNREFUSED, etc.)
    proxy.on('error', (err: NodeJS.ErrnoException, _req, res) => {
      const code = err.code ?? '';
      if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') return;
      console.error('[jarvis] Proxy error:', err.message);
      // Try to send a 502 if the response is still writable
      try {
        if (res && 'writeHead' in res && typeof (res as import('http').ServerResponse).writeHead === 'function') {
          (res as import('http').ServerResponse).writeHead(502);
          (res as import('http').ServerResponse).end();
        }
      } catch { /* already sent */ }
    });

    httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
      proxy.web(req, res);
    });

    // Handle socket-level errors on every incoming TLS connection.
    // When a phone disconnects mid-request (iOS tab kill, screen lock, navigation)
    // the TLS socket throws ECONNRESET. Without this handler it reaches Node.js as
    // an uncaught exception and crashes the entire Electron main process.
    httpsServer.on('connection', (socket) => {
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
        console.error('[jarvis] HTTPS socket error:', err.message);
      });
    });

    httpsServer.on('upgrade', (req, socket, head) => {
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
        console.error('[jarvis] HTTPS upgrade socket error:', err.message);
      });

      // Intercept Next.js HMR WebSocket upgrades and silently accept them
      // without forwarding to the dev server. LAN clients (phones/tablets)
      // can't establish a real WSS connection over the self-signed cert, so
      // the HMR socket fails repeatedly → Next.js calls location.reload().
      // By completing the WebSocket handshake ourselves and keeping the socket
      // open-but-silent, Next.js thinks it's connected and stops retrying.
      // No HMR messages are ever sent, so no reloads ever fire.
      if (req.url && (req.url.includes('webpack-hmr') || req.url.includes('_next/webpack'))) {
        const key = req.headers['sec-websocket-key'];
        if (key) {
          const accept = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          // Keep the socket alive but never send any HMR frames.
          socket.on('data', () => { /* ignore pings/frames from client */ });
        } else {
          socket.destroy();
        }
        return;
      }

      proxy.ws(req, socket, head);
    });

    httpsServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[jarvis] HTTPS proxy already running on port ${HTTPS_PORT}, skipping.`);
      } else {
        console.error('[jarvis] HTTPS server error:', err.message);
      }
    });
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      const ip = getLanIp();
      if (ip) console.log(`[jarvis] LAN HTTPS: https://${ip}:${HTTPS_PORT}`);
    });
  } catch (err) {
    console.error('[jarvis] HTTPS proxy failed to start:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Camille',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#00000000',
    transparent: true,
    show: false,
    icon: path.join(__dirname, '..', 'buildfiles', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      // Social Media dashboard embeds Instagram/TikTok/Facebook/YouTube
      // in Chromium <webview> guests with persistent login partitions.
      webviewTag: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeDesktopOverlay();
  });
}

function setupPermissions() {
  const isJarvisOrigin = (url: string) =>
    url.startsWith('http://127.0.0.1') ||
    url.startsWith('http://localhost') ||
    url.startsWith('https://127.0.0.1') ||
    url.startsWith('https://localhost');

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const url = webContents.getURL();
      if (
        isJarvisOrigin(url) &&
        ['media', 'microphone', 'camera', 'display-capture', 'speechRecognition', 'speech'].includes(permission)
      ) {
        callback(true);
        return;
      }
      callback(false);
    }
  );

  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => {
      if (!webContents) return false;
      const url = webContents.getURL();
      if (isJarvisOrigin(url) && ['media', 'microphone', 'camera', 'speechRecognition', 'speech'].includes(permission)) {
        return true;
      }
      return false;
    }
  );
}

app.whenReady().then(async () => {
  // Default BrowserWindow title is "Electron"; menu / Dock name in dev follows the binary unless set here.
  app.setName('Camille');

  registerJarvisPdfProtocol();
  setupPermissions();
  setupDesktopModeIpc();
  registerAuthIpc(() => mainWindow);
  await requestMediaPermissions();
  requestAccessibilityAndScreenRecording();

  // Must be listening before the Next server starts, because that server is
  // told where to find it at spawn time.
  try {
    aiProxyEnv = await startAiProxy();
  } catch (err) {
    console.error('Failed to start the AI bridge; AI features will be unavailable:', err);
  }

  if (isDev) {
    createWindow();
    startHttpsProxy();
  } else {
    try {
      await startNextServer();
      startHttpsProxy();
      createWindow();
    } catch (err) {
      console.error('Failed to start Next.js server:', err);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : JSON.stringify(err);
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'Camille — could not start',
        message:
          'The local web server did not start, so Camille cannot load its interface.',
        detail: message,
      });
      app.quit();
      return;
    }
  }

  appReady = true;

  // Unsigned build: electron-updater cannot install on macOS, so Camille
  // checks her own GitHub releases and swaps herself. No-op in dev.
  startSelfUpdate();

  // Sign back in from the remembered refresh token, then play out a link that
  // arrived while the app was still starting.
  await restoreSession();
  deliverDeepLink(queuedDeepLink);
  queuedDeepLink = null;

  wakeWordService = new WakeWordService();
  wakeWordService!.setCallbacks(
    () => {
      console.log('[WakeWord] Camille detected!');

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hey-jarvis:detected');
      }

      if (desktopModeEnabled) {
        mainWindow?.show();
        mainWindow?.focus();
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hey-jarvis:status', {
          enabled: wakeWordService!.enabled,
          listening: wakeWordService!.listening,
        });
      }
    },
    (error: string) => {
      console.error('[WakeWord] Error:', error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hey-jarvis:error', error);
      }
    }
  );

  // Wake word will be started by the renderer via IPC when settings load

  ipcMain.on('hey-jarvis:set-enabled', (_event, enabled: boolean) => {
    if (enabled) {
      wakeWordService!.start();
    } else {
      wakeWordService!.stop();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hey-jarvis:status', {
        enabled: wakeWordService!.enabled,
        listening: wakeWordService!.listening,
      });
    }
  });

  ipcMain.on('hey-jarvis:set-sensitivity', (_event, sensitivity: number) => {
    wakeWordService!.setSensitivity(sensitivity);
  });

  ipcMain.on('hey-jarvis:mic-in-use', (_event, inUse: boolean) => {
    wakeWordService!.setMicInUse(inUse);
  });

  // USB touch-screen (ILITEK IR film) — reads raw HID touch reports and
  // replays them into the window as clicks/drags. Idle when not plugged in.
  touchInputService = new TouchInputService(
    () => mainWindow,
    (status: TouchInputStatus) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('touch-input:status', status);
      }
    }
  );
  touchInputService.start();

  ipcMain.handle('touch-input:get-status', () => touchInputService?.status ?? { connected: false });

  // Transparent windows blank out guest views on macOS. Social Command flips
  // the main window opaque while open so the four WebContentsViews can paint.
  /**
   * Runs one shell command for the terminal widget.
   *
   * Exposed over IPC rather than as a Next route on purpose: Camille's dev
   * server and HTTPS proxy bind 0.0.0.0, and the proxy rewrites Host, so an
   * HTTP endpoint could not distinguish a LAN client from the local app. Only
   * the Electron renderer can reach ipcMain.
   *
   * Not a PTY — interactive programs won't work, which is a deliberate limit
   * rather than an oversight. cwd is supplied by the caller because every call
   * is a fresh process.
   */
  ipcMain.handle(
    'shell:run',
    async (_event, payload: { command?: string; cwd?: string; timeoutMs?: number }) => {
      const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
      if (!command) return { stdout: '', stderr: 'No command given.', exitCode: 1 };

      const requestedCwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : os.homedir();
      const timeout = Math.min(Math.max(payload?.timeoutMs ?? 30_000, 1_000), 120_000);
      const shellPath = process.env.SHELL || '/bin/zsh';

      return await new Promise((resolve) => {
        const child = spawn(shellPath, ['-lc', command], {
          cwd: requestedCwd,
          env: process.env,
          timeout,
        });

        // 256 KB is plenty for a HUD panel and stops `cat bigfile` from
        // pushing megabytes of text through IPC into React state.
        const LIMIT = 256 * 1024;
        let stdout = '';
        let stderr = '';
        let truncated = false;

        const append = (buf: Buffer, which: 'out' | 'err') => {
          const text = buf.toString();
          if (which === 'out') {
            if (stdout.length + text.length > LIMIT) { truncated = true; stdout = (stdout + text).slice(0, LIMIT); }
            else stdout += text;
          } else {
            if (stderr.length + text.length > LIMIT) { truncated = true; stderr = (stderr + text).slice(0, LIMIT); }
            else stderr += text;
          }
        };

        child.stdout?.on('data', (b: Buffer) => append(b, 'out'));
        child.stderr?.on('data', (b: Buffer) => append(b, 'err'));

        child.on('error', (err: Error) => {
          resolve({ stdout, stderr: `${stderr}${err.message}`, exitCode: 127, truncated });
        });

        child.on('close', (code: number | null, signal: string | null) => {
          resolve({
            stdout,
            stderr: signal === 'SIGTERM' && code === null
              ? `${stderr}\n[timed out after ${Math.round(timeout / 1000)}s]`
              : stderr,
            exitCode: code ?? 1,
            truncated,
          });
        });
      });
    },
  );

  ipcMain.handle('window:set-opaque', (_event, opaque: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    try {
      mainWindow.setBackgroundColor(opaque ? '#020814' : '#00000000');
      return { success: true, opaque: !!opaque };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'failed' };
    }
  });

  // Social Command — four WebContentsView browser panes over the main UI
  socialViewsService = new SocialViewsService(() => mainWindow);
  ipcMain.handle('social:start', () => socialViewsService!.start());
  ipcMain.handle('social:stop', () => socialViewsService!.stop());
  ipcMain.handle('social:set-bounds', (_e, all: Partial<Record<SocialPlatformId, SocialBounds>>) =>
    socialViewsService!.setAllBounds(all ?? {}));
  ipcMain.handle('social:navigate', (_e, id: SocialPlatformId, url: string) =>
    socialViewsService!.navigate(id, url));
  ipcMain.handle('social:navigate-all', (_e, url: string) =>
    socialViewsService!.navigateAll(url));
  ipcMain.handle('social:reload', (_e, id: SocialPlatformId) =>
    socialViewsService!.reload(id));
  ipcMain.handle('social:home', (_e, id: SocialPlatformId) =>
    socialViewsService!.goHome(id));
  ipcMain.handle('social:get-url', (_e, id: SocialPlatformId) =>
    socialViewsService!.getUrl(id));
  ipcMain.handle('social:capture-html', (_e, id: SocialPlatformId) =>
    socialViewsService!.captureHtml(id));
  ipcMain.handle('social:exec', (_e, id: SocialPlatformId, code: string) =>
    socialViewsService!.executeJavaScript(id, code));
  ipcMain.handle(
    'social:post-reply',
    (
      _e,
      id: SocialPlatformId,
      author: string,
      commentText: string,
      reply: string,
      options?: { typingMsPerChar?: number; typingJitterMs?: number },
    ) => socialViewsService!.postReply(id, author, commentText, reply, options),
  );
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    nextServer?.kill();
    app.quit();
  }
});

// On macOS, clicking the dock icon re-opens the window. Only allowed once
// the full startup sequence (server + first window) has completed.
app.on('activate', () => {
  if (!appReady) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  socialViewsService?.stop();
  wakeWordService?.stop();
  touchInputService?.stop();
  nextServer?.kill();
  httpsServer?.close();
  void stopAiProxy();
});
