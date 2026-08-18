import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseHermesApiKey } from './hermes-gateway.ts';

/**
 * Single source of truth for how Camille reaches the local Hermes API server.
 *
 * Server-side only (reads the filesystem for the API key). Route handlers
 * import from here instead of hardcoding the URL, profile, or key-loading
 * logic. Overridable via env for development against a different profile
 * or a remote Hermes:
 *
 *   HERMES_URL      — default http://127.0.0.1:8644
 *   HERMES_PROFILE  — default "camille" (used to locate the .env key file)
 *   API_SERVER_KEY  — bypasses the .env file read entirely
 */

export const HERMES_GATEWAY_URL = (process.env.HERMES_URL ?? 'http://127.0.0.1:8644').replace(/\/+$/, '');
export const HERMES_PROFILE = process.env.HERMES_PROFILE ?? 'camille';
export const HERMES_VOICE_SESSION_ID = 'camille-voice';

/** Default timeout for non-streaming management calls (list sessions, etc.). */
export const HERMES_REQUEST_TIMEOUT_MS = 15_000;

let cachedKey: string | null = null;

/**
 * Loads the Hermes API server key: env var first, then the profile's .env.
 * Cached after first successful read; call with { fresh: true } after a
 * credential rotation.
 */
export async function loadHermesApiKey(opts?: { fresh?: boolean }): Promise<string | null> {
  if (!opts?.fresh && cachedKey) return cachedKey;

  const fromEnv = process.env.API_SERVER_KEY?.trim();
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }

  try {
    const envText = await readFile(
      path.join(os.homedir(), '.hermes', 'profiles', HERMES_PROFILE, '.env'),
      'utf8',
    );
    const parsed = parseHermesApiKey(envText);
    if (parsed) cachedKey = parsed;
    return parsed;
  } catch {
    // Missing Hermes install / profile. Callers surface a friendly 503;
    // never leak paths or partial secrets in the error.
    return null;
  }
}
