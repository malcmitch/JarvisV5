import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// Server-side settings file — persists across clients on the same machine.
// This file still holds sensitive third-party credentials (Home Assistant token,
// Bambu email), so it MUST live in a per-user, writable location — never inside
// the distributable app bundle. In packaged builds Electron passes
// JARVIS_DATA_DIR (the OS per-user app-data dir); in dev we fall back to the
// project root, which is git-ignored.
function getSettingsPath(): string {
  const base = process.env.JARVIS_DATA_DIR || process.cwd();
  return path.join(base, 'jarvis-server-settings.json');
}

function readSettings(): Record<string, unknown> {
  try {
    const p = getSettingsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(data: Record<string, unknown>): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/** AI keys the app used to ask users for. Nothing reads them any more. */
const RETIRED_CREDENTIALS = ['apiKey', 'elevenLabsApiKey', 'elevenLabsAgentId'] as const;

/**
 * Strips the AI credentials this file used to carry.
 *
 * Upgrading does not empty the file, so a machine that ran an older Camille still
 * has a real OpenAI key sitting in `jarvis_settings` — and this route is
 * unauthenticated by design, because the phones and tablets on the LAN read
 * their settings through it. Removing the keys on the way past means they stop
 * being served, and the next save drops them from disk for good.
 */
function withoutRetiredCredentials(settings: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  changed: boolean;
} {
  const raw = settings.jarvis_settings;
  if (typeof raw !== 'string') return { cleaned: settings, changed: false };

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const present = RETIRED_CREDENTIALS.filter((key) => key in parsed);
    if (present.length === 0) return { cleaned: settings, changed: false };

    for (const key of present) delete parsed[key];
    return {
      cleaned: { ...settings, jarvis_settings: JSON.stringify(parsed) },
      changed: true,
    };
  } catch {
    return { cleaned: settings, changed: false };
  }
}

export async function GET() {
  const { cleaned, changed } = withoutRetiredCredentials(readSettings());
  if (changed) {
    try {
      writeSettings(cleaned);
      console.warn('[settings] Removed retired AI credentials from the settings file.');
    } catch {
      // Serving the cleaned copy matters more than rewriting the file.
    }
  }
  return NextResponse.json(cleaned);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    // Merge with existing so partial updates (e.g. just HA creds) don't wipe everything
    const existing = readSettings();
    const merged = { ...existing, ...body };
    writeSettings(withoutRetiredCredentials(merged).cleaned);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
