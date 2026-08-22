'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Hermes, wearing Camille.
 *
 * Embeds the full Hermes Agent web dashboard (sessions, bot chats, kanban,
 * model picker, capabilities, scheduled jobs — everything the Hermes desktop
 * app offers) as a page inside the Camille interface. If the dashboard isn't
 * running, Camille starts it herself via /api/hermes-dashboard.
 */

const DASHBOARD_URL = 'http://localhost:8799';

type Status = 'checking' | 'starting' | 'up' | 'down';

export function HermesPage({ onNavigateHome }: { onNavigateHome: () => void }) {
  const [status, setStatus] = useState<Status>('checking');
  const [error, setError] = useState<string | null>(null);
  // Bumped to force the iframe to remount after a (re)start.
  const [frameEpoch, setFrameEpoch] = useState(0);

  const ensureUp = useCallback(async () => {
    setStatus('checking');
    setError(null);
    try {
      const health = await fetch('/api/hermes-dashboard');
      const { up } = (await health.json()) as { up?: boolean };
      if (up) {
        setStatus('up');
        setFrameEpoch((n) => n + 1);
        return;
      }
      setStatus('starting');
      const res = await fetch('/api/hermes-dashboard', { method: 'POST' });
      const data = (await res.json()) as { up?: boolean; error?: string };
      if (data.up) {
        setStatus('up');
        setFrameEpoch((n) => n + 1);
      } else {
        setStatus('down');
        setError(data.error ?? 'The Hermes dashboard did not start.');
      }
    } catch (err) {
      setStatus('down');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void ensureUp();
  }, [ensureUp]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      {/* Slim HUD header so this still feels like Camille */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-cyan-400/20 bg-black/80">
        <div className="flex items-center gap-3">
          <button
            onClick={onNavigateHome}
            className="text-cyan-400/80 hover:text-cyan-300 text-xs uppercase tracking-widest"
          >
            ← Camille
          </button>
          <span className="text-white/30 text-xs uppercase tracking-widest">Hermes Command</span>
        </div>
        <button
          onClick={() => void ensureUp()}
          className="text-white/30 hover:text-cyan-300 text-xs uppercase tracking-widest"
        >
          ↻ reload
        </button>
      </div>

      <div className="relative flex-1">
        {status === 'up' && (
          <iframe
            key={frameEpoch}
            src={DASHBOARD_URL}
            className="absolute inset-0 w-full h-full border-0 bg-[#0a0e14]"
            title="Hermes dashboard"
          />
        )}
        {status !== 'up' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
            {status === 'checking' && <div className="text-cyan-300/80 text-sm">Reaching Hermes…</div>}
            {status === 'starting' && (
              <>
                <div className="text-cyan-300/80 text-sm animate-pulse">
                  Waking the Hermes dashboard…
                </div>
                <div className="text-white/30 text-xs">
                  First start can take up to a minute while it builds its interface.
                </div>
              </>
            )}
            {status === 'down' && (
              <>
                <div className="text-red-400/90 text-sm">Hermes dashboard is not reachable.</div>
                {error && <div className="text-white/40 text-xs max-w-md break-words">{error}</div>}
                <button
                  onClick={() => void ensureUp()}
                  className="mt-2 px-4 py-1.5 rounded border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 text-xs uppercase tracking-wider"
                >
                  try again
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
