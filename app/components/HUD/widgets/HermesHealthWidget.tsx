'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Agent health for the profile Camille delegates voice commands to.
 *
 * launchd already restarts a gateway that crashes, so this widget exists for
 * the failure launchd can't see: the process is alive but its API server has
 * stopped answering, which from the user's side looks like Camille silently
 * ignoring every "ask Hermes" request.
 *
 * Polling is deliberately restrained — 20s, and paused entirely while the
 * window is hidden. A status light that costs measurable CPU to display would
 * be its own bug.
 */

type Health = 'ok' | 'wedged' | 'down' | 'unconfigured' | 'unknown';

interface HealthResponse {
  profile: string;
  status: Health;
  detail: string | null;
}

const POLL_MS = 20_000;

const LOOK: Record<Health, { dot: string; text: string; label: string }> = {
  ok:           { dot: 'bg-emerald-400',  text: 'text-emerald-300',  label: 'ONLINE' },
  wedged:       { dot: 'bg-amber-400',    text: 'text-amber-300',    label: 'NOT RESPONDING' },
  down:         { dot: 'bg-red-400',      text: 'text-red-300',      label: 'STOPPED' },
  unconfigured: { dot: 'bg-white/30',     text: 'text-white/50',     label: 'NOT SET UP' },
  unknown:      { dot: 'bg-white/20',     text: 'text-white/40',     label: 'CHECKING…' },
};

export function HermesHealthWidget() {
  const [health, setHealth] = useState<Health>('unknown');
  const [profile, setProfile] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [restarting, setRestarting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch('/api/hermes/health', { cache: 'no-store' });
      const body = (await res.json()) as HealthResponse & { error?: string };
      if (body.error) throw new Error(body.error);
      setHealth(body.status ?? 'unknown');
      setProfile(body.profile ?? '');
      setDetail(body.detail ?? null);
      setCheckedAt(new Date());
    } catch (err) {
      setHealth('unknown');
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Deferred rather than called inline: check() can settle synchronously
    // (cached response, immediate throw), and committing state during the
    // effect body triggers a cascading render.
    const first = setTimeout(() => void check(), 0);
    timerRef.current = setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(first);
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check]);

  const restart = async () => {
    setRestarting(true);
    setDetail('Restarting the gateway…');
    try {
      const res = await fetch('/api/hermes/health', { method: 'POST' });
      const body = (await res.json()) as { error?: string };
      if (body.error) throw new Error(body.error);
      // The gateway needs a moment to drain and rebind before it answers.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await check();
      }
    } catch (err) {
      setDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  };

  const look = LOOK[health];
  const needsAction = health === 'wedged' || health === 'down';

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-1.5 mb-2">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${look.dot} ${health === 'ok' ? 'animate-pulse' : ''}`}
        />
        <span className={`uppercase tracking-widest ${look.text}`}>{look.label}</span>
        {profile && <span className="text-white/25 ml-auto text-[10px] truncate">{profile}</span>}
      </div>

      <div data-no-drag className="flex-1 overflow-y-auto pr-1 space-y-2">
        {detail && <div className="text-white/50 break-words leading-snug">{detail}</div>}

        {health === 'ok' && (
          <div className="text-white/40 leading-snug">
            Agent API is answering. Voice delegation and chat widgets are live.
          </div>
        )}

        {health === 'wedged' && (
          <div className="text-white/50 leading-snug">
            The process is alive, so launchd sees nothing wrong and won&apos;t restart it.
            A manual restart is the fix.
          </div>
        )}

        {needsAction && (
          <button
            onClick={() => void restart()}
            disabled={restarting}
            className="px-2 py-1 rounded border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-30 uppercase tracking-wider text-[10px]"
          >
            {restarting ? 'restarting…' : health === 'down' ? 'start gateway' : 'restart gateway'}
          </button>
        )}
      </div>

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => void check()}
          className="text-[10px] uppercase tracking-wider text-white/40 hover:text-cyan-300"
        >
          ↻ check now
        </button>
        {checkedAt && (
          <span className="text-white/20 text-[10px]">
            {checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  );
}
