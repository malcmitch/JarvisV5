import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  platform: process.platform,
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
});
