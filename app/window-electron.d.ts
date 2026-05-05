export {};

declare global {
  interface Window {
    electron?: {
      isElectron: true;
      platform: NodeJS.Platform;
      onMenuAction: (callback: (action: string) => void) => () => void;
    };
  }
}
