export {};

export type JarvisDesktopPanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

declare global {
  interface Window {
    electron?: {
      isElectron: true;
      platform: NodeJS.Platform;
      onMenuAction: (callback: (action: string) => void) => () => void;
      setDesktopMode: (options: {
        enabled: boolean;
        position?: JarvisDesktopPanelPosition;
        logo?: 'logo' | 'logo2';
        muted?: boolean;
      }) => Promise<{ success: boolean; enabled?: boolean; position?: JarvisDesktopPanelPosition; error?: string }>;
      moveDesktopPanel: (position: JarvisDesktopPanelPosition) => Promise<{ success: boolean; position: JarvisDesktopPanelPosition }>;
      setDesktopPanelMuted: (muted: boolean) => void;
      setDesktopPanelMousePassthrough: (passthrough: boolean) => void;
      overlayClick: () => void;
      onDesktopOverlayClick: (callback: () => void) => () => void;
      onDesktopPanelMuted: (callback: (muted: boolean) => void) => () => void;
      onHeyJarvis?: (callback: () => void) => () => void;
      onHeyJarvisStatus?: (callback: (status: { enabled: boolean; listening: boolean }) => void) => () => void;
      onHeyJarvisError?: (callback: (error: string) => void) => () => void;
      setWakeWordEnabled?: (enabled: boolean) => void;
      setWakeWordSensitivity?: (sensitivity: number) => void;
      setWakeWordMicInUse?: (inUse: boolean) => void;
    };
  }
}
