import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Health check + self-healing starter for the embedded Hermes dashboard.
 *
 * GET  -> { up: boolean }
 * POST -> ensures `hermes dashboard --no-open --port 8799` is running
 *         (spawns it detached if the port is dark), then reports status.
 */

const DASHBOARD_URL = 'http://localhost:8799';

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(DASHBOARD_URL, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

function hermesBinary(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'hermes'),
    '/opt/homebrew/bin/hermes',
    '/usr/local/bin/hermes',
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export async function GET() {
  return NextResponse.json({ up: await isUp(), url: DASHBOARD_URL });
}

export async function POST() {
  if (await isUp()) {
    return NextResponse.json({ up: true, url: DASHBOARD_URL });
  }
  const bin = hermesBinary();
  if (!bin) {
    return NextResponse.json(
      { up: false, error: 'hermes CLI not found on this machine.' },
      { status: 503 },
    );
  }
  try {
    spawn(bin, ['dashboard', '--no-open', '--port', '8799'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOME: os.homedir() },
    }).unref();
  } catch (err) {
    return NextResponse.json({ up: false, error: String(err) }, { status: 500 });
  }
  // Give it a moment to bind, then report the truth.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (await isUp()) return NextResponse.json({ up: true, url: DASHBOARD_URL, started: true });
  }
  return NextResponse.json(
    { up: false, error: 'Dashboard did not come up within 30s (it may still be building its UI on first run).' },
    { status: 504 },
  );
}
