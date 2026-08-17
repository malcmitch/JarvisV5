/**
 * Desktop sign-in against jarvisdesktop.com.
 *
 * Camille will not run without an account, and the account is what decides how
 * many credits the user has. Everything here lives in the main process on
 * purpose: the refresh token is the long-lived secret, and the renderer is a
 * browser context running third-party 3D libraries, wake-word code and four
 * embedded social webviews. It has no business being able to read it.
 *
 * The flow, which mirrors what native OAuth clients do:
 *
 *   1. `startLogin()` invents a random verifier, keeps it in memory, and opens
 *      the system browser at /app-redirect with sha256(verifier) as a challenge.
 *   2. The user signs in (or creates an account) on the website.
 *   3. The site deep-links back as jarvis://auth?code=...&state=...
 *   4. `handleDeepLink()` posts the code *and the raw verifier* to
 *      /api/desktop/session, which redeems both for a real Supabase session.
 *
 * Because the verifier never leaves this process, a code intercepted from the
 * deep link — which the OS may well log — cannot be redeemed by anyone else.
 *
 * Access tokens are held in memory only. The refresh token is written to the
 * user-data directory encrypted with Electron's safeStorage, which is backed by
 * the OS keychain. Where that is unavailable we simply do not persist, so the
 * user signs in again next launch rather than leaving a bearer token in a
 * readable file.
 */

import { app, shell, safeStorage, ipcMain, BrowserWindow } from 'electron';
import { localKeys, localMode } from './local-keys';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Baked in so a packaged build works without any environment set up, and
// overridable so a local jarvis-web can be pointed at during development.
//
// The publishable key belongs in the client: it carries no privileges beyond
// what Row Level Security already allows an anonymous visitor, and the same key
// ships in the website's browser bundle. The key that must never appear here is
// SUPABASE_SECRET_KEY, which stays on the server behind /api/desktop/session.
// Must be the canonical host. The apex answers authenticated API calls with a
// 308 to the www host, and fetch drops the Authorization header when a redirect
// crosses origins — so every metered call arrives unauthenticated and comes back
// 401, as though the user were signed out.
const WEB_ORIGIN = (
  process.env.JARVIS_WEB_ORIGIN || 'https://www.jarvisdesktop.com'
).replace(/\/+$/, '');
const SUPABASE_URL = (
  process.env.JARVIS_SUPABASE_URL || 'https://mqpsgchvyysipafqmejw.supabase.co'
).replace(/\/+$/, '');
const SUPABASE_KEY =
  process.env.JARVIS_SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_pX0bhWhKZgLat0_42ctz4w_exPTpj6S';

/** Refresh a little early: a token that expires mid-request is a failed request. */
const REFRESH_MARGIN_MS = 60_000;

export interface AuthUser {
  id: string;
  email: string;
}

/** What the renderer is allowed to know. Deliberately contains no tokens. */
export interface AuthState {
  configured: boolean;
  signedIn: boolean;
  user: AuthUser | null;
  pending: boolean;
  error: string | null;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  user: AuthUser;
}

interface PendingLogin {
  verifier: string;
  state: string;
}

const isConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

let session: Session | null = null;
let pendingLogin: PendingLogin | null = null;
let lastError: string | null = null;
/** Set while a deep link is being redeemed, so the UI can show progress. */
let redeeming = false;
let getWindow: () => BrowserWindow | null = () => null;
/** Coalesces concurrent refreshes so one expiry does not fan out into many. */
let refreshInFlight: Promise<Session | null> | null = null;

const sessionFile = () => path.join(app.getPath('userData'), 'session.bin');

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

// ---------------------------------------------------------------- state ----

export function authState(): AuthState {
  // Local mode: the owner's keys stand in for an account. Nothing to sign
  // into, so the gate stays open and no cloud session exists.
  if (localMode()) {
    return {
      configured: true,
      signedIn: true,
      user: { email: 'local mode (your own keys)' } as AuthUser,
      pending: false,
      error: null,
    };
  }
  return {
    configured: isConfigured,
    signedIn: Boolean(session),
    user: session?.user ?? null,
    pending: redeeming,
    error: lastError,
  };
}

function broadcast() {
  const window = getWindow();
  if (window && !window.isDestroyed()) {
    window.webContents.send('auth:changed', authState());
  }
}

// -------------------------------------------------------------- storage ----

async function persistRefreshToken(token: string) {
  // Writing a blank token leaves a file that looks like a remembered session but
  // restores nothing, so the next launch reports being signed out with no
  // explanation. Better to have no file at all.
  if (!token.trim()) {
    console.warn('[auth] Refusing to save an empty refresh token.');
    await clearStoredSession();
    return;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      '[auth] OS-backed encryption is unavailable, so the session will not be remembered. ' +
        'Sign-in will be required again next launch.'
    );
    return;
  }
  try {
    await fs.writeFile(sessionFile(), safeStorage.encryptString(token));
  } catch (err) {
    console.error('[auth] Could not save the session:', err);
  }
}

async function readRefreshToken(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = await fs.readFile(sessionFile());
    const token = safeStorage.decryptString(encrypted);
    return token.trim() || null;
  } catch {
    // No stored session, or it was written by a different OS keychain identity.
    return null;
  }
}

async function clearStoredSession() {
  try {
    await fs.rm(sessionFile(), { force: true });
  } catch {
    // Nothing to remove.
  }
}

// -------------------------------------------------------------- helpers ----

function sessionFromTokenResponse(payload: unknown): Session | null {
  const data = payload as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    expires_at?: unknown;
    user?: { id?: unknown; email?: unknown };
  };

  // Emptiness is checked, not just the type. A blank refresh token still passes a
  // typeof check, and accepting one produces the worst possible state: the app
  // looks signed in, so the sign-in screen stays hidden, while every request
  // fails because there is nothing to refresh with.
  if (
    typeof data.access_token !== 'string' ||
    typeof data.refresh_token !== 'string' ||
    !data.access_token.trim() ||
    !data.refresh_token.trim()
  ) {
    return null;
  }

  const id = data.user?.id;
  const email = data.user?.email;
  if (typeof id !== 'string' || typeof email !== 'string') return null;

  // Supabase returns expires_in (seconds from now); expires_at (epoch seconds)
  // is also present on most responses. Prefer whichever is there, and fall back
  // to the platform default of an hour.
  const expiresAt =
    typeof data.expires_at === 'number'
      ? data.expires_at * 1000
      : Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000;

  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, user: { id, email } };
}

/** Constant-time compare so a returned state cannot be probed byte by byte. */
function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

// ------------------------------------------------------------ sign in -----

/** Opens the browser so the user can sign in or create an account. */
export async function startLogin(): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured) {
    return { ok: false, error: 'This build has no account server configured.' };
  }

  const verifier = randomBytes(32).toString('hex');
  const state = randomBytes(16).toString('hex');
  pendingLogin = { verifier, state };
  lastError = null;

  const url =
    `${WEB_ORIGIN}/app-redirect` +
    `?challenge=${sha256Hex(verifier)}` +
    `&state=${state}`;

  try {
    await shell.openExternal(url);
    broadcast();
    return { ok: true };
  } catch (err) {
    pendingLogin = null;
    const error = err instanceof Error ? err.message : 'Could not open your browser.';
    lastError = error;
    broadcast();
    return { ok: false, error };
  }
}

/**
 * Handles a jarvis:// URL. Only `jarvis://auth` means anything today; anything
 * else is ignored rather than guessed at.
 */
export async function handleDeepLink(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }

  if (parsed.protocol !== 'jarvis:') return;
  // Depending on the platform the "auth" part arrives as the host or the path.
  const target = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (target !== 'auth') return;

  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state') ?? '';

  const window = getWindow();
  window?.show();
  window?.focus();

  if (!code) {
    lastError = 'That sign-in link was incomplete. Please try again.';
    broadcast();
    return;
  }

  // Without a pending login there is no verifier, so this cannot be redeemed —
  // and an unsolicited deep link should never be able to sign anyone in.
  if (!pendingLogin) {
    lastError = 'Press Sign in first, then finish in your browser.';
    broadcast();
    return;
  }

  if (!statesMatch(state, pendingLogin.state)) {
    lastError = 'That sign-in did not match this app. Please try again.';
    broadcast();
    return;
  }

  const { verifier } = pendingLogin;
  pendingLogin = null;
  redeeming = true;
  lastError = null;
  broadcast();

  try {
    const response = await fetch(`${WEB_ORIGIN}/api/desktop/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      lastError =
        (payload as { error?: string } | null)?.error ??
        'Sign-in could not be completed. Please try again.';
      return;
    }

    const next = sessionFromTokenResponse(payload);
    if (!next) {
      lastError = 'The account server sent back something unexpected.';
      return;
    }

    session = next;
    await persistRefreshToken(next.refreshToken);
  } catch (err) {
    console.error('[auth] Could not redeem the sign-in code:', err);
    lastError = 'Could not reach the account server. Check your connection.';
  } finally {
    redeeming = false;
    broadcast();
  }
}

// ------------------------------------------------------------- refresh ----

async function refreshSession(refreshToken: string): Promise<Session | null> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      // A rejected refresh token is terminal: the account was signed out,
      // deleted or disabled. Drop it rather than retrying forever.
      if (response.status === 400 || response.status === 401) {
        await clearStoredSession();
        session = null;
      }
      return null;
    }

    const next = sessionFromTokenResponse(await response.json());
    if (!next) return null;

    session = next;
    await persistRefreshToken(next.refreshToken);
    return next;
  } catch (err) {
    console.error('[auth] Could not refresh the session:', err);
    return null;
  }
}

/**
 * A valid access token, refreshing first if it is about to expire. Null means
 * the user needs to sign in again.
 *
 * Only the main process calls this. Metered work goes out from here so the
 * renderer never handles a bearer token.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!session) return null;

  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return session.accessToken;
  }

  if (!refreshInFlight) {
    refreshInFlight = refreshSession(session.refreshToken).finally(() => {
      refreshInFlight = null;
    });
  }

  const refreshed = await refreshInFlight;
  if (!refreshed) {
    // A rejected token has already cleared the session, which shows the sign-in
    // screen. A network failure leaves it in place so it can recover — but then
    // nothing explains why Camille has gone quiet, so say so here.
    if (session) {
      lastError = 'Could not reach your account. Check your connection, then try again.';
    }
    broadcast();
    return null;
  }
  lastError = null;
  return refreshed.accessToken;
}

/** Restores a remembered session at launch. */
export async function restoreSession(): Promise<void> {
  if (!isConfigured) return;

  const stored = await readRefreshToken();
  if (!stored) return;

  await refreshSession(stored);
  broadcast();
}

export async function signOut(): Promise<void> {
  const token = session?.accessToken;
  session = null;
  pendingLogin = null;
  lastError = null;
  await clearStoredSession();
  broadcast();

  // Best effort: tell Supabase to revoke the refresh token too, so a copy of
  // the encrypted file cannot be reused.
  if (token) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
      });
    } catch {
      // The local session is already gone, which is what matters here.
    }
  }
}

// --------------------------------------------------------------- cloud ----

/** Where the account server lives, for the pieces that proxy through it. */
export const webOrigin = () => WEB_ORIGIN;

export interface CloudResult {
  ok: boolean;
  status: number;
  /** Parsed JSON when the response had a body, otherwise null. */
  data: unknown;
  error?: string;
}

/**
 * Calls the account server as the signed-in user.
 *
 * This is the only way metered work reaches the internet. The access token is
 * attached here, in the main process, so the renderer can ask for a voice token
 * or an AI response without ever being handed a credential it could leak through
 * one of the third-party libraries it loads.
 */
export async function cloudFetch(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<CloudResult> {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, status: 401, data: null, error: 'Please sign in to Camille.' };
  }

  try {
    const response = await fetch(`${WEB_ORIGIN}${path}`, {
      method: init.method ?? 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // Not followed, because following a cross-origin redirect silently discards
      // the bearer token and the call comes back 401 — which reads as "signed
      // out" and sends you looking in entirely the wrong place.
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? 'somewhere else';
      console.error(
        `[auth] ${WEB_ORIGIN} redirected ${path} to ${location}. ` +
          'JARVIS_WEB_ORIGIN must be the canonical host, or the token gets stripped.'
      );
      return {
        ok: false,
        status: response.status,
        data: null,
        error: 'The account server is misconfigured for this build.',
      };
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const error =
        (data as { error?: string } | null)?.error ??
        `That request failed (${response.status}).`;
      return { ok: false, status: response.status, data, error };
    }

    return { ok: true, status: response.status, data };
  } catch (err) {
    console.error(`[auth] Could not reach ${path}:`, err);
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Could not reach the account server. Check your connection.',
    };
  }
}

// ------------------------------------------------------------- credits ----

/**
 * The account's entitlement and remaining balance, straight from the database
 * function. Read-only, so it is safe to hand to the renderer for display.
 */
export async function creditStatus(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  // Local mode: usage is billed by the providers directly; always entitled.
  if (localMode()) return { ok: true, data: { entitled: true, local: true } };
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'Not signed in.' };

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/credit_status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });

    if (!response.ok) {
      return { ok: false, error: `Could not read your credits (${response.status}).` };
    }

    return { ok: true, data: await response.json() };
  } catch (err) {
    console.error('[auth] Could not read credit status:', err);
    return { ok: false, error: 'Could not reach the account server.' };
  }
}

// ----------------------------------------------------------------- IPC ----

export function registerAuthIpc(resolveWindow: () => BrowserWindow | null) {
  getWindow = resolveWindow;

  ipcMain.handle('auth:get-state', () => authState());
  ipcMain.handle('auth:start-login', () => startLogin());
  ipcMain.handle('auth:sign-out', () => signOut());
  ipcMain.handle('auth:credits', () => creditStatus());

  // Voice. The renderer gets a single-conversation token and nothing else; it
  // never sees the account token that bought it.
  ipcMain.handle('cloud:voice-token', () => {
    const keys = localKeys();
    if (keys) return mintLocalVoiceToken(keys);
    return cloudFetch('/api/desktop/elevenlabs/token');
  });
  ipcMain.handle('cloud:voice-heartbeat', (_event, minutes: unknown) => {
    // Local mode: minutes are ElevenLabs' problem, not an account balance.
    if (localMode()) return { ok: true };
    return cloudFetch('/api/desktop/voice/heartbeat', {
      body: { minutes: typeof minutes === 'number' ? minutes : 1 },
    });
  });
  ipcMain.handle('auth:open-account', async () => {
    await shell.openExternal(`${WEB_ORIGIN}/account`);
  });
  ipcMain.handle('auth:open-signup', async () => {
    await shell.openExternal(`${WEB_ORIGIN}/signup`);
  });
}

/**
 * Local mode voice: mint a single-conversation WebRTC token against the
 * owner's own ElevenLabs agent, shaped like cloudFetch's return so the
 * renderer cannot tell the difference.
 */
async function mintLocalVoiceToken(
  keys: NonNullable<ReturnType<typeof localKeys>>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!keys.elevenlabs_api_key) {
    return { ok: false, error: 'No ElevenLabs key in local-keys.json.' };
  }
  if (!keys.elevenlabs_agent_id) {
    return { ok: false, error: 'No elevenlabs_agent_id in local-keys.json — create your agent first.' };
  }
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(keys.elevenlabs_agent_id)}`,
      { headers: { 'xi-api-key': keys.elevenlabs_api_key } },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, error: `ElevenLabs refused a conversation token (${response.status}): ${detail.slice(0, 200)}` };
    }
    const data = (await response.json()) as { token?: string };
    if (!data.token) return { ok: false, error: 'ElevenLabs returned no token.' };
    return { ok: true, data: { token: data.token } };
  } catch (err) {
    console.error('[auth] Local voice token failed:', err);
    return { ok: false, error: 'Could not reach ElevenLabs.' };
  }
}
