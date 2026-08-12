export {};

export type JarvisDesktopPanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface JarvisAccount {
  id: string;
  email: string;
}

export interface JarvisAuthState {
  /** False when the build has no account server configured. */
  configured: boolean;
  signedIn: boolean;
  user: JarvisAccount | null;
  /** A browser sign-in is being redeemed right now. */
  pending: boolean;
  error: string | null;
}

/** One bucket of the account's monthly allowance. A null limit means unlimited. */
export interface JarvisCreditBucket {
  limit: number | null;
  used: number;
  remaining: number | null;
}

export interface JarvisCreditStatus {
  account_status: string;
  subscription_status: string;
  plan_id: string | null;
  entitled: boolean;
  period_start: string;
  credits: {
    ai_request: JarvisCreditBucket;
    voice_minutes: JarvisCreditBucket;
    usage: JarvisCreditBucket;
  };
}

/** The result of a metered call the main process made on the renderer's behalf. */
export interface JarvisCloudResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}

declare global {
  interface Window {
    electron?: {
      isElectron: true;
      platform: NodeJS.Platform;
      auth?: {
        getState: () => Promise<JarvisAuthState>;
        startLogin: () => Promise<{ ok: boolean; error?: string }>;
        signOut: () => Promise<void>;
        credits: () => Promise<{ ok: boolean; data?: JarvisCreditStatus; error?: string }>;
        openAccount: () => Promise<void>;
        openSignup: () => Promise<void>;
        onChanged: (callback: (state: JarvisAuthState) => void) => () => void;
      };
      cloud?: {
        /** `data.token` is a single-conversation ElevenLabs token. */
        voiceToken: () => Promise<JarvisCloudResult>;
        /** A 402 means the account is out of minutes and the call should end. */
        voiceHeartbeat: (minutes?: number) => Promise<JarvisCloudResult>;
      };
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
      getTouchInputStatus?: () => Promise<{ connected: boolean; product?: string; permissionDenied?: boolean }>;
      onTouchInputStatus?: (
        callback: (status: { connected: boolean; product?: string; permissionDenied?: boolean }) => void
      ) => () => void;
      setWindowOpaque?: (opaque: boolean) => Promise<{ success: boolean; opaque?: boolean; error?: string }>;
      socialStart?: () => Promise<{ success: boolean; error?: string }>;
      socialStop?: () => Promise<{ success: boolean }>;
      socialSetBounds?: (all: Partial<Record<'instagram' | 'tiktok' | 'facebook' | 'youtube', { x: number; y: number; width: number; height: number }>>) => Promise<{ success: boolean }>;
      socialNavigate?: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube', url: string) => Promise<{ success: boolean; error?: string }>;
      socialNavigateAll?: (url: string) => Promise<{ success: boolean }>;
      socialReload?: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube') => Promise<{ success: boolean }>;
      socialHome?: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube') => Promise<{ success: boolean }>;
      socialGetUrl?: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube') => Promise<{ success: boolean; url?: string }>;
      socialCaptureHtml?: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube') => Promise<{ success: boolean; html?: string; url?: string; title?: string; error?: string }>;
      socialExec?: (id: 'instagram' | 'tiktok' | 'facebook' | 'youtube', code: string) => Promise<{ success: boolean; result?: unknown; error?: string }>;
      socialPostReply?: (
        id: 'instagram' | 'tiktok' | 'facebook' | 'youtube',
        author: string,
        commentText: string,
        reply: string,
        options?: { typingMsPerChar?: number; typingJitterMs?: number },
      ) => Promise<{ success: boolean; error?: string }>;
    };
  }
}
