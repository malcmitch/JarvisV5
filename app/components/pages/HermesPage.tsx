'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Hermes Command — the fusion page.
 *
 * Hermes's sessions and chat rendered NATIVELY in Camille's design language,
 * powered by the Hermes WebUI API through the authenticated /api/hermes-core
 * proxy. Live turns stream token-by-token over SSE.
 *
 * The session rail is organized the way the agent actually works — profiles
 * across the top, then sessions grouped by what they ARE (direct line, bots,
 * chats, agents, automations) instead of one chronological flood where 200
 * cron runs bury everything else. The old full-dashboard iframe survives as
 * a "classic" toggle until every piece is promoted native.
 */

const CORE = '/api/hermes-core';
const CLASSIC_URL = 'http://localhost:8799';

interface HermesSession {
  session_id?: string;
  id?: string;
  title?: string;
  preview?: string;
  last_active?: string;
  updated_at?: number | string;
  created_at?: number | string;
  message_count?: number;
  profile?: string;
  source_tag?: string;
  session_source?: string;
  source_label?: string;
  is_streaming?: boolean;
  archived?: boolean;
}

interface HermesProfile {
  name: string;
  is_active?: boolean;
  is_default?: boolean;
  gateway_running?: boolean;
  model?: string;
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

/** Section assignment: what a session IS, from Hermes's own source tagging. */
const SECTIONS = [
  { key: 'direct', label: 'Camille Line', hint: 'gateway messages from this app' },
  { key: 'bots', label: 'Bots', hint: 'messaging platforms' },
  { key: 'chats', label: 'Chats', hint: 'WebUI + desktop conversations' },
  { key: 'agents', label: 'Agents', hint: 'subagents & external agents' },
  { key: 'crons', label: 'Automations', hint: 'scheduled runs' },
  { key: 'other', label: 'Other', hint: '' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

function sectionOf(s: HermesSession): SectionKey {
  const tag = (s.source_tag ?? '').toLowerCase();
  const src = (s.session_source ?? '').toLowerCase();
  if (tag === 'webhook') return 'direct';
  if (src === 'messaging' || ['photon', 'telegram', 'whatsapp', 'imessage', 'slack', 'discord'].includes(tag)) return 'bots';
  if (['webui', 'desktop', 'cli'].includes(tag)) return 'chats';
  if (src === 'external_agent' || src === 'fork' || ['subagent', 'claude_code', 'api_server'].includes(tag)) return 'agents';
  if (src === 'cron' || tag === 'cron') return 'crons';
  return 'other';
}

function toMillis(v: number | string | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function lastActivity(s: HermesSession): number {
  return Math.max(toMillis(s.updated_at), toMillis(s.created_at));
}

function relTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function HermesPage({ onNavigateHome }: { onNavigateHome: () => void }) {
  const [classic, setClassic] = useState(false);
  const [sessions, setSessions] = useState<HermesSession[]>([]);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [pickedProfile, setPickedProfile] = useState<string | null>(null); // null = Hermes's active profile
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({
    direct: true, bots: true, chats: true, agents: true, crons: false, other: false,
  });
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
      setSessions(list.filter((s) => sessionId(s) && !s.archived));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${CORE}/api/profiles`);
      if (!res.ok) return;
      const data = (await res.json()) as { profiles?: HermesProfile[] };
      setProfiles((data.profiles ?? []).filter((p) => p.name));
    } catch {
      // Profiles are decoration; the rail works without them.
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadProfiles();
    const t = setInterval(() => {
      void loadSessions();
    }, 12_000);
    const tp = setInterval(() => {
      void loadProfiles();
    }, 60_000);
    return () => {
      clearInterval(t);
      clearInterval(tp);
    };
  }, [loadSessions, loadProfiles]);

  const openSession = useCallback(async (id: string, title: string) => {
    sourceRef.current?.close();
    setActiveId(id);
    setActiveTitle(title);
    setMessages([]);
    setLive(null);
    try {
      // Agent-side (CLI/gateway/cron) sessions live outside the WebUI store;
      // importing adopts them so /api/session and /api/chat/start work. For
      // sessions already in the store this is a cheap metadata refresh.
      await fetch(`${CORE}/api/session/import_cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      }).catch(() => undefined);
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

  /** Start a fresh session under the picked profile and open it. */
  const newChat = useCallback(async () => {
    try {
      const res = await fetch(`${CORE}/api/session/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pickedProfile ? { profile: pickedProfile } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        session_id?: string;
        session?: { session_id?: string };
        error?: string;
      };
      const id = data.session_id ?? data.session?.session_id;
      if (!res.ok || !id) throw new Error(data.error ?? `session/new ${res.status}`);
      setActiveId(id);
      setActiveTitle(`New chat${pickedProfile ? ` · ${pickedProfile}` : ''}`);
      setMessages([]);
      setLive(null);
      setError(null);
      void loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pickedProfile, loadSessions]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || busy) return;
    setBusy(true);
    setDraft('');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setLive('');
    try {
      const start = () =>
        fetch(`${CORE}/api/chat/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: activeId, message: text }),
        });
      let res = await start();
      if (res.status === 404) {
        // Session not yet adopted into the WebUI store — import and retry once.
        await fetch(`${CORE}/api/session/import_cli`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: activeId }),
        }).catch(() => undefined);
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

  // Grouping must be computed before any early return — hooks can't be conditional.
  const q = query.trim().toLowerCase();
  const grouped = useMemo(() => {
    const bySection: Record<SectionKey, HermesSession[]> = {
      direct: [], bots: [], chats: [], agents: [], crons: [], other: [],
    };
    for (const s of sessions) {
      if (q && !sessionTitle(s).toLowerCase().includes(q)) continue;
      bySection[sectionOf(s)].push(s);
    }
    for (const key of Object.keys(bySection) as SectionKey[]) {
      bySection[key].sort((a, b) => lastActivity(b) - lastActivity(a));
    }
    return bySection;
  }, [sessions, q]);

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
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <div className="flex items-center justify-between px-4 py-2 border-b border-cyan-400/20 bg-black/80">
        <div className="flex items-center gap-3">
          <button onClick={onNavigateHome} className="text-cyan-400/80 hover:text-cyan-300 text-xs uppercase tracking-widest">← Camille</button>
          <span className="text-cyan-300/90 text-xs uppercase tracking-[0.3em]">Hermes Command</span>
        </div>
        <div className="flex items-center gap-4">
          {/* Profile strip: pick which agent NEW chats talk to. Ring = your pick,
              filled = Hermes's own active profile, green dot = gateway alive. */}
          <div className="flex items-center gap-2 max-w-[50vw] overflow-x-auto">
            {profiles.map((p) => {
              const picked = pickedProfile ? pickedProfile === p.name : p.is_active;
              return (
                <button
                  key={p.name}
                  onClick={() => setPickedProfile(p.is_active ? null : p.name)}
                  title={`${p.name}${p.model ? ` · ${p.model}` : ''}${p.gateway_running ? ' · gateway up' : ''} — new chats go to the selected profile`}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wider whitespace-nowrap transition-colors ${
                    picked
                      ? 'border-cyan-400/70 text-cyan-200 bg-cyan-400/15'
                      : 'border-white/25 text-white/65 hover:border-cyan-400/40 hover:text-cyan-200'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${p.gateway_running ? 'bg-emerald-400' : 'bg-white/30'}`} />
                  {p.name}
                </button>
              );
            })}
          </div>
          <button onClick={() => setClassic(true)} className="text-white/30 hover:text-cyan-300 text-xs uppercase tracking-widest whitespace-nowrap">classic view</button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Session rail */}
        <div className="w-72 shrink-0 border-r border-cyan-400/10 overflow-y-auto py-2 flex flex-col">
          <div className="px-3 pb-2 flex gap-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search sessions…"
              className="flex-1 min-w-0 bg-white/5 border border-white/10 focus:border-cyan-400/50 rounded px-2 py-1 outline-none text-xs text-white/80 placeholder:text-white/25"
            />
            <button
              onClick={() => void newChat()}
              title={`New chat with ${pickedProfile ?? 'the active profile'}`}
              className="px-2 rounded border border-cyan-400/40 text-cyan-300 hover:bg-cyan-400/10 text-xs shrink-0"
            >
              +
            </button>
          </div>
          {error && <div className="px-3 py-2 text-xs text-red-400/90 break-words">{error}</div>}
          {SECTIONS.map(({ key, label, hint }) => {
            const list = grouped[key];
            if (!list.length) return null;
            const expanded = q ? true : (open[key] ?? true);
            return (
              <div key={key}>
                <button
                  onClick={() => setOpen((prev) => ({ ...prev, [key]: !expanded }))}
                  title={hint}
                  className="w-full flex items-center justify-between px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.25em] text-white/30 hover:text-cyan-300/70"
                >
                  <span>{label}</span>
                  <span className="text-white/20">{expanded ? '−' : `${list.length}`}</span>
                </button>
                {expanded &&
                  list.slice(0, key === 'crons' ? 30 : 100).map((s) => {
                    const id = sessionId(s);
                    return (
                      <button
                        key={id}
                        onClick={() => void openSession(id, sessionTitle(s))}
                        className={`w-full text-left px-3 py-1.5 transition-colors border-l-2 ${
                          id === activeId
                            ? 'text-cyan-300 bg-cyan-400/10 border-cyan-400'
                            : 'text-white/60 hover:text-white/90 hover:bg-white/5 border-transparent'
                        }`}
                        title={sessionTitle(s)}
                      >
                        <span className="flex items-center gap-2">
                          {s.is_streaming && <span className="w-1.5 h-1.5 rounded-full bg-cyan-300 animate-pulse shrink-0" />}
                          <span className="flex-1 text-xs truncate">{sessionTitle(s)}</span>
                          <span className="text-[9px] text-white/25 shrink-0">{relTime(lastActivity(s))}</span>
                        </span>
                        {key === 'bots' && s.source_label && (
                          <span className="block text-[9px] text-white/25 uppercase tracking-wider pl-3.5">{s.source_label}</span>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })}
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
