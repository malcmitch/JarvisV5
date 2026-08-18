'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hermes scheduled jobs for a profile: see what's queued, pause it, delete it,
 * or add a new one.
 *
 * Complements Camille's own Timers rather than replacing them. A Camille timer
 * lives in the browser session; a Hermes job survives reboots, runs whether or
 * not Camille is open, and can call the agent's tools when it fires — so
 * "remind me in 20 minutes" belongs in Timers and "summarise my inbox every
 * morning at 9" belongs here.
 */

interface HermesJob {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  deliver: string | null;
  scheduleDisplay: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

const POLL_MS = 60_000;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json();
  if (!res.ok || body?.error) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Relative time that stays readable at a glance in a small panel. */
function whenLabel(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMin = Math.round((then - Date.now()) / 60000);
  const ahead = diffMin >= 0;
  const mins = Math.abs(diffMin);
  const text =
    mins < 1 ? 'now' : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  if (text === 'now') return 'now';
  return ahead ? `in ${text}` : `${text} ago`;
}

export function HermesSchedulesWidget() {
  const [jobs, setJobs] = useState<HermesJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [prompt, setPrompt] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const data = await api<{ jobs: HermesJob[] }>('/api/hermes/jobs');
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    timerRef.current = setInterval(() => void load(), POLL_MS);
    return () => {
      clearTimeout(first);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  const toggle = async (job: HermesJob) => {
    setBusy(job.id);
    try {
      await api(`/api/hermes/jobs/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (job: HermesJob) => {
    setBusy(job.id);
    try {
      await api(`/api/hermes/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!name.trim() || !schedule.trim()) return;
    setBusy('new');
    try {
      await api('/api/hermes/jobs', {
        method: 'POST',
        body: JSON.stringify({ name, schedule, prompt }),
      });
      setName(''); setSchedule(''); setPrompt(''); setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">
        Hermes schedules
      </div>

      <div data-no-drag className="flex-1 overflow-y-auto space-y-1 pr-1">
        {error && <div className="text-red-400/90 break-words">{error}</div>}
        {jobs.length === 0 && !error && !adding && (
          <div className="text-white/40 italic">Nothing scheduled.</div>
        )}

        {jobs.map((job) => (
          <div key={job.id} className="px-2 py-1.5 rounded border border-white/10">
            <div className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${job.enabled ? 'bg-emerald-400' : 'bg-white/25'}`}
              />
              <span className={`truncate ${job.enabled ? 'text-cyan-300' : 'text-white/45'}`}>
                {job.name}
              </span>
              <span className="ml-auto text-white/25 text-[10px] shrink-0">
                {job.scheduleDisplay}
              </span>
            </div>

            <div className="flex items-center gap-2 mt-1 text-[10px] text-white/30">
              <span>next {whenLabel(job.nextRunAt)}</span>
              {job.lastRunAt && <span>ran {whenLabel(job.lastRunAt)}</span>}
              {job.lastStatus && (
                <span className={job.lastError ? 'text-red-300/70' : ''}>{job.lastStatus}</span>
              )}
              <button
                onClick={() => void toggle(job)}
                disabled={busy !== null}
                className="ml-auto uppercase tracking-wider hover:text-cyan-300 disabled:opacity-30"
              >
                {job.enabled ? 'pause' : 'resume'}
              </button>
              <button
                onClick={() => void remove(job)}
                disabled={busy !== null}
                className="uppercase tracking-wider hover:text-red-300 disabled:opacity-30"
              >
                delete
              </button>
            </div>

            {job.lastError && (
              <div className="mt-1 text-[10px] text-red-300/70 break-words">{job.lastError}</div>
            )}
          </div>
        ))}

        {adding && (
          <div className="space-y-1 pt-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name"
              className="w-full bg-white/5 border border-white/10 focus:border-cyan-400/60 rounded px-2 py-1 outline-none text-white/90 placeholder:text-white/25"
            />
            <input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="30m · every 2h · 0 9 * * *"
              className="w-full bg-white/5 border border-white/10 focus:border-cyan-400/60 rounded px-2 py-1 outline-none text-white/90 placeholder:text-white/25"
            />
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
                if (e.key === 'Escape') setAdding(false);
              }}
              placeholder="what should Hermes do?"
              className="w-full bg-white/5 border border-white/10 focus:border-cyan-400/60 rounded px-2 py-1 outline-none text-white/90 placeholder:text-white/25"
            />
            <button
              onClick={() => void create()}
              disabled={!name.trim() || !schedule.trim() || busy !== null}
              className="px-2 py-1 rounded border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-30 uppercase tracking-wider text-[10px]"
            >
              {busy === 'new' ? 'creating…' : 'create'}
            </button>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => void load()}
          className="text-[10px] uppercase tracking-wider text-white/40 hover:text-cyan-300"
        >
          ↻ refresh
        </button>
        <button
          onClick={() => setAdding((v) => !v)}
          className="text-[10px] uppercase tracking-wider text-white/40 hover:text-cyan-300"
        >
          {adding ? 'cancel' : '+ new job'}
        </button>
      </div>
    </div>
  );
}
