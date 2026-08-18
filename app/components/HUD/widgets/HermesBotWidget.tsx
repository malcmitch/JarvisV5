'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { streamHermesChat } from '../../../lib/hermes-stream';

/**
 * A live window into one local Hermes agent session, rendered as a HUD widget.
 *
 * Reads (session list, transcript history) go through Camille's
 * /api/hermes/sessions* routes, which proxy the Hermes API Server's
 * /api/sessions resource. Sends go through /api/hermes/stream — the
 * /v1/chat/completions SSE path bound to this session via the
 * X-Hermes-Session-Id header — so replies render token-by-token with live
 * tool status, and long agent runs can be cancelled mid-flight.
 *
 * Several instances can coexist, each bound to a different session on a
 * different Hermes profile, so the dashboard can show a whole crew of local
 * agents at once.
 */

interface HermesProfileInfo {
  name: string;
  port: number;
  hasKey: boolean;
  online: boolean;
  reason: string | null;
}

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

function sessionLabel(s: HermesSessionSummary): string {
  return s.title?.trim() || s.id;
}

function isBot(m: HermesMessage): boolean {
  return m.role.toLowerCase().includes('assistant');
}

/**
 * Hermes stores tool calls and their results as their own messages in session
 * history (role "tool" / "function" / "tool_result"). Rendering those as chat
 * bubbles dumps raw JSON like {"output": "done", "exit_code": 0} into the
 * transcript as if the user had typed it. They're activity, not conversation,
 * so they get a compact status line instead.
 */
function isToolMessage(m: HermesMessage): boolean {
  const role = m.role.toLowerCase();
  return role.includes('tool') || role.includes('function');
}

/** One-line, non-JSON summary of a tool-result payload. */
function toolSummary(content: string): string {
  const text = content.trim();
  if (!text) return 'tool result';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const exit = parsed.exit_code;
    const err = parsed.error;
    if (typeof err === 'string' && err) return `tool error: ${err}`;
    if (typeof exit === 'number') return exit === 0 ? 'tool ran successfully' : `tool exited ${exit}`;
    return 'tool result received';
  } catch {
    // Not JSON — show a short prefix rather than a wall of output.
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }
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
  const [profiles, setProfiles] = useState<HermesProfileInfo[]>([]);
  const [profile, setProfile] = useState<string | null>(null);
  const [sessions, setSessions] = useState<HermesSessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string>('');
  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamStatus, setStreamStatus] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Restore this widget's bound profile + session.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as
        | { id: string; name: string; profile?: string }
        | null;
      if (saved?.profile) setProfile(saved.profile);
      if (saved?.id) {
        setSelected(saved.id);
        setSelectedName(saved.name ?? saved.id);
      }
    } catch {
      // First run for this widget.
    }
  }, [storageKey]);

  const loadProfiles = useCallback(async () => {
    try {
      const data = await apiGet<{ profiles: HermesProfileInfo[] }>('/api/hermes/profiles');
      setProfiles(data.profiles ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      const data = await apiGet<{ sessions: HermesSessionSummary[] }>(`/api/hermes/sessions${q}`);
      setSessions(data.sessions ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [profile]);

  useEffect(() => {
    if (!profile) void loadProfiles();
  }, [profile, loadProfiles]);

  useEffect(() => {
    if (profile && !selected) void loadSessions();
  }, [profile, selected, loadSessions]);

  const refreshMessages = useCallback(async (id: string) => {
    try {
      const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      const data = await apiGet<{ messages: HermesMessage[] }>(
        `/api/hermes/sessions/${encodeURIComponent(id)}/messages${q}`,
      );
      setMessages(data.messages ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [profile]);

  // Poll the transcript while bound.
  useEffect(() => {
    if (!selected) return;
    void refreshMessages(selected);
    pollRef.current = setInterval(() => {
      if (!streamingRef.current) void refreshMessages(selected);
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      abortRef.current?.abort();
    };
  }, [selected, refreshMessages]);

  // Keep the transcript pinned to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamText, streamStatus]);

  const bind = (s: HermesSessionSummary) => {
    const name = sessionLabel(s);
    setSelected(s.id);
    setSelectedName(name);
    setMessages([]);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ id: s.id, name, profile }));
    } catch {
      // Storage full or unavailable; binding just won't survive a reload.
    }
  };

  const switchProfile = () => {
    setSelected(null);
    setSelectedName('');
    setMessages([]);
    setProfile(null);
    setSessions([]);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Ignore.
    }
    void loadProfiles();
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
    setError(null);
    setStreamText('');
    setStreamStatus([]);
    streamingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    // Optimistic echo so the widget feels instant.
    setMessages((prev) => [...prev, { role: 'user', content: text }]);

    let acc = '';
    let failed = false;
    await streamHermesChat({
      prompt: text,
      sessionId: selected,
      profile: profile ?? undefined,
      signal: controller.signal,
      onDelta: (t) => {
        acc += t;
        setStreamText(acc);
      },
      onToolEvent: (evt) => {
        const label =
          evt.kind === 'tool_calls'
            ? 'tool call…'
            : typeof (evt.payload as { step?: unknown })?.step === 'string'
              ? String((evt.payload as { step: string }).step)
              : evt.kind;
        setStreamStatus((prev) => (prev[prev.length - 1] === label ? prev : [...prev, label]));
      },
      onDone: (full) => {
        if (full) setMessages((prev) => [...prev, { role: 'assistant', content: full }]);
      },
      onError: (message, code) => {
        if (code === 'cancelled') {
          if (acc) setMessages((prev) => [...prev, { role: 'assistant', content: acc + ' …[cancelled]' }]);
        } else {
          failed = true;
          setError(message);
        }
      },
    });

    streamingRef.current = false;
    abortRef.current = null;
    setStreamText('');
    setStreamStatus([]);
    setSending(false);
    // Reconcile with Hermes's stored transcript (ids, reasoning, ordering).
    // On failure, skip it: refreshMessages() clears `error` on success, which
    // would wipe the message the user needs to read a beat after it appears.
    if (!failed) void refreshMessages(selected);
  };

  const cancel = () => abortRef.current?.abort();

  // ── Profile picker ──
  if (!profile) {
    return (
      <div className="flex flex-col h-full text-xs">
        <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">
          Pick a Hermes profile
        </div>
        <div data-no-drag className="flex-1 overflow-y-auto space-y-1 pr-1">
          {profiles.length === 0 && !error && (
            <div className="text-white/40 italic">Looking for Hermes profiles…</div>
          )}
          {error && <div className="text-red-400/90 break-words">{error}</div>}
          {profiles.map((p) => (
            <button
              key={p.name}
              onClick={() => setProfile(p.name)}
              disabled={!p.online}
              className="w-full text-left px-2 py-1.5 rounded border border-white/10 enabled:hover:border-cyan-400/60 enabled:hover:bg-cyan-400/10 disabled:opacity-40 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.online ? 'bg-emerald-400' : 'bg-white/25'}`}
                />
                <span className={p.online ? 'text-cyan-300' : 'text-white/50'}>{p.name}</span>
                <span className="text-white/25 ml-auto text-[10px]">
                  {p.online ? `:${p.port}` : (p.reason ?? 'offline')}
                </span>
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={() => void loadProfiles()}
          className="mt-2 text-[10px] uppercase tracking-wider text-white/40 hover:text-cyan-300 self-start"
        >
          ↻ refresh
        </button>
      </div>
    );
  }

  // ── Session picker ──
  if (!selected) {
    return (
      <div className="flex flex-col h-full text-xs">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-widest text-white/40">
            Session on <span className="text-cyan-300/80">{profile}</span>
          </div>
          <button
            onClick={switchProfile}
            className="text-[10px] uppercase tracking-wider text-white/30 hover:text-white/70"
          >
            profile
          </button>
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
          <span className="text-white/25 text-[10px] shrink-0">{profile}</span>
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
        {messages.map((m, i) =>
          isToolMessage(m) ? (
            <div
              key={i}
              className="text-[10px] uppercase tracking-wider text-amber-300/60 pl-1"
              title={m.content}
            >
              ▸ {toolSummary(m.content)}
            </div>
          ) : (
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
          ),
        )}
        {sending && (
          <div>
            {streamStatus.length > 0 && (
              <div className="text-[10px] uppercase tracking-wider text-amber-300/70 mb-0.5">
                {streamStatus[streamStatus.length - 1]}
              </div>
            )}
            <div className="px-2 py-1 rounded max-w-[92%] whitespace-pre-wrap break-words leading-snug bg-cyan-400/10 border border-cyan-400/20 text-white/90">
              {streamText || <span className="text-white/40 italic">Hermes is working…</span>}
              <span className="inline-block w-1.5 h-3 ml-0.5 bg-cyan-300/80 animate-pulse align-middle" />
            </div>
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
          placeholder={sending ? 'Hermes is responding…' : 'Message this session…'}
          className="flex-1 bg-white/5 border border-white/10 focus:border-cyan-400/60 rounded px-2 py-1.5 outline-none text-white/90 placeholder:text-white/25"
        />
        {sending ? (
          <button
            onClick={cancel}
            className="px-2.5 rounded border border-red-400/40 text-red-300 hover:bg-red-400/10 uppercase tracking-wider text-[10px]"
          >
            stop
          </button>
        ) : (
          <button
            onClick={() => void send()}
            disabled={!draft.trim()}
            className="px-2.5 rounded border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-30 uppercase tracking-wider text-[10px]"
          >
            send
          </button>
        )}
      </div>
    </div>
  );
}
