import {
  app,
  BrowserWindow,
  shell,
  session,
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
let nextServer: ChildProcess | null = null;
// Set to true only after the Next.js server is confirmed ready and the first
// window has been created. Guards activate/reopen handlers from firing early.
let appReady = false;

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
    backgroundColor: '#000000',
    show: false,
    icon: path.join(__dirname, '..', 'buildfiles', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
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
