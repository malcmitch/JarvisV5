'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Browse the skills installed on a Hermes profile.
 *
 * Read-only by design: Hermes only exposes enable/disable through an
 * interactive prompt (`hermes skills config` refuses to run without a TTY),
 * and editing that state behind its back risks corrupting a profile. What this
 * is actually for is answering "what can this agent already do?" — with 84
 * skills installed, that's a question the CLI's paginated table answers badly.
 */

interface HermesSkill {
  name: string;
  category: string;
  description: string;
  version: string | null;
  source: 'builtin' | 'local' | 'hub';
}

export function HermesSkillsWidget() {
  const [skills, setSkills] = useState<HermesSkill[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/hermes/skills', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok || body?.error) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setSkills(body.skills ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    // Match name, category and description so "3d print" or "apple" both work.
    return skills.filter((s) =>
      `${s.name} ${s.category} ${s.description}`.toLowerCase().includes(q),
    );
  }, [skills, query]);

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-widest text-white/40">Skills</span>
        <span className="text-white/25 text-[10px] ml-auto">
          {loading ? 'loading…' : `${filtered.length}/${skills.length}`}
        </span>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search skills…"
        className="mb-2 bg-white/5 border border-white/10 focus:border-cyan-400/60 rounded px-2 py-1 outline-none text-white/90 placeholder:text-white/25"
      />

      <div data-no-drag className="flex-1 overflow-y-auto space-y-1 pr-1">
        {error && <div className="text-red-400/90 break-words">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="text-white/40 italic">No matching skills.</div>
        )}

        {filtered.map((skill) => {
          const key = `${skill.category}/${skill.name}`;
          const open = expanded === key;
          return (
            <button
              key={key}
              onClick={() => setExpanded(open ? null : key)}
              className="w-full text-left px-2 py-1.5 rounded border border-white/10 hover:border-cyan-400/40 transition-colors"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-cyan-300 truncate">{skill.name}</span>
                {skill.source === 'local' && (
                  <span className="text-[9px] uppercase tracking-wider text-amber-300/60 shrink-0">
                    local
                  </span>
                )}
                <span className="text-white/25 text-[10px] ml-auto shrink-0">{skill.category}</span>
              </div>
              {skill.description && (
                <div
                  className={`text-white/45 leading-snug mt-0.5 ${open ? '' : 'line-clamp-1 truncate'}`}
                >
                  {skill.description}
                </div>
              )}
              {open && skill.version && (
                <div className="text-white/25 text-[10px] mt-1">v{skill.version}</div>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-2 text-[10px] text-white/25">
        Read-only — enable or disable with <span className="text-white/40">hermes skills config</span>
      </div>
    </div>
  );
}
