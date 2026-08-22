'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hermes Command — the fusion page.
 *
 * Hermes's sessions and chat rendered NATIVELY in Camille's design language,
 * powered by the Hermes WebUI API through the authenticated /api/hermes-core
 * proxy. Live turns stream token-by-token over SSE. The old full-dashboard
 * iframe survives as a "classic" toggle for everything not yet native
 * (kanban, skills, settings) until each piece gets promoted.
 */

const CORE = '/api/hermes-core';
const CLASSIC_URL = 'http://localhost:8799';

interface HermesSession {
  session_id?: string;
  id?: string;
  title?: string;
  preview?: string;
  last_active?: string;
  updated_at?: string;
  kind?: string;
  origin?: string;
  message_count?: number;
}

interface CoreMessage {
  role?: string;
  content?: unknown;
  text?: string;
}

function sessionId(s: HermesSession): string {
  return s.session_id ?? s.id ?? '';
}

function sessionTitle(s: HermesSession): string {
  return (s.title ?? s.preview ?? sessionId(s) ?? 'untitled').toString();
}

function messageText(m: CoreMessage): string {
  const c = m.content ?? m.text ?? '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) =>
        typeof part === 'string'
          ? part
          : ((part as { text?: string; content?: string })?.text ??
             (part as { text?: string; content?: string })?.content ??
             ''),
      )
      .join('');
  }
  return JSON.stringify(c);
}

/** Group sessions the way the Hermes sidebar does: Today / Yesterday / Earlier. */
function groupLabel(s: HermesSession): string {
  const raw = s.last_active ?? s.updated_at;
  if (!raw) return 'Earlier';
  const then = new Date(raw);
  if (Number.isNaN(then.getTime())) return 'Earlier';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (then >= startOfToday) return 'Today';
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  if (then >= startOfYesterday) return 'Yesterday';
  return 'Earlier';
}

export function HermesPage({ onNavigateHome }: { onNavigateHome: () => void }) {
  const [classic, setClassic] = useState(false);
  const [sessions, setSessions] = useState<HermesSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState('');
  const [messages, setMessages] = useState<CoreMessage[]>([]);
  const [live, setLive] = useState<string | null>(null); // streaming turn text
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch(`${CORE}/api/sessions`);
      if (!res.ok) throw new Error(`sessions ${res.status}`);
      const data = (await res.json()) as HermesSession[] | { sessions?: HermesSession[] };
      const list = Array.isArray(data) ? data : (data.sessions ?? []);
      setSessions(list.filter((s) => sessionId(s)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    const t = setInterval(() => void loadSessions(), 12_000);
    return () => clearInterval(t);
  }, [loadSessions]);

  const openSession = useCallback(async (id: string, title: string) => {
    sourceRef.current?.close();
    setActiveId(id);
    setActiveTitle(title);
    setMessages([]);
    setLive(null);
    try {
      const res = await fetch(
        `${CORE}/api/session?session_id=${encodeURIComponent(id)}&messages=1&msg_limit=60`,
      );
      if (!res.ok) throw new Error(`session ${res.status}`);
      const data = (await res.json()) as { messages?: CoreMessage[]; session?: { messages?: CoreMessage[] } };
      const msgs = data.messages ?? data.session?.messages ?? [];
      setMessages(
        msgs.filter((m) => {
          const role = (m.role ?? '').toString();
          return (role === 'user' || role === 'assistant') && messageText(m).trim().length > 0;
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, live]);

  useEffect(() => () => sourceRef.current?.close(), []);

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || busy) return;
    setBusy(true);
    setDraft('');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setLive('');
    try {
      const res = await fetch(`${CORE}/api/chat/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: activeId, message: text }),
      });
      const data = (await res.json().catch(() => ({}))) as { stream_id?: string; error?: string };
      if (!res.ok || !data.stream_id) {
        throw new Error(data.error ?? `chat/start ${res.status}`);
      }
      const source = new EventSource(
        `${CORE}/api/chat/stream?stream_id=${encodeURIComponent(data.stream_id)}`,
      );
      sourceRef.current = source;
      let acc = '';
      const takeText = (raw: string): string => {
        try {
          const parsed = JSON.parse(raw) as { text?: string; token?: string; delta?: string; content?: string };
          return parsed.text ?? parsed.token ?? parsed.delta ?? parsed.content ?? '';
        } catch {
          return raw;
        }
      };
      source.addEventListener('token', (e) => {
        acc += takeText((e as MessageEvent).data as string);
        setLive(acc);
      });
      const finish = () => {
        source.close();
        sourceRef.current = null;
        setBusy(false);
        setLive(null);
        if (acc.trim()) setMessages((prev) => [...prev, { role: 'assistant', content: acc }]);
        // Pull the canonical transcript shortly after, so tool calls and
        // formatting the stream didn't carry still end up correct.
        setTimeout(() => void openSession(activeId, activeTitle), 1500);
      };
      source.addEventListener('done', finish);
      source.addEventListener('complete', finish);
      source.onerror = () => {
        // EventSource fires error on normal server close too.
        finish();
      };
    } catch (err) {
      setBusy(false);
      setLive(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Classic (full dashboard) view ──
  if (classic) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-black">
        <div className="flex items-center justify-between px-4 py-2 border-b border-cyan-400/20 bg-black/80">
          <div className="flex items-center gap-3">
            <button onClick={onNavigateHome} className="text-cyan-400/80 hover:text-cyan-300 text-xs uppercase tracking-widest">← Camille</button>
            <span className="text-white/30 text-xs uppercase tracking-widest">Hermes · Classic</span>
          </div>
          <button onClick={() => setClassic(false)} className="text-white/30 hover:text-cyan-300 text-xs uppercase tracking-widest">native view</button>
        </div>
        <iframe src={CLASSIC_URL} className="flex-1 w-full border-0 bg-[#0a0e14]" title="Hermes dashboard" />
      </div>
    );
  }

  // ── Native command view ──
  const groups: Record<string, HermesSession[]> = {};
  for (const s of sessions) {
    (groups[groupLabel(s)] ??= []).push(s);
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <div className="flex items-center justify-between px-4 py-2 border-b border-cyan-400/20 bg-black/80">
        <div className="flex items-center gap-3">
          <button onClick={onNavigateHome} className="text-cyan-400/80 hover:text-cyan-300 text-xs uppercase tracking-widest">← Camille</button>
          <span className="text-cyan-300/90 text-xs uppercase tracking-[0.3em]">Hermes Command</span>
        </div>
        <button onClick={() => setClassic(true)} className="text-white/30 hover:text-cyan-300 text-xs uppercase tracking-widest">classic view</button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Session rail */}
        <div className="w-72 shrink-0 border-r border-cyan-400/10 overflow-y-auto py-2">
          {error && <div className="px-3 py-2 text-xs text-red-400/90 break-words">{error}</div>}
          {(['Today', 'Yesterday', 'Earlier'] as const).map((label) =>
            groups[label]?.length ? (
              <div key={label}>
                <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.25em] text-white/25">{label}</div>
                {groups[label].map((s) => {
                  const id = sessionId(s);
                  return (
                    <button
                      key={id}
                      onClick={() => void openSession(id, sessionTitle(s))}
                      className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors ${
                        id === activeId
                          ? 'text-cyan-300 bg-cyan-400/10 border-l-2 border-cyan-400'
                          : 'text-white/60 hover:text-white/90 hover:bg-white/5 border-l-2 border-transparent'
                      }`}
                      title={sessionTitle(s)}
                    >
                      {sessionTitle(s)}
                    </button>
                  );
                })}
              </div>
            ) : null,
          )}
          {sessions.length === 0 && !error && (
            <div className="px-3 py-3 text-xs text-white/40 italic">Reaching Hermes…</div>
          )}
        </div>

        {/* Chat pane */}
        <div className="flex-1 flex flex-col min-w-0">
          {!activeId ? (
            <div className="flex-1 flex items-center justify-center text-white/30 text-sm">
              Pick a session — or ask Camille to open one.
            </div>
          ) : (
            <>
              <div className="px-4 py-2 text-xs text-white/40 border-b border-white/5 truncate">{activeTitle}</div>
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={`px-3 py-2 rounded max-w-[85%] whitespace-pre-wrap break-words text-sm leading-relaxed ${
                      m.role === 'assistant'
                        ? 'bg-cyan-400/5 border border-cyan-400/15 text-white/90'
                        : 'bg-white/5 border border-white/10 text-white/75 ml-auto'
                    }`}
                  >
                    {messageText(m)}
                  </div>
                ))}
                {live !== null && (
                  <div className="px-3 py-2 rounded max-w-[85%] whitespace-pre-wrap break-words text-sm leading-relaxed bg-cyan-400/5 border border-cyan-400/25 text-white/90">
                    {live || <span className="text-cyan-300/70 animate-pulse">thinking…</span>}
                    <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-cyan-300/80 animate-pulse align-middle" />
                  </div>
                )}
              </div>
              <div className="p-3 border-t border-white/5 flex gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  placeholder={busy ? 'Hermes is thinking…' : 'Message Hermes…'}
                  className="flex-1 resize-none bg-white/5 border border-white/10 focus:border-cyan-400/60 rounded px-3 py-2 outline-none text-sm text-white/90 placeholder:text-white/25"
                />
                <button
                  onClick={() => void send()}
                  disabled={busy || !draft.trim()}
                  className="px-4 rounded border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-30 uppercase tracking-wider text-xs"
                >
                  send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
