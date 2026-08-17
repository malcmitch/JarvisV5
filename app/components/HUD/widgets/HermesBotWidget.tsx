'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A live window into one Hermes agent conversation, rendered as a HUD widget.
 *
 * Talks to the Hermes MCP server through the app's generic /api/mcp bridge:
 *   conversations_list -> pick a bot/conversation (choice persists per widget)
 *   messages_read      -> transcript, polled while the widget is visible
 *   messages_send      -> the input box at the bottom
 *
 * Several instances can coexist, each bound to a different conversation, so
 * the dashboard can show a whole crew of bots working at once.
 */

interface HermesConversation {
  session_key?: string;
  display_name?: string;
  chat_name?: string;
  key?: string;
  id?: string;
  name?: string;
  title?: string;
  platform?: string;
  last_message_at?: string;
}

interface HermesMessage {
  role?: string;
  sender?: string;
  from?: string;
  text?: string;
  content?: string;
  message?: string;
  timestamp?: string;
  created_at?: string;
}

/** MCP tool results arrive as content blocks; the JSON we want is in the first text block. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolResult(raw: any): any {
  const block = raw?.content?.find?.((c: { type?: string }) => c?.type === 'text');
  const text = block?.text ?? (typeof raw === 'string' ? raw : null);
  if (typeof text !== 'string') return raw;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callHermes(tool: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server: 'hermes', tool, arguments: args }),
  });
  if (!res.ok) throw new Error(`hermes ${tool} failed (${res.status})`);
  const parsed = parseToolResult(await res.json());
  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
    throw new Error(parsed.error);
  }
  return parsed;
}

function conversationKey(c: HermesConversation): string {
  return c.session_key ?? c.key ?? c.id ?? '';
}

function conversationName(c: HermesConversation): string {
  return c.name ?? c.title ?? c.display_name ?? c.chat_name ?? conversationKey(c) ?? 'unnamed';
}

/**
 * messages_send wants "platform:id" (e.g. "telegram:6236908795"), while
 * conversations are keyed "agent:main:telegram:dm:6236908795". Derive the
 * former from the latter.
 */
function conversationTarget(c: HermesConversation): string {
  const key = conversationKey(c);
  const parts = key.split(':');
  const id = parts[parts.length - 1] ?? '';
  const platform = c.platform ?? parts[2] ?? '';
  return platform && id ? `${platform}:${id}` : key;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeConversations(data: any): HermesConversation[] {
  const list = Array.isArray(data) ? data : data?.conversations ?? data?.sessions ?? data?.items ?? [];
  return Array.isArray(list) ? list.filter((c) => conversationKey(c)) : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMessages(data: any): HermesMessage[] {
  const list = Array.isArray(data) ? data : data?.messages ?? data?.items ?? [];
  return Array.isArray(list) ? list : [];
}

function messageText(m: HermesMessage): string {
  return (m.text ?? m.content ?? m.message ?? '').toString();
}

function isBot(m: HermesMessage): boolean {
  const who = (m.role ?? m.sender ?? m.from ?? '').toString().toLowerCase();
  return who.includes('assistant') || who.includes('agent') || who.includes('hermes') || who.includes('bot');
}

const POLL_MS = 4000;

export function HermesBotWidget({ widgetId }: { widgetId: string }) {
  const storageKey = `camille_hermes_bot_${widgetId}`;
  const [conversations, setConversations] = useState<HermesConversation[]>([]);
  const [channels, setChannels] = useState<HermesConversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string>('');
  const [selectedName, setSelectedName] = useState<string>('');
  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Restore this widget's bound conversation.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as
        | { key: string; name: string; target?: string }
        | null;
      if (saved?.key) {
        setSelected(saved.key);
        setSelectedName(saved.name ?? saved.key);
        setSelectedTarget(saved.target ?? saved.key);
      }
    } catch {
      // First run for this widget.
    }
  }, [storageKey]);

  const loadConversations = useCallback(async () => {
    try {
      const data = await callHermes('conversations_list', { limit: 30 });
      setConversations(normalizeConversations(data));
      try {
        const ch = await callHermes('channels_list', {});
        const chList = Array.isArray(ch) ? ch : ch?.channels ?? [];
        setChannels(
          (chList as { target?: string; platform?: string; name?: string; chat_type?: string }[])
            .filter((c) => c.target)
            .map((c) => ({
              // A channel's session key follows the same shape the DM keys use.
              session_key: `agent:main:${c.platform}:${c.chat_type ?? 'channel'}:${(c.target ?? '').split(':').pop()}`,
              name: `# ${c.name ?? c.target}`,
              platform: c.platform,
              // Stash the ready-made send target where bind() can find it.
              chat_name: c.target,
            })),
        );
      } catch {
        // Channels are optional garnish; conversations alone are fine.
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!selected) void loadConversations();
  }, [selected, loadConversations]);

  const refreshMessages = useCallback(async (key: string) => {
    try {
      const data = await callHermes('messages_read', { session_key: key, limit: 25 });
      setMessages(normalizeMessages(data));
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

  const bind = (c: HermesConversation) => {
    const key = conversationKey(c);
    const name = conversationName(c);
    // Channels arrive with a ready target in chat_name; conversations derive it.
    const target = c.chat_name?.includes(':') ? c.chat_name : conversationTarget(c);
    setSelected(key);
    setSelectedName(name);
    setSelectedTarget(target);
    setMessages([]);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ key, name, target }));
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
    void loadConversations();
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !selected || sending) return;
    setSending(true);
    setDraft('');
    // Optimistic echo so the widget feels instant.
    setMessages((prev) => [...prev, { role: 'user', text }]);
    try {
      await callHermes('messages_send', { target: selectedTarget || selected, message: text });
      setTimeout(() => void refreshMessages(selected), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  // ── Conversation picker ──
  if (!selected) {
    return (
      <div className="flex flex-col h-full text-xs">
        <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">
          Bind this widget to a Hermes bot
        </div>
        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {conversations.length === 0 && !error && (
            <div className="text-white/40 italic">Looking for Hermes conversations…</div>
          )}
          {error && <div className="text-red-400/90 break-words">{error}</div>}
          {[...conversations, ...channels].map((c) => (
            <button
              key={conversationKey(c)}
              onClick={() => bind(c)}
              className="w-full text-left px-2 py-1.5 rounded border border-white/10 hover:border-cyan-400/60 hover:bg-cyan-400/10 transition-colors"
            >
              <span className="text-cyan-300">{conversationName(c)}</span>
              {c.platform && <span className="text-white/30 ml-2">{c.platform}</span>}
            </button>
          ))}
        </div>
        <button
          onClick={() => void loadConversations()}
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

      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-1.5 pr-1">
        {messages.length === 0 && !error && (
          <div className="text-white/40 italic">No messages yet — say something below.</div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`px-2 py-1 rounded max-w-[92%] whitespace-pre-wrap break-words leading-snug ${
              isBot(m)
                ? 'bg-cyan-400/10 border border-cyan-400/20 text-white/90'
                : 'bg-white/5 border border-white/10 text-white/70 ml-auto'
            }`}
          >
            {messageText(m)}
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
          placeholder={sending ? 'sending…' : 'Message this bot…'}
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
