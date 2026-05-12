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
});
