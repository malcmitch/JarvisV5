import { readdir, readFile } from 'node:fs/promises';
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

export interface HermesProfileInfo {
  /** Directory name under ~/.hermes/profiles. */
  name: string;
  /** api_server.port from the profile's config.yaml. */
  port: number;
  /** Whether an API_SERVER_KEY was found for this profile. */
  hasKey: boolean;
}

/**
 * Minimal reader for `api_server:\n  ... port: N` in a profile config.yaml.
 *
 * Deliberately not a YAML dependency: we need exactly one nested scalar, and
 * adding a parser to read it would be more surface area than the job needs.
 * Tracks indentation so a `port:` under some other top-level key is ignored.
 */
export function parseApiServerPort(configYaml: string): number | null {
  const lines = configYaml.split(/\r?\n/);
  let blockIndent: number | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (blockIndent !== null && indent <= blockIndent) {
      blockIndent = null; // left the api_server block without finding a port
    }
    if (/^\s*api_server\s*:/.test(line)) {
      blockIndent = indent;
      continue;
    }
    if (blockIndent !== null) {
      const m = /^\s*port\s*:\s*(\d{2,5})\b/.exec(line);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

const profilesRoot = () => path.join(os.homedir(), '.hermes', 'profiles');

/** Reads one profile's port and key. Returns null if it has no api_server port. */
export async function readHermesProfile(name: string): Promise<HermesProfileInfo | null> {
  try {
    const configText = await readFile(path.join(profilesRoot(), name, 'config.yaml'), 'utf8');
    const port = parseApiServerPort(configText);
    if (!port) return null;
    let hasKey = false;
    try {
      const envText = await readFile(path.join(profilesRoot(), name, '.env'), 'utf8');
      hasKey = Boolean(parseHermesApiKey(envText));
    } catch {
      hasKey = false;
    }
    return { name, port, hasKey };
  } catch {
    return null;
  }
}

/** Every profile on disk that exposes an api_server port, sorted by name. */
export async function listHermesProfiles(): Promise<HermesProfileInfo[]> {
  let names: string[];
  try {
    const entries = await readdir(profilesRoot(), { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const found = await Promise.all(names.map((n) => readHermesProfile(n)));
  return found.filter((p): p is HermesProfileInfo => p !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolves a profile name to the base URL + key needed to call its gateway.
 * Falls back to the default profile when name is omitted. Throws a message
 * safe to show the user (no paths, no secrets).
 */
export async function resolveHermesTarget(
  name?: string | null,
): Promise<{ profile: string; baseUrl: string; apiKey: string }> {
  const profile = (name?.trim() || HERMES_PROFILE);

  if (profile === HERMES_PROFILE) {
    const apiKey = await loadHermesApiKey();
    if (!apiKey) throw new Error(`Hermes profile "${profile}" has no API server key configured.`);
    return { profile, baseUrl: HERMES_GATEWAY_URL, apiKey };
  }

  const info = await readHermesProfile(profile);
  if (!info) throw new Error(`Hermes profile "${profile}" was not found or has no API server port.`);

  let apiKey = '';
  try {
    const envText = await readFile(path.join(profilesRoot(), profile, '.env'), 'utf8');
    apiKey = parseHermesApiKey(envText) ?? '';
  } catch {
    apiKey = '';
  }
  if (!apiKey) throw new Error(`Hermes profile "${profile}" has no API server key configured.`);

  return { profile, baseUrl: `http://127.0.0.1:${info.port}`, apiKey };
}
