import { NextResponse } from 'next/server';
import { spawn, ChildProcess } from 'child_process';
import { GOOGLE_CALENDAR_CREDENTIALS_PATH, JARVIS_DATA_DIR } from '@/app/lib/mcp/dynamic-config';
import os from 'os';
import fs from 'fs';

// Keep the auth process alive between requests so the OAuth callback server
// keeps listening even after this route returns.
let activeAuthProcess: ChildProcess | null = null;

export async function POST() {
  // Kill any previous auth attempt
  if (activeAuthProcess) {
    try { activeAuthProcess.kill(); } catch { /* ignore */ }
    activeAuthProcess = null;
  }

  // Ensure the jarvis data dir exists before spawning
  if (!fs.existsSync(JARVIS_DATA_DIR)) {
    fs.mkdirSync(JARVIS_DATA_DIR, { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GOOGLE_OAUTH_CREDENTIALS: GOOGLE_CALENDAR_CREDENTIALS_PATH,
    XDG_CONFIG_HOME: JARVIS_DATA_DIR,
    HOME: os.homedir(),
    // Ensure macOS /usr/bin/open is available to the child process
    PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${process.env.PATH ? `:${process.env.PATH}` : ''}`,
  };

  return new Promise<Response>((resolve) => {
    const proc = spawn('npx', ['-y', '@cocal/google-calendar-mcp', 'auth'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeAuthProcess = proc;

    let accumulated = '';
    let settled = false;

    const settle = (body: Record<string, unknown>, status = 200) => {
      if (settled) return;
      settled = true;
      resolve(NextResponse.json(body, { status }));
    };

    const tryExtract = (chunk: string) => {
      accumulated += chunk;
      // Google OAuth consent screen URLs
      const match = accumulated.match(/https?:\/\/accounts\.google\.com[^\s"'\n\r]*/);
      if (match) {
        settle({ authUrl: match[0] });
      }
      // Also handle localhost OAuth redirects (some implementations use this)
      const localMatch = accumulated.match(/http:\/\/localhost:\d+[^\s"'\n\r]*/);
      if (localMatch && !match) {
        settle({ authUrl: localMatch[0] });
      }
    };

    proc.stdout?.on('data', (d: Buffer) => tryExtract(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => tryExtract(d.toString()));

    proc.on('close', (code) => {
      activeAuthProcess = null;
      settle(
        settled
          ? { done: true }
          : { error: `Auth process exited (code ${code ?? '?'}) without a URL`, output: accumulated.slice(0, 600) },
        settled ? 200 : 500,
      );
    });

    proc.on('error', (err) => {
      activeAuthProcess = null;
      settle({ error: err.message }, 500);
    });

    // Give the process 20 seconds to print an auth URL
    setTimeout(() => {
      settle(
        settled
          ? { done: true }
          : { error: 'Timed out waiting for auth URL', output: accumulated.slice(0, 600) },
        settled ? 200 : 408,
      );
    }, 20_000);
  });
}

// DELETE kills any running auth process (clean-up)
export async function DELETE() {
  if (activeAuthProcess) {
    try { activeAuthProcess.kill(); } catch { /* ignore */ }
    activeAuthProcess = null;
  }
  return NextResponse.json({ success: true });
}
