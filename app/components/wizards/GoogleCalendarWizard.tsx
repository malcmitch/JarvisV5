'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ── Types ─────────────────────────────────────────────────────────────────────

interface GoogleCalendarWizardProps {
  onComplete: () => void;
  onSkip: () => void;
  onBack: () => void;
}

interface CredentialsJson {
  installed?: {
    client_id?: string;
    client_secret?: string;
    project_id?: string;
    auth_uri?: string;
    token_uri?: string;
    [key: string]: unknown;
  };
  web?: {
    client_id?: string;
    client_secret?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  data?: CredentialsJson;
}

interface DynamicStatus {
  configured: boolean;
  connected: boolean;
  tools: number;
  serverInfo: { name?: string; version?: string } | null;
  hasCredentials: boolean;
  credentialsPath: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 5;

const STEP_TITLES = [
  'Welcome',
  'Credentials',
  'Upload',
  'Authenticate',
  'Complete',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function validateCredentialsFile(content: string): ValidationResult {
  let parsed: CredentialsJson;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { valid: false, error: 'Invalid JSON file — please upload a valid credentials.json file.' };
  }

  if (parsed.installed?.client_id && parsed.installed?.client_secret) {
    return { valid: true, data: parsed };
  }

  if (parsed.web?.client_id && parsed.web?.client_secret) {
    return {
      valid: false,
      error: 'This appears to be a Web application credentials file. Make sure to select "Desktop app" as the application type when creating your OAuth client ID. The file must contain an "installed" object.',
    };
  }

  return {
    valid: false,
    error: 'Invalid credentials format — missing "installed" object with client_id and client_secret. Make sure you downloaded the OAuth credentials for a Desktop app.',
  };
}

function truncateClientId(id: string): string {
  if (id.length <= 24) return id;
  return id.substring(0, 20) + '...' + id.slice(-4);
}

// ── Step Indicator ────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2 px-1">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => (
        <div key={i} className="flex items-center gap-2 flex-1">
          <div className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-mono font-bold transition-all duration-300 ${
                i < current
                  ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/50'
                  : i === current
                  ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/40 shadow-[0_0_8px_rgba(34,211,238,0.15)]'
                  : 'bg-white/[0.04] text-white/20 border border-white/[0.08]'
              }`}
            >
              {i < current ? '✓' : i + 1}
            </div>
            <span
              className={`text-[8px] font-mono uppercase tracking-widest hidden sm:block transition-colors duration-300 ${
                i === current ? 'text-cyan-400/80' : 'text-white/20'
              }`}
            >
              {STEP_TITLES[i]}
            </span>
          </div>
          {i < TOTAL_STEPS - 1 && (
            <div
              className={`h-[1px] flex-1 transition-all duration-500 ${
                i < current
                  ? 'bg-cyan-500/40'
                  : 'bg-white/[0.06]'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Drag & Drop Upload Area ───────────────────────────────────────────────────

function UploadArea({
  onFile,
  disabled,
}: {
  onFile: (file: File, content: string) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState(false);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragIn = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setDragging(true);
    }
  }, []);

  const handleDragOut = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);

      if (disabled) return;

      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      if (!file.name.endsWith('.json')) {
        return;
      }

      setDropped(true);
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        onFile(file, content);
      };
      reader.readAsText(file);
    },
    [onFile, disabled]
  );

  const handleClick = () => {
    if (!disabled) inputRef.current?.click();
  };

  return (
    <div
      onDragEnter={handleDragIn}
      onDragLeave={handleDragOut}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleClick();
      }}
      aria-label="Upload credentials.json file"
      className={`relative cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-all duration-300 ${
        dragging
          ? 'border-cyan-400 bg-cyan-500/[0.08] shadow-[0_0_30px_rgba(34,211,238,0.1)]'
          : dropped
          ? 'border-emerald-500/50 bg-emerald-500/[0.04]'
          : 'border-white/[0.12] bg-white/[0.02] hover:border-white/[0.25] hover:bg-white/[0.04]'
      } ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setDropped(true);
          const reader = new FileReader();
          reader.onload = () => {
            const content = reader.result as string;
            onFile(file, content);
          };
          reader.readAsText(file);
        }}
      />

      {!dropped && (
        <div className="flex flex-col items-center gap-4">
          {/* File icon */}
          <div className="relative w-14 h-14">
            <div className="absolute inset-0 rounded-xl border-2 border-white/[0.15] flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/30">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-500/30 border border-cyan-400/40 flex items-center justify-center">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-cyan-400">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
          </div>

          <div>
            <div className="text-[11px] font-mono text-white/60">
              Drop your <span className="text-cyan-400/80">credentials.json</span> here
            </div>
            <div className="text-[9px] font-mono text-white/25 mt-1">or click to browse</div>
          </div>
        </div>
      )}

      {dropped && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-400">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <div className="text-[10px] font-mono text-emerald-400/70">File loaded — validating...</div>
        </div>
      )}
    </div>
  );
}

// ── Scan Lines Overlay ────────────────────────────────────────────────────────

function ScanLines() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[60] opacity-[0.03]"
      style={{
        backgroundImage:
          'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(34, 211, 238, 0.08) 2px, rgba(34, 211, 238, 0.08) 3px)',
        backgroundSize: '100% 3px',
      }}
    />
  );
}

// ── Pulsing Dot ───────────────────────────────────────────────────────────────

function PulsingDot({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full animate-pulse ${className}`} />
  );
}

// ── HUD Corner Brackets ───────────────────────────────────────────────────────

function HUDCorners() {
  return (
    <>
      {['top-0 left-0 border-t-2 border-l-2','top-0 right-0 border-t-2 border-r-2',
        'bottom-0 left-0 border-b-2 border-l-2','bottom-0 right-0 border-b-2 border-r-2'].map((cls,i) => (
        <div key={i} className={`absolute w-8 h-8 ${cls} border-cyan-500/20 pointer-events-none z-10 m-3`} />
      ))}
    </>
  );
}

// ── Step Transitions ──────────────────────────────────────────────────────────

const stepVariants = {
  initial: { opacity: 0, y: 20, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -20, filter: 'blur(4px)' },
};

// ── Feature Card ──────────────────────────────────────────────────────────────

function FeatureCard({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="group flex items-start gap-4 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-cyan-500/25 hover:bg-cyan-500/[0.04] transition-all duration-300">
      <div className="w-10 h-10 shrink-0 rounded-lg bg-cyan-500/[0.08] border border-cyan-500/20 flex items-center justify-center text-lg group-hover:bg-cyan-500/[0.12] group-hover:border-cyan-500/30 transition-all duration-300">
        {icon}
      </div>
      <div>
        <div className="text-[11px] font-mono text-white/80 font-semibold mb-0.5">{title}</div>
        <div className="text-[10px] font-mono text-white/30 leading-relaxed">{desc}</div>
      </div>
    </div>
  );
}

// ── Main Wizard Component ─────────────────────────────────────────────────────

export function GoogleCalendarWizard({ onComplete, onSkip, onBack }: GoogleCalendarWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);

  // Step 2: File upload state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [validatedData, setValidatedData] = useState<CredentialsJson | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [savedProjectId, setSavedProjectId] = useState<string | null>(null);

  // Step 3: Auth state
  const [authStatus, setAuthStatus] = useState<'idle' | 'starting' | 'connecting' | 'connected' | 'error'>('idle');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authPolling, setAuthPolling] = useState(false);
  const [serverTools, setServerTools] = useState<number>(0);

  // Step 4: Final info
  const [finalTools, setFinalTools] = useState(0);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const nextStep = useCallback(() => {
    setCurrentStep((s) => Math.min(s + 1, TOTAL_STEPS - 1));
  }, []);

  const prevStep = useCallback(() => {
    if (currentStep === 0) {
      onBack();
      return;
    }
    // Reset step-specific state when going back
    if (currentStep === 2) {
      setUploadedFile(null);
      setValidatedData(null);
      setValidationError(null);
      setUploadError(null);
      setUploadSuccess(false);
      setSavedProjectId(null);
    }
    if (currentStep === 3) {
      setAuthStatus('idle');
      setAuthError(null);
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      setAuthPolling(false);
    }
    setCurrentStep((s) => Math.max(s - 1, 0));
  }, [currentStep, onBack]);

  // ── Step 2: Handle file upload ──────────────────────────────────────────────

  const handleFileSelected = useCallback(async (file: File, content: string) => {
    setUploadedFile(file);
    setValidationError(null);
    setUploadError(null);
    setUploadSuccess(false);

    // Client-side validation
    const result = validateCredentialsFile(content);
    if (!result.valid) {
      setValidationError(result.error ?? 'Invalid file');
      setValidatedData(null);
      return;
    }

    setValidatedData(result.data!);

    // Upload to server
    setIsUploading(true);
    try {
      const res = await fetch('/api/mcp/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();

      if (!res.ok) {
        setUploadError(data.error || 'Failed to save credentials');
        setUploadSuccess(false);
      } else {
        setUploadSuccess(true);
        setSavedProjectId(data.projectId || null);
      }
    } catch {
      setUploadError('Network error — could not reach the server');
      setUploadSuccess(false);
    } finally {
      setIsUploading(false);
    }
  }, []);

  // ── Step 3: Start authentication ────────────────────────────────────────────

  const startAuth = useCallback(async () => {
    setAuthStatus('starting');
    setAuthError(null);

    try {
      // First, get the credentials path
      const credRes = await fetch('/api/mcp/credentials');
      const credData = await credRes.json();

      const credentialsPath = credData.path || '';

      // Register + start the MCP server
      const res = await fetch('/api/mcp/dynamic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'google-calendar',
          command: 'npx',
          args: ['-y', '@cocal/google-calendar-mcp'],
          env: {
            GOOGLE_OAUTH_CREDENTIALS: credentialsPath,
          },
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setAuthStatus('error');
        setAuthError(data.error || 'Failed to start MCP server');
        return;
      }

      setAuthStatus('connecting');

      // Start polling for connection
      setAuthPolling(true);
      let attempts = 0;
      const maxAttempts = 60; // 2 minutes max

      const poll = setInterval(async () => {
        attempts++;
        try {
          const pollRes = await fetch('/api/mcp/dynamic');
          const pollData: DynamicStatus = await pollRes.json();

          if (pollData.connected) {
            clearInterval(poll);
            pollingRef.current = null;
            setAuthPolling(false);
            setAuthStatus('connected');
            setServerTools(pollData.tools);
            setFinalTools(pollData.tools);
            // Auto-advance after short delay
            setTimeout(() => nextStep(), 1200);
          } else if (attempts >= maxAttempts) {
            clearInterval(poll);
            pollingRef.current = null;
            setAuthPolling(false);
            setAuthStatus('error');
            setAuthError('Connection timed out. Check your browser for the Google sign-in page.');
          } else if (attempts === 3) {
            // After a few attempts, show the user-action message
            setAuthStatus('connecting');
          }
        } catch {
          // Continue polling
        }
      }, 2000);

      pollingRef.current = poll;
    } catch (err) {
      setAuthStatus('error');
      setAuthError(err instanceof Error ? err.message : 'An unexpected error occurred');
    }
  }, [nextStep]);

  // ── Step 4: Setup final info on mount ───────────────────────────────────────

  useEffect(() => {
    if (currentStep === 4) {
      // Fetch the latest status for the success screen
      const getFinalStatus = async () => {
        try {
          const res = await fetch('/api/mcp/dynamic');
          const data: DynamicStatus = await res.json();
          setFinalTools(data.tools);
        } catch {
          // Use whatever we already have
        }
      };
      getFinalStatus();
    }
  }, [currentStep]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <motion.div
      key="gcal-wizard"
      className="fixed inset-0 bg-[#050810] z-[50] overflow-hidden flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <HUDCorners />
      <ScanLines />

      {/* ── Header with Step Indicator ───────────────────────────────────── */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-3">
          <PulsingDot className="bg-cyan-400" />
          <span className="text-[10px] font-mono text-cyan-400/70 uppercase tracking-widest">
            Google Calendar Setup
          </span>
        </div>
        <div className="flex-1 max-w-md mx-8 hidden md:block">
          <StepIndicator current={currentStep} />
        </div>
        <div className="text-[9px] font-mono text-white/20">
          Step {currentStep + 1} of {TOTAL_STEPS}
        </div>
      </div>

      {/* ── Mobile step indicator ────────────────────────────────────────── */}
      <div className="md:hidden px-8 py-3 border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={`flex-1 h-1 rounded-full transition-all duration-500 ${
                i <= currentStep ? 'bg-cyan-500/50' : 'bg-white/[0.06]'
              }`}
            />
          ))}
        </div>
      </div>

      {/* ── Step Content ─────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-12 md:py-16">
          <AnimatePresence mode="wait">
            {/* ══════ STEP 0: Welcome ══════ */}
            {currentStep === 0 && (
              <motion.div
                key="step-welcome"
                variants={stepVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.4 }}
                className="space-y-8"
              >
                {/* Glowing calendar icon */}
                <div className="flex justify-center mb-2">
                  <div className="relative">
                    <div className="w-20 h-20 rounded-2xl bg-cyan-500/[0.06] border border-cyan-500/25 flex items-center justify-center shadow-[0_0_40px_rgba(34,211,238,0.08)]">
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-cyan-400">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                        <line x1="12" y1="14" x2="12" y2="18" />
                        <line x1="9" y1="14" x2="9" y2="18" />
                        <line x1="15" y1="14" x2="15" y2="18" />
                      </svg>
                    </div>
                    <div className="absolute -inset-4 rounded-3xl border border-cyan-500/10 animate-pulse pointer-events-none" style={{ animationDuration: '3s' }} />
                  </div>
                </div>

                <div className="text-center space-y-2">
                  <h1 className="text-2xl md:text-3xl font-mono font-bold text-white tracking-tight">
                    Supercharge Your{' '}
                    <span className="text-cyan-400">Calendar</span>
                  </h1>
                  <p className="text-[12px] font-mono text-white/40 leading-relaxed max-w-lg mx-auto">
                    Connect Google Calendar to let Jarvis read, create, and manage your events by voice.
                  </p>
                </div>

                {/* Feature cards */}
                <div className="space-y-2.5">
                  <FeatureCard
                    icon="📅"
                    title="Read Events"
                    desc="View your schedule at a glance"
                  />
                  <FeatureCard
                    icon="✍️"
                    title="Write Events"
                    desc="Create and update events by voice"
                  />
                  <FeatureCard
                    icon="🔔"
                    title="Smart Scheduling"
                    desc="Check availability automatically"
                  />
                </div>

                {/* Actions */}
                <div className="flex flex-col items-center gap-3 pt-4">
                  <button
                    onClick={nextStep}
                    className="group relative px-8 py-3 rounded-xl bg-cyan-500/15 border border-cyan-500/35 text-cyan-400 text-[11px] font-mono uppercase tracking-widest hover:bg-cyan-500/25 transition-all duration-300 overflow-hidden"
                  >
                    <span className="relative z-10">Get Started</span>
                    <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/0 via-cyan-500/10 to-cyan-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 translate-x-[-100%] group-hover:translate-x-[100%]" />
                  </button>
                  <div className="flex items-center gap-4">
                    <button
                      onClick={onSkip}
                      className="text-[9px] font-mono text-white/25 hover:text-white/50 transition-colors uppercase tracking-wider"
                    >
                      Skip for now
                    </button>
                    <span className="text-white/10 text-[9px]">·</span>
                    <button
                      onClick={onBack}
                      className="text-[9px] font-mono text-white/25 hover:text-white/50 transition-colors uppercase tracking-wider"
                    >
                      Back
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ══════ STEP 1: Create Credentials ══════ */}
            {currentStep === 1 && (
              <motion.div
                key="step-credentials"
                variants={stepVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.4 }}
                className="space-y-8"
              >
                <div className="text-center space-y-2">
                  <h1 className="text-2xl md:text-3xl font-mono font-bold text-white tracking-tight">
                    Create Your Google{' '}
                    <span className="text-cyan-400">Credentials</span>
                  </h1>
                  <p className="text-[12px] font-mono text-white/40 leading-relaxed max-w-lg mx-auto">
                    You'll need to create a Google Cloud project and download your credentials file. It takes about 5 minutes.
                  </p>
                </div>

                {/* Step-by-step guide */}
                <div className="space-y-1.5">
                  {[
                    {
                      num: '01',
                      text: 'Open the Google Cloud Console',
                      link: 'https://console.cloud.google.com/',
                    },
                    {
                      num: '02',
                      text: 'Create a new project or select an existing one',
                      link: null,
                    },
                    {
                      num: '03',
                      text: 'Enable the Google Calendar API',
                      link: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
                    },
                    {
                      num: '04',
                      text: 'Go to APIs & Services → Credentials → Create Credentials → OAuth client ID',
                      link: null,
                    },
                    {
                      num: '05',
                      text: 'Choose "Desktop app" as the application type (important!)',
                      link: null,
                      highlight: true,
                    },
                    {
                      num: '06',
                      text: 'Download the credentials JSON file',
                      link: null,
                    },
                  ].map((step) => (
                    <div
                      key={step.num}
                      className={`flex items-start gap-4 p-3.5 rounded-xl transition-all duration-200 ${
                        step.highlight
                          ? 'bg-cyan-500/[0.06] border border-cyan-500/20'
                          : 'bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04]'
                      }`}
                    >
                      <span
                        className={`text-[10px] font-mono font-bold shrink-0 w-8 text-right ${
                          step.highlight ? 'text-cyan-400/80' : 'text-white/20'
                        }`}
                      >
                        {step.num}
                      </span>
                      <div className="flex-1 min-w-0">
                        {step.link ? (
                          <a
                            href={step.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-mono text-white/70 hover:text-cyan-400 transition-colors underline underline-offset-2 decoration-white/10 hover:decoration-cyan-500/40"
                          >
                            {step.text} ↗
                          </a>
                        ) : (
                          <span className={`text-[11px] font-mono leading-snug ${
                            step.highlight ? 'text-cyan-300/90 font-semibold' : 'text-white/60'
                          }`}>
                            {step.text}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Tip box */}
                <div className="p-4 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
                  <div className="flex items-start gap-3">
                    <span className="text-amber-400/70 text-sm shrink-0 mt-0.5">💡</span>
                    <div className="text-[10px] font-mono text-amber-300/70 leading-relaxed">
                      Make sure you select <strong className="text-amber-300">Desktop app</strong>, not Web application. The file should contain an <code className="text-amber-200 bg-amber-500/10 px-1 rounded">"installed"</code> object with your client_id and client_secret.
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between pt-2">
                  <button
                    onClick={prevStep}
                    className="px-6 py-2.5 text-[10px] font-mono text-white/30 hover:text-white/50 transition-colors uppercase tracking-wider"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={nextStep}
                    className="px-8 py-2.5 rounded-xl bg-cyan-500/15 border border-cyan-500/35 text-cyan-400 text-[10px] font-mono uppercase tracking-widest hover:bg-cyan-500/25 transition-all"
                  >
                    I've downloaded my credentials
                  </button>
                </div>
              </motion.div>
            )}

            {/* ══════ STEP 2: Upload File ══════ */}
            {currentStep === 2 && (
              <motion.div
                key="step-upload"
                variants={stepVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.4 }}
                className="space-y-8"
              >
                <div className="text-center space-y-2">
                  <h1 className="text-2xl md:text-3xl font-mono font-bold text-white tracking-tight">
                    Upload Your{' '}
                    <span className="text-cyan-400">Credentials</span>
                  </h1>
                  <p className="text-[12px] font-mono text-white/40 leading-relaxed max-w-lg mx-auto">
                    Drop your credentials.json file here or click to browse
                  </p>
                </div>

                {/* Upload area */}
                <UploadArea
                  onFile={handleFileSelected}
                  disabled={isUploading || uploadSuccess}
                />

                {/* Loading state */}
                {isUploading && (
                  <div className="flex items-center justify-center gap-3">
                    <div className="w-4 h-4 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
                    <span className="text-[10px] font-mono text-cyan-400/70">Saving credentials...</span>
                  </div>
                )}

                {/* Validation error */}
                {validationError && (
                  <div className="p-4 rounded-xl bg-red-500/[0.06] border border-red-500/20">
                    <div className="flex items-start gap-3">
                      <span className="text-red-400/70 text-sm shrink-0 mt-0.5">✕</span>
                      <div className="text-[10px] font-mono text-red-300/70 leading-relaxed">{validationError}</div>
                    </div>
                  </div>
                )}

                {/* Upload error */}
                {uploadError && (
                  <div className="p-4 rounded-xl bg-red-500/[0.06] border border-red-500/20">
                    <div className="flex items-start gap-3">
                      <span className="text-red-400/70 text-sm shrink-0 mt-0.5">✕</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-mono text-red-300/70 leading-relaxed">{uploadError}</div>
                        <button
                          onClick={() => {
                            setUploadError(null);
                            setUploadSuccess(false);
                            setUploadedFile(null);
                            setValidatedData(null);
                            setValidationError(null);
                          }}
                          className="mt-2 text-[9px] font-mono text-red-400/50 hover:text-red-400 transition-colors uppercase tracking-wider"
                        >
                          Try again
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Success state */}
                {uploadSuccess && validatedData && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-5 rounded-xl bg-emerald-500/[0.06] border border-emerald-500/20 space-y-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-400">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                      <div>
                        <div className="text-[11px] font-mono text-emerald-400 font-semibold">Credentials saved successfully</div>
                        <div className="text-[9px] font-mono text-emerald-400/50">{uploadedFile?.name}</div>
                      </div>
                    </div>

                    {validatedData.installed && (
                      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-emerald-500/10">
                        <div>
                          <div className="text-[8px] font-mono text-white/30 uppercase tracking-widest mb-1">Client ID</div>
                          <div className="text-[10px] font-mono text-white/60 truncate" title={validatedData.installed.client_id}>
                            {truncateClientId(validatedData.installed.client_id || '—')}
                          </div>
                        </div>
                        <div>
                          <div className="text-[8px] font-mono text-white/30 uppercase tracking-widest mb-1">Project</div>
                          <div className="text-[10px] font-mono text-white/60 truncate">
                            {savedProjectId || validatedData.installed.project_id || '—'}
                          </div>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between pt-2">
                  <button
                    onClick={prevStep}
                    className="px-6 py-2.5 text-[10px] font-mono text-white/30 hover:text-white/50 transition-colors uppercase tracking-wider"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={nextStep}
                    disabled={!uploadSuccess}
                    className="px-8 py-2.5 rounded-xl bg-cyan-500/15 border border-cyan-500/35 text-cyan-400 text-[10px] font-mono uppercase tracking-widest hover:bg-cyan-500/25 transition-all disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    Continue
                  </button>
                </div>
              </motion.div>
            )}

            {/* ══════ STEP 3: Authenticate ══════ */}
            {currentStep === 3 && (
              <motion.div
                key="step-auth"
                variants={stepVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.4 }}
                className="space-y-8"
              >
                <div className="text-center space-y-2">
                  <h1 className="text-2xl md:text-3xl font-mono font-bold text-white tracking-tight">
                    Connect Your Google{' '}
                    <span className="text-cyan-400">Account</span>
                  </h1>
                  <p className="text-[12px] font-mono text-white/40 leading-relaxed max-w-lg mx-auto">
                    Time to start the MCP server and authenticate with Google.
                  </p>
                </div>

                {/* What's about to happen */}
                {authStatus === 'idle' && (
                  <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-3">
                    <div className="text-[10px] font-mono text-white/50 uppercase tracking-widest font-semibold mb-3">What will happen</div>
                    {[
                      'Jarvis will start the Google Calendar MCP server',
                      'A browser window will open asking you to sign in to Google',
                      'Grant permission to access your calendar',
                      'Tokens will be saved securely — you won\'t need to do this again',
                    ].map((item, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <div className="w-1.5 h-1.5 rounded-full bg-cyan-500/40 shrink-0" />
                        <span className="text-[11px] font-mono text-white/60">{item}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Starting state */}
                {authStatus === 'starting' && (
                  <div className="flex flex-col items-center gap-4 py-8">
                    <div className="relative w-16 h-16">
                      <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin" />
                      <div className="absolute inset-2 rounded-full border-2 border-cyan-500/10 border-b-cyan-400/60 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-cyan-400/80">Starting MCP server...</span>
                      <span className="inline-flex gap-0.5">
                        <span className="w-1 h-1 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1 h-1 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1 h-1 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                    </div>
                  </div>
                )}

                {/* Connecting state */}
                {authStatus === 'connecting' && (
                  <div className="flex flex-col items-center gap-5 py-8">
                    <div className="relative w-16 h-16">
                      <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin" style={{ animationDuration: '1.5s' }} />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-cyan-400/60">
                          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                        </svg>
                      </div>
                    </div>
                    <div className="text-center space-y-2">
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-[11px] font-mono text-cyan-400/80">Server connected! Waiting for authentication...</span>
                      </div>
                      <p className="text-[10px] font-mono text-white/35 max-w-md mx-auto leading-relaxed">
                        A browser window should have opened for Google sign-in. Complete the sign-in process there, then wait for confirmation here.
                      </p>
                      <p className="text-[9px] font-mono text-amber-400/50 max-w-sm mx-auto">
                        ⏳ If no browser opens, check that your default browser is configured or check console for the auth URL.
                      </p>
                    </div>
                    {/* Scanning animation */}
                    <div className="relative w-full max-w-xs h-[2px] bg-white/[0.06] rounded-full overflow-hidden mt-2">
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent animate-pulse rounded-full" style={{ animationDuration: '2s' }} />
                    </div>
                  </div>
                )}

                {/* Connected state */}
                {authStatus === 'connected' && (
                  <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                    className="flex flex-col items-center gap-4 py-8"
                  >
                    <div className="w-16 h-16 rounded-full bg-emerald-500/15 border-2 border-emerald-500/30 flex items-center justify-center shadow-[0_0_30px_rgba(34,197,94,0.1)]">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-400">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    <div className="text-center">
                      <div className="text-[13px] font-mono text-emerald-400 font-semibold">Authentication successful!</div>
                      <div className="text-[10px] font-mono text-emerald-400/50 mt-1">
                        {serverTools} tool{serverTools !== 1 ? 's' : ''} available
                      </div>
                    </div>
                    <div className="flex gap-1 mt-1">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="w-2 h-2 rounded-full bg-emerald-400/60"
                          style={{ animation: `bounce 0.6s ${i * 0.15}s infinite alternate` }}
                        />
                      ))}
                    </div>
                  </motion.div>
                )}

                {/* Error state */}
                {authStatus === 'error' && (
                  <div className="p-5 rounded-xl bg-red-500/[0.06] border border-red-500/20">
                    <div className="flex items-start gap-3">
                      <span className="text-red-400/70 text-sm shrink-0 mt-0.5">✕</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-mono text-red-300/80 font-semibold mb-1">Authentication Failed</div>
                        <div className="text-[10px] font-mono text-red-300/60 leading-relaxed">{authError}</div>
                        <button
                          onClick={startAuth}
                          className="mt-3 text-[9px] font-mono text-red-400/50 hover:text-red-400 transition-colors uppercase tracking-wider"
                        >
                          Retry
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between pt-2">
                  <button
                    onClick={prevStep}
                    disabled={authStatus === 'starting' || authStatus === 'connecting'}
                    className="px-6 py-2.5 text-[10px] font-mono text-white/30 hover:text-white/50 transition-colors uppercase tracking-wider disabled:opacity-20 disabled:cursor-not-allowed"
                  >
                    ← Back
                  </button>
                  {authStatus === 'idle' && (
                    <button
                      onClick={startAuth}
                      className="group relative px-8 py-2.5 rounded-xl bg-cyan-500/15 border border-cyan-500/35 text-cyan-400 text-[10px] font-mono uppercase tracking-widest hover:bg-cyan-500/25 transition-all overflow-hidden"
                    >
                      <span className="relative z-10">Start Authentication</span>
                      <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/0 via-cyan-500/10 to-cyan-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 translate-x-[-100%] group-hover:translate-x-[100%]" />
                    </button>
                  )}
                </div>
              </motion.div>
            )}

            {/* ══════ STEP 4: Done ══════ */}
            {currentStep === 4 && (
              <motion.div
                key="step-done"
                variants={stepVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.4 }}
                className="space-y-8"
              >
                {/* Success header */}
                <div className="flex flex-col items-center gap-4">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.15 }}
                    className="w-20 h-20 rounded-full bg-emerald-500/[0.08] border-2 border-emerald-500/25 flex items-center justify-center shadow-[0_0_40px_rgba(34,197,94,0.08)]"
                  >
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </motion.div>
                  <div className="text-center">
                    <h1 className="text-2xl md:text-3xl font-mono font-bold text-white tracking-tight">
                      Calendar{' '}
                      <span className="text-emerald-400">Connected!</span>
                    </h1>
                    <p className="text-[12px] font-mono text-white/40 leading-relaxed mt-2">
                      Google Calendar is now connected to Jarvis.
                    </p>
                  </div>
                </div>

                {/* Stats card */}
                <div className="p-6 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-4">
                  <div className="text-[9px] font-mono text-white/30 uppercase tracking-widest font-semibold">Connection Status</div>
                  <div className="space-y-3">
                    {[
                      { label: 'MCP Server', status: 'Online', icon: '✅' },
                      { label: 'Credentials', status: 'Configured', icon: '✅' },
                      { label: 'Google Account', status: 'Connected', icon: '✅' },
                      {
                        label: 'Available Tools',
                        status: `${finalTools} tool${finalTools !== 1 ? 's' : ''}`,
                        icon: '🔧',
                      },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="flex items-center justify-between py-2 px-3 rounded-lg bg-white/[0.02] border border-white/[0.04]"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-xs">{item.icon}</span>
                          <span className="text-[10px] font-mono text-white/50">{item.label}</span>
                        </div>
                        <span className="text-[10px] font-mono text-emerald-400/80 font-semibold">{item.status}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Description */}
                <div className="text-center">
                  <p className="text-[11px] font-mono text-white/40 leading-relaxed max-w-md mx-auto">
                    Your calendar is ready. Jarvis can now read your schedule, create events, check availability, and manage your day — all by voice.
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-center pt-2">
                  <button
                    onClick={onComplete}
                    className="group relative px-10 py-3 rounded-xl bg-cyan-500/15 border border-cyan-500/35 text-cyan-400 text-[11px] font-mono uppercase tracking-widest hover:bg-cyan-500/25 transition-all duration-300 overflow-hidden"
                  >
                    <span className="relative z-10">Open Calendar</span>
                    <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/0 via-cyan-500/10 to-cyan-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 translate-x-[-100%] group-hover:translate-x-[100%]" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
