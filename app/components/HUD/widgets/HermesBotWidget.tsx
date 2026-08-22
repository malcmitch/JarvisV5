'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A live window into one Hermes session, rendered as a HUD widget.
 *
 * Runs on the same engine as the Hermes Command page: the authenticated
 * /api/hermes-core proxy into the Hermes WebUI API. Pick any session (bots,
 * gateway line, chats, agents), and this widget becomes a small streaming
 * chat bound to it — replies arrive token-by-token over SSE, and the
 * transcript refreshes in the background so activity from other surfaces
 * (Hermes desktop, iMessage bots, crons) shows up too.
 *
 * Several instances can coexist, each bound to a different session, so the
 * dashboard can show a whole crew of bots working at once.
 */

const CORE = '/api/hermes-core';
const REFRESH_MS = 8000;

interface HermesSession {
  session_id?: string;
  id?: string;
  title?: string;
  updated_at?: number | string;
  created_at?: number | string;
  source_tag?: string;
  session_source?: string;
  source_label?: string;
  archived?: boolean;
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
  return (s.title ?? sessionId(s) ?? 'untitled').toString();
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

function toMillis(v: number | string | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Crons flood the picker; everything else is fair game for a widget. */
function isPickable(s: HermesSession): boolean {
  const src = (s.session_source ?? '').toLowerCase();
  const tag = (s.source_tag ?? '').toLowerCase();
  return src !== 'cron' && tag !== 'cron' && !s.archived;
}

async function adoptSession(id: string): Promise<void> {
  // Agent-side sessions must be imported into the WebUI store before
  // /api/session and /api/chat/start accept them; cheap refresh otherwise.
  await fetch(`${CORE}/api/session/import_cli`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: id }),
  }).catch(() => undefined);
}

export function HermesBotWidget({ widgetId }: { widgetId: string }) {
  const storageKey = `camille_hermes_bot_${widgetId}`;
  const [sessions, setSessions] = useState<HermesSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [messages, setMessages] = useState<CoreMessage[]>([]);
  const [live, setLive] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const sendingRef = useRef(false);

  // Restore this widget's bound session.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as
        | { key: string; name: string }
        | null;
      if (saved?.key) {
        setSelected(saved.key);
        setSelectedName(saved.name ?? saved.key);
      }
    } catch {
      // First run for this widget.
    }
  }, [storageKey]);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch(`${CORE}/api/sessions`);
      if (!res.ok) throw new Error(`sessions ${res.status}`);
      const data = (await res.json()) as HermesSession[] | { sessions?: HermesSession[] };
      const list = Array.isArray(data) ? data : (data.sessions ?? []);
      setSessions(
        list
          .filter((s) => sessionId(s) && isPickable(s))
          .sort((a, b) => Math.max(toMillis(b.updated_at), toMillis(b.created_at)) - Math.max(toMillis(a.updated_at), toMillis(a.created_at)))
          .slice(0, 40),
      );
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
      const res = await fetch(
        `${CORE}/api/session?session_id=${encodeURIComponent(id)}&messages=1&msg_limit=30`,
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

  // Adopt + load on bind, then keep the transcript fresh while idle.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void (async () => {
      await adoptSession(selected);
      if (!cancelled) void refreshMessages(selected);
    })();
    const t = setInterval(() => {
      if (!sendingRef.current) void refreshMessages(selected);
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selected, refreshMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, live]);

  useEffect(() => () => sourceRef.current?.close(), []);

  const bind = (s: HermesSession) => {
    const key = sessionId(s);
    const name = sessionTitle(s);
    setSelected(key);
    setSelectedName(name);
    setMessages([]);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ key, name }));
    } catch {
      // Binding just won't survive a reload.
    }
  };

  const unbind = () => {
    sourceRef.current?.close();
    setSelected(null);
    setSelectedName('');
    setMessages([]);
    setLive(null);
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
    sendingRef.current = true;
    setDraft('');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setLive('');
    try {
      const start = () =>
        fetch(`${CORE}/api/chat/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: selected, message: text }),
        });
      let res = await start();
      if (res.status === 404) {
        await adoptSession(selected);
        res = await start();
      }
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
        setSending(false);
        sendingRef.current = false;
        setLive(null);
        if (acc.trim()) setMessages((prev) => [...prev, { role: 'assistant', content: acc }]);
        setTimeout(() => void refreshMessages(selected), 1500);
      };
      source.addEventListener('done', finish);
      source.addEventListener('complete', finish);
      source.onerror = () => finish();
    } catch (err) {
      setSending(false);
      sendingRef.current = false;
      setLive(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Session picker ──
  if (!selected) {
    return (
      <div className="flex flex-col h-full text-xs">
        <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">
          Bind this widget to a Hermes session
        </div>
        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {sessions.length === 0 && !error && (
            <div className="text-white/40 italic">Reaching Hermes…</div>
          )}
          {error && <div className="text-red-400/90 break-words">{error}</div>}
          {sessions.map((s) => (
            <button
              key={sessionId(s)}
              onClick={() => bind(s)}
              className="w-full text-left px-2 py-1.5 rounded border border-white/10 hover:border-cyan-400/60 hover:bg-cyan-400/10 transition-colors"
            >
              <span className="text-cyan-300">{sessionTitle(s)}</span>
              {s.source_label && <span className="text-white/30 ml-2">{s.source_label}</span>}
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

  // ── Bound: live transcript + streaming input ──
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

      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-1.5 pr-1">
        {messages.length === 0 && live === null && !error && (
          <div className="text-white/40 italic">No messages yet — say something below.</div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`px-2 py-1 rounded max-w-[92%] whitespace-pre-wrap break-words leading-snug ${
              m.role === 'assistant'
                ? 'bg-cyan-400/10 border border-cyan-400/20 text-white/90'
                : 'bg-white/5 border border-white/10 text-white/70 ml-auto'
            }`}
          >
            {messageText(m)}
          </div>
        ))}
        {live !== null && (
          <div className="px-2 py-1 rounded max-w-[92%] whitespace-pre-wrap break-words leading-snug bg-cyan-400/10 border border-cyan-400/30 text-white/90">
            {live || <span className="text-cyan-300/70 animate-pulse">thinking…</span>}
            <span className="inline-block w-1 h-3 ml-0.5 bg-cyan-300/80 animate-pulse align-middle" />
          </div>
        )}
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
          placeholder={sending ? 'Hermes is thinking…' : 'Message this session…'}
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
