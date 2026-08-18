'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A working shell, run through Electron IPC.
 *
 * Deliberately not an HTTP route: Camille's dev server and HTTPS proxy bind
 * 0.0.0.0 and the proxy rewrites Host, so a route couldn't reliably tell a LAN
 * client from the local app — and a shell endpoint reachable from the network
 * would hand every device on it a shell as this user. ipcMain is only
 * reachable from the Electron renderer, which closes that off by construction.
 *
 * Each command runs in its own process, so `cd` is tracked here and applied as
 * the cwd of the next one. No PTY, so interactive programs (vim, top, ssh)
 * won't work; everything non-interactive does.
 */

interface Line {
  kind: 'command' | 'stdout' | 'stderr' | 'note';
  text: string;
}

const HISTORY_LIMIT = 100;
const MAX_LINES = 500;

/** Shortens a path for the prompt the way a shell does. */
function promptPath(cwd: string, home: string): string {
  const short = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = short.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : short;
}

export function ShellWidget() {
  const [lines, setLines] = useState<Line[]>([
    { kind: 'note', text: 'Non-interactive shell. cd is remembered between commands.' },
  ]);
  const [draft, setDraft] = useState('');
  const [cwd, setCwd] = useState('');
  const [home, setHome] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const available = typeof window !== 'undefined' && Boolean(window.electron?.runShell);

  const push = useCallback((next: Line[]) => {
    setLines((prev) => [...prev, ...next].slice(-MAX_LINES));
  }, []);

  // Establish the starting directory once.
  useEffect(() => {
    if (!available) return;
    const init = setTimeout(async () => {
      const res = await window.electron!.runShell!('pwd');
      const dir = res.stdout.trim();
      if (dir) {
        setCwd(dir);
        setHome(dir);
      }
    }, 0);
    return () => clearTimeout(init);
  }, [available]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  const run = async () => {
    const command = draft.trim();
    if (!command || running || !available) return;

    setDraft('');
    setHistoryIdx(null);
    setHistory((prev) => [command, ...prev.filter((c) => c !== command)].slice(0, HISTORY_LIMIT));
    push([{ kind: 'command', text: command }]);

    if (command === 'clear') {
      setLines([]);
      return;
    }

    setRunning(true);
    try {
      // Ask the shell where it ended up: this makes `cd`, and anything else
      // that changes directory, stick across commands even though each run is
      // a separate process.
      const res = await window.electron!.runShell!(`${command}\n__code=$?; pwd; exit $__code`, cwd);

      const out = res.stdout.split('\n');
      const finalCwd = out.filter((l) => l.trim()).pop() ?? '';
      const body = finalCwd.startsWith('/') ? out.slice(0, out.lastIndexOf(finalCwd)) : out;

      if (finalCwd.startsWith('/') && finalCwd !== cwd) setCwd(finalCwd);

      const next: Line[] = [];
      const stdout = body.join('\n').replace(/\n+$/, '');
      if (stdout) next.push({ kind: 'stdout', text: stdout });
      if (res.stderr.trim()) next.push({ kind: 'stderr', text: res.stderr.replace(/\n+$/, '') });
      if (res.truncated) next.push({ kind: 'note', text: '[output truncated]' });
      if (res.exitCode !== 0 && !res.stderr.trim()) {
        next.push({ kind: 'note', text: `[exit ${res.exitCode}]` });
      }
      if (next.length === 0) next.push({ kind: 'note', text: '[no output]' });
      push(next);
    } catch (err) {
      push([{ kind: 'stderr', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setRunning(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
      return;
    }
    // Up/down walk shell history, same as a real terminal.
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = historyIdx === null ? 0 : Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(next);
      setDraft(history[next]);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === null) return;
      const next = historyIdx - 1;
      if (next < 0) {
        setHistoryIdx(null);
        setDraft('');
      } else {
        setHistoryIdx(next);
        setDraft(history[next]);
      }
    }
  };

  if (!available) {
    return (
      <div className="flex flex-col h-full text-xs justify-center text-white/40 italic px-2">
        The shell is only available in the Camille desktop app.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-xs font-mono">
      <div
        ref={scrollRef}
        data-no-drag
        className="flex-1 overflow-y-auto pr-1 space-y-0.5 leading-snug"
      >
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.kind === 'command'
                ? 'text-cyan-300'
                : line.kind === 'stderr'
                  ? 'text-red-300/85'
                  : line.kind === 'note'
                    ? 'text-white/30 italic'
                    : 'text-white/75'
            }
          >
            {line.kind === 'command' ? `❯ ${line.text}` : line.text}
          </div>
        ))}
        {running && <div className="text-amber-300/70 italic">running…</div>}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-emerald-400/70 shrink-0 max-w-[45%] truncate">
          {promptPath(cwd, home)}
        </span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={running}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={running ? '' : 'command…'}
          className="flex-1 min-w-0 bg-transparent border-b border-white/10 focus:border-cyan-400/60 px-1 py-0.5 outline-none text-white/90 placeholder:text-white/20 disabled:opacity-40"
        />
      </div>
    </div>
  );
}
