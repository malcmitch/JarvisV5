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
} from 'electron';
import path from 'path';
import http from 'http';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

const isDev = !app.isPackaged;
const PORT = 3000;

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

let mainWindow: BrowserWindow | null = null;
let desktopVisualWindow: BrowserWindow | null = null;
let desktopHitboxWindow: BrowserWindow | null = null;
let nextServer: ChildProcess | null = null;
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
    title: kind === 'visual' ? 'Jarvis Desktop Visual' : 'Jarvis Desktop Hitbox',
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
    <button id="hitbox" aria-label="${muted ? 'Unmute Jarvis' : 'Mute Jarvis'}"></button>
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
        button.setAttribute('aria-label', muted ? 'Unmute Jarvis' : 'Mute Jarvis');
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

function startNextServer(): Promise<void> {
  return new Promise((resolve, reject) => {
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
    // user can add Jarvis without hunting through menus.
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Jarvis',
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
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const url = webContents.getURL();
      const isLocalhost =
        url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

      // Allow media + speech recognition permissions from the local Next.js app
      if (
        isLocalhost &&
        ['media', 'microphone', 'camera', 'display-capture', 'speechRecognition', 'speech'].includes(permission)
      ) {
        callback(true);
        return;
      }

      callback(false);
    }
  );

  // Allow all permission checks from localhost
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => {
      if (!webContents) return false;
      const url = webContents.getURL();
      const isLocalhost =
        url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');
      if (isLocalhost && ['media', 'microphone', 'camera', 'speechRecognition', 'speech'].includes(permission)) {
        return true;
      }
      return false;
    }
  );
}

app.whenReady().then(async () => {
  // Default BrowserWindow title is "Electron"; menu / Dock name in dev follows the binary unless set here.
  app.setName('Jarvis');

  registerJarvisPdfProtocol();
  setupPermissions();
  setupDesktopModeIpc();
  await requestMediaPermissions();
  requestAccessibilityAndScreenRecording();

  if (isDev) {
    createWindow();
  } else {
    try {
      await startNextServer();
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
        title: 'Jarvis — could not start',
        message:
          'The local web server did not start, so Jarvis cannot load its interface.',
        detail: message,
      });
      app.quit();
      return;
    }
  }

  appReady = true;
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
  nextServer?.kill();
});
