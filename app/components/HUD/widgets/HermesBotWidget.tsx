'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A live window into one local Hermes agent session, rendered as a HUD widget.
 *
 * Talks to Camille's own /api/hermes/sessions* routes, which proxy the
 * Hermes API Server's /api/sessions resource (not the messaging-platform
 * gateway). That means every local session shows up here — CLI, desktop,
 * cron, API-created — with no Telegram/Discord/etc. platform required.
 *
 * Several instances can coexist, each bound to a different session, so
 * the dashboard can show a whole crew of local Hermes tasks at once.
 */

interface HermesSessionSummary {
  id: string;
  source: string;
  title: string;
  messageCount: number;
}

interface HermesMessage {
  role: string;
  content: string;
  reasoning?: string | null;
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body?.error) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

async function apiPost<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok || body?.error) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

function sessionLabel(s: HermesSessionSummary): string {
  return s.title?.trim() || s.id;
}

function isBot(m: HermesMessage): boolean {
  return m.role.toLowerCase().includes('assistant');
}

/**
 * Reasoning is collapsed by default — this widget is a compact HUD panel,
 * not a full transcript viewer, and raw thinking traces (which can run to
 * hundreds of words per turn) drown out the actual answer. Click to expand.
 */
function ReasoningDisclosure({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] uppercase tracking-wider text-white/35 hover:text-cyan-300/80 transition-colors"
      >
        {open ? '▾ hide reasoning' : '▸ reasoning'}
      </button>
      {open && (
        <div className="mt-1 px-2 py-1 rounded border border-white/10 bg-white/[0.03] text-white/50 italic whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  );
}

const POLL_MS = 4000;

export function HermesBotWidget({ widgetId }: { widgetId: string }) {
  const storageKey = `camille_hermes_bot_${widgetId}`;
  const [sessions, setSessions] = useState<HermesSessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string>('');
  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Restore this widget's bound session.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as
        | { id: string; name: string }
        | null;
      if (saved?.id) {
        setSelected(saved.id);
        setSelectedName(saved.name ?? saved.id);
      }
    } catch {
      // First run for this widget.
    }
  }, [storageKey]);

  const loadSessions = useCallback(async () => {
    try {
      const data = await apiGet<{ sessions: HermesSessionSummary[] }>('/api/hermes/sessions');
      setSessions(data.sessions ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!selected) void loadSessions();
  }, [selected, loadSessions]);

  const refreshMessages = useCallback(async (id: string) => {
    try {
      const data = await apiGet<{ messages: HermesMessage[] }>(
        `/api/hermes/sessions/${encodeURIComponent(id)}/messages`,
      );
      setMessages(data.messages ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Poll the transcript while bound.
  useEffect(() => {
    if (!selected) return;
    void refreshMessages(selected);
    pollRef.current = setInterval(() => void refreshMessages(selected), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selected, refreshMessages]);

  // Keep the transcript pinned to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const bind = (s: HermesSessionSummary) => {
    const name = sessionLabel(s);
    setSelected(s.id);
    setSelectedName(name);
    setMessages([]);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ id: s.id, name }));
    } catch {
      // Storage full or unavailable; binding just won't survive a reload.
    }
  };

  const unbind = () => {
    setSelected(null);
    setSelectedName('');
    setMessages([]);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Ignore.
    }
    void loadSessions();
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !selected || sending) return;
    setSending(true);
    setDraft('');
    // Optimistic echo so the widget feels instant.
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    try {
      await apiPost(`/api/hermes/sessions/${encodeURIComponent(selected)}/messages`, { message: text });
      setTimeout(() => void refreshMessages(selected), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  // ── Session picker ──
  if (!selected) {
    return (
      <div className="flex flex-col h-full text-xs">
        <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">
          Bind this widget to a local Hermes session
        </div>
        <div data-no-drag className="flex-1 overflow-y-auto space-y-1 pr-1">
          {sessions.length === 0 && !error && (
            <div className="text-white/40 italic">Looking for Hermes sessions…</div>
          )}
          {error && <div className="text-red-400/90 break-words">{error}</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => bind(s)}
              className="w-full text-left px-2 py-1.5 rounded border border-white/10 hover:border-cyan-400/60 hover:bg-cyan-400/10 transition-colors"
            >
              <span className="text-cyan-300">{sessionLabel(s)}</span>
              {s.source && <span className="text-white/30 ml-2">{s.source}</span>}
            </button>
          ))}
        </div>
        <button
          onClick={() => void loadSessions()}
          className="mt-2 text-[10px] uppercase tracking-wider text-white/40 hover:text-cyan-300 self-start"
        >
          ↻ refresh
        </button>
      </div>
    );
  }

  // ── Bound: live transcript + input ──
  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="text-cyan-300 truncate">{selectedName}</span>
        </div>
        <button
          onClick={unbind}
          className="text-[10px] text-white/30 hover:text-white/70 uppercase tracking-wider shrink-0"
        >
          switch
        </button>
      </div>

      <div ref={scrollRef} data-no-drag className="flex-1 overflow-y-auto space-y-1.5 pr-1">
        {messages.length === 0 && !error && (
          <div className="text-white/40 italic">No messages yet — say something below.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={isBot(m) ? '' : 'ml-auto max-w-[92%]'}>
            {isBot(m) && m.reasoning && <ReasoningDisclosure text={m.reasoning} />}
            {m.content && (
              <div
                className={`px-2 py-1 rounded max-w-[92%] whitespace-pre-wrap break-words leading-snug ${
                  isBot(m)
                    ? 'bg-cyan-400/10 border border-cyan-400/20 text-white/90'
                    : 'bg-white/5 border border-white/10 text-white/70 ml-auto'
                }`}
              >
                {m.content}
              </div>
            )}
          </div>
        ))}
        {error && <div className="text-red-400/90 break-words">{error}</div>}
      </div>

      <div className="mt-1.5 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={sending ? 'sending…' : 'Message this session…'}
          className="flex-1 bg-white/5 border border-white/10 focus:border-cyan-400/60 rounded px-2 py-1.5 outline-none text-white/90 placeholder:text-white/25"
        />
        <button
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
          className="px-2.5 rounded border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-30 uppercase tracking-wider text-[10px]"
        >
          send
        </button>
      </div>
    </div>
  );
}

