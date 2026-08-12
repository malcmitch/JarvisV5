'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { JarvisAuthState, JarvisCreditStatus } from '../window-electron';

/**
 * Blocks the interface until the machine is signed in to a Jarvis account.
 *
 * Sign-in happens in the browser at jarvisdesktop.com — this only asks for it and
 * reflects the result. All of the token handling is in the Electron main process.
 *
 * This is the front door, not the lock: it stops someone using the app without an
 * account, but it is renderer code on the user's own machine, so it is not what
 * enforces the credit limit. That happens server-side, every time a metered call
 * is made. See supabase/migrations/20260811000000_desktop_credits.sql in
 * jarvis-web.
 *
 * Renders nothing outside Electron. The Jarvis UI is also served over the LAN to
 * phones and tablets, and those clients have no IPC bridge to sign in through.
 */

const ACCENT = '#00d4ff';

export function SignInGate() {
  const [state, setState] = useState<JarvisAuthState | null>(null);
  const [credits, setCredits] = useState<JarvisCreditStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const auth = typeof window !== 'undefined' ? window.electron?.auth : undefined;

  useEffect(() => {
    if (!auth) return;
    void auth.getState().then(setState);
    return auth.onChanged(setState);
  }, [auth]);

  // Entitlement is shown here for the user's benefit; it is not what gates the
  // product. Refreshed whenever they sign in.
  useEffect(() => {
    if (!auth || !state?.signedIn) return;
    let cancelled = false;
    void auth.credits().then((result) => {
      if (!cancelled && result.ok && result.data) setCredits(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [auth, state?.signedIn]);

  const signIn = useCallback(async () => {
    if (!auth) return;
    setBusy(true);
    await auth.startLogin();
    setBusy(false);
  }, [auth]);

  if (!auth) return null;

  const blocked = state !== null && !state.signedIn;

  return (
    <AnimatePresence>
      {/* z-10000 puts this above the intro animation at z-9999. Being mounted
          after the intro in the tree is not enough to cover it. */}
      {blocked && (
        <motion.div
          key="signin"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden bg-[#01040a]"
        >
          {/* Reactor rings */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2">
            <motion.div
              className="absolute inset-0 rounded-full border"
              style={{ borderColor: `${ACCENT}1f` }}
              animate={{ rotate: 360 }}
              transition={{ duration: 40, repeat: Infinity, ease: 'linear' }}
            />
            <motion.div
              className="absolute inset-16 rounded-full border"
              style={{ borderColor: `${ACCENT}14` }}
              animate={{ rotate: -360 }}
              transition={{ duration: 26, repeat: Infinity, ease: 'linear' }}
            />
            <div
              className="absolute inset-28 rounded-full"
              style={{ boxShadow: `0 0 120px ${ACCENT}22, inset 0 0 80px ${ACCENT}14` }}
            />
          </div>

          <div className="relative w-full max-w-md px-8 text-center">
            <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.4em] text-white/30">
              Jarvis
            </div>

            {!state?.configured ? (
              <>
                <h1 className="mb-4 text-2xl font-semibold text-white">
                  Accounts aren&apos;t configured
                </h1>
                <p className="text-sm leading-relaxed text-white/45">
                  This build has no account server set, so it cannot sign you in. Set
                  <code className="mx-1 font-mono text-xs text-[#00d4ff]">JARVIS_SUPABASE_URL</code>
                  and
                  <code className="mx-1 font-mono text-xs text-[#00d4ff]">
                    JARVIS_SUPABASE_PUBLISHABLE_KEY
                  </code>
                  before launching.
                </p>
              </>
            ) : (
              <>
                <h1 className="mb-4 text-2xl font-semibold text-white">
                  Sign in to start Jarvis
                </h1>
                <p className="mb-8 text-sm leading-relaxed text-white/45">
                  Jarvis runs on your Jarvis account. Signing in happens in your browser
                  at jarvisdesktop.com, then brings you straight back here.
                </p>

                {state.error && (
                  <div className="mb-6 rounded-lg border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] px-4 py-3 text-xs leading-relaxed text-[#fca5a5]">
                    {state.error}
                  </div>
                )}

                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={signIn}
                    disabled={busy || state.pending}
                    className="w-full rounded-lg border px-5 py-3 text-sm font-medium text-white transition-colors disabled:opacity-50"
                    style={{
                      borderColor: `${ACCENT}59`,
                      background: `linear-gradient(180deg, ${ACCENT}1f, ${ACCENT}0a)`,
                    }}
                  >
                    {state.pending
                      ? 'Finishing sign-in...'
                      : busy
                        ? 'Opening your browser...'
                        : 'Sign in'}
                  </button>

                  <button
                    type="button"
                    onClick={() => void auth.openSignup()}
                    className="w-full rounded-lg border border-white/10 px-5 py-3 text-sm text-white/65 transition-colors hover:border-white/20 hover:text-white"
                  >
                    Create an account
                  </button>
                </div>

                <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.25em] text-white/20">
                  {state.pending
                    ? 'Waiting on jarvisdesktop.com'
                    : 'New here? Create an account first'}
                </p>
              </>
            )}
          </div>
        </motion.div>
      )}

      {/* Signed in but with nothing to spend: worth saying before they try to
          talk to Jarvis and get refused by the server. */}
      {!blocked && state?.signedIn && credits && !credits.entitled && (
        <motion.div
          key="not-entitled"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          className="fixed left-1/2 top-4 z-[200] -translate-x-1/2 rounded-full border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.1)] px-5 py-2 text-xs text-[#fcd34d] backdrop-blur"
        >
          No active plan on this account —{' '}
          <button
            type="button"
            onClick={() => void auth.openAccount()}
            className="underline underline-offset-2 hover:text-white"
          >
            manage your subscription
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
