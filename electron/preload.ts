import { contextBridge, ipcRenderer } from 'electron';

type AuthState = {
  configured: boolean;
  signedIn: boolean;
  user: { id: string; email: string } | null;
  pending: boolean;
  error: string | null;
};

type CloudResult = {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
};

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  /**
   * Runs a shell command for the terminal widget. Main-process only, so this
   * is unreachable from a browser pointed at Camille over the LAN.
   */
  runShell: (
    command: string,
    cwd?: string,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated?: boolean }> =>
    ipcRenderer.invoke('shell:run', { command, cwd, timeoutMs }),
  platform: process.platform,
  // Sign-in lives entirely in the main process; only the state crosses over, so
  // no access or refresh token is ever reachable from window-scoped JavaScript.
  auth: {
    getState: (): Promise<AuthState> => ipcRenderer.invoke('auth:get-state'),
    startLogin: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('auth:start-login'),
    signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
    credits: (): Promise<{ ok: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke('auth:credits'),
    openAccount: (): Promise<void> => ipcRenderer.invoke('auth:open-account'),
    openSignup: (): Promise<void> => ipcRenderer.invoke('auth:open-signup'),
    onChanged: (callback: (state: AuthState) => void) => {
      const listener = (_event: unknown, state: AuthState) => callback(state);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    },
  },
  // Metered work, bought by the signed-in account. The renderer receives a
  // token for one conversation, never the account token that paid for it.
  cloud: {
    voiceToken: (): Promise<CloudResult> => ipcRenderer.invoke('cloud:voice-token'),
    voiceHeartbeat: (minutes?: number): Promise<CloudResult> =>
      ipcRenderer.invoke('cloud:voice-heartbeat', minutes ?? 1),
  },
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on('menu-action', (_event, action: string) => callback(action));
    return () => ipcRenderer.removeAllListeners('menu-action');
  },
  setDesktopMode: (options: {
    enabled: boolean;
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    logo?: 'logo' | 'logo2';
    muted?: boolean;
  }) => ipcRenderer.invoke('desktop-mode:set', options),
  moveDesktopPanel: (position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') =>
    ipcRenderer.invoke('desktop-mode:move', position),
  setDesktopPanelMuted: (muted: boolean) => ipcRenderer.send('desktop-mode:muted', muted),
  setDesktopPanelMousePassthrough: (passthrough: boolean) =>
    ipcRenderer.send('desktop-mode:mouse-passthrough', passthrough),
  overlayClick: () => ipcRenderer.send('desktop-mode:overlay-clicked'),
  getAudioSourceId: (): Promise<string | null> => ipcRenderer.invoke('get-audio-source-id'),
  onDesktopOverlayClick: (callback: () => void) => {
    ipcRenderer.on('desktop-mode:overlay-click', callback);
    return () => ipcRenderer.removeAllListeners('desktop-mode:overlay-click');
  },
  onDesktopPanelMuted: (callback: (muted: boolean) => void) => {
    ipcRenderer.on('desktop-mode:muted', (_event, muted: boolean) => callback(muted));
    return () => ipcRenderer.removeAllListeners('desktop-mode:muted');
  },
  onHeyJarvis: (callback: () => void) => {
    ipcRenderer.on('hey-jarvis:detected', callback);
    return () => ipcRenderer.removeAllListeners('hey-jarvis:detected');
  },
  onHeyJarvisStatus: (callback: (status: { enabled: boolean; listening: boolean }) => void) => {
    ipcRenderer.on('hey-jarvis:status', (_event, status) => callback(status));
    return () => ipcRenderer.removeAllListeners('hey-jarvis:status');
  },
  onHeyJarvisError: (callback: (error: string) => void) => {
    ipcRenderer.on('hey-jarvis:error', (_event, error) => callback(error));
    return () => ipcRenderer.removeAllListeners('hey-jarvis:error');
  },
  setWakeWordEnabled: (enabled: boolean) => {
    ipcRenderer.send('hey-jarvis:set-enabled', enabled);
  },
  setWakeWordSensitivity: (sensitivity: number) => {
    ipcRenderer.send('hey-jarvis:set-sensitivity', sensitivity);
  },
  setWakeWordMicInUse: (inUse: boolean) => {
    ipcRenderer.send('hey-jarvis:mic-in-use', inUse);
  },
  getTouchInputStatus: (): Promise<{ connected: boolean; product?: string; permissionDenied?: boolean }> =>
    ipcRenderer.invoke('touch-input:get-status'),
  onTouchInputStatus: (
    callback: (status: { connected: boolean; product?: string; permissionDenied?: boolean }) => void
  ) => {
    ipcRenderer.on('touch-input:status', (_event, status) => callback(status));
    return () => ipcRenderer.removeAllListeners('touch-input:status');
  },
  setWindowOpaque: (opaque: boolean): Promise<{ success: boolean; opaque?: boolean; error?: string }> =>
    ipcRenderer.invoke('window:set-opaque', opaque),
  socialStart: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('social:start'),
  socialStop: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('social:stop'),
  socialSetBounds: (all: Partial<Record<'instagram' | 'tiktok' | 'facebook' | 'youtube', { x: number; y: number; width: number; height: number }>>) =>
    ipcRenderer.invoke('social:set-bounds', all),
  socialNavigate: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube', url: string) =>
    ipcRenderer.invoke('social:navigate', id, url),
  socialNavigateAll: (url: string) =>
    ipcRenderer.invoke('social:navigate-all', url),
  socialReload: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube') =>
    ipcRenderer.invoke('social:reload', id),
  socialHome: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube') =>
    ipcRenderer.invoke('social:home', id),
  socialGetUrl: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube') =>
    ipcRenderer.invoke('social:get-url', id) as Promise<{ success: boolean; url?: string }>,
  socialCaptureHtml: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube') =>
    ipcRenderer.invoke('social:capture-html', id) as Promise<{ success: boolean; html?: string; url?: string; title?: string; error?: string }>,
  socialExec: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube', code: string) =>
    ipcRenderer.invoke('social:exec', id, code),
  socialPostReply: (
    id: 'instagram' | 'tiktok' | 'facebook' | 'youtube',
    author: string,
    commentText: string,
    reply: string,
    options?: { typingMsPerChar?: number; typingJitterMs?: number },
  ) =>
    ipcRenderer.invoke('social:post-reply', id, author, commentText, reply, options) as Promise<{
      success: boolean;
      error?: string;
    }>,
});
