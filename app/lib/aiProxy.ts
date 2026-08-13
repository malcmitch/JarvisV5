import fs from 'fs';
import path from 'path';

/**
 * How server-side code reaches paid AI services.
 *
 * Route handlers used to be handed the user's own OpenAI key in the request
 * body, which meant every client on the LAN could read it out of settings and
 * every handler had to be trusted with it. Now the Electron main process runs a
 * loopback bridge that attaches the signed-in account's token per request, and
 * handlers point an ordinary OpenAI client at that instead.
 *
 * The bridge announces itself two ways because there are two ways the server
 * gets started: the packaged app spawns it with these variables set, while in
 * development `next dev` runs on its own and has to read the handshake file.
 */

export interface AiProxy {
  /** Base URL for an OpenAI-compatible client. */
  baseURL: string;
  /** Authenticates to the bridge. Not an OpenAI key, and useless off this machine. */
  apiKey: string;
}

interface Handshake {
  port: number;
  secret: string;
}

function fromHandshakeFile(): Handshake | null {
  const candidates = [
    process.env.JARVIS_DATA_DIR
      ? path.join(process.env.JARVIS_DATA_DIR, 'ai-proxy.json')
      : null,
    path.join(process.cwd(), 'ai-proxy.json'),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Handshake;
      if (typeof parsed.port === 'number' && typeof parsed.secret === 'string') {
        return parsed;
      }
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/**
 * Resolved fresh each call rather than cached: the bridge picks a new port and
 * secret every launch, and in development the server outlives the desktop app.
 */
export function getAiProxy(): AiProxy | null {
  const origin = process.env.JARVIS_AI_PROXY;
  const secret = process.env.JARVIS_AI_PROXY_SECRET;
  if (origin && secret) {
    return { baseURL: `${origin.replace(/\/+$/, '')}/v1`, apiKey: secret };
  }

  const handshake = fromHandshakeFile();
  if (handshake) {
    return {
      baseURL: `http://127.0.0.1:${handshake.port}/v1`,
      apiKey: handshake.secret,
    };
  }

  return null;
}

export const AI_UNAVAILABLE =
  'Camille is not signed in to an account that can run AI features. Open Camille and sign in.';

/**
 * The proxy, or a ready-made error response. Handlers should return the response
 * as-is so every one of them fails the same way when the bridge is missing.
 */
export function requireAiProxy():
  | { ok: true; proxy: AiProxy }
  | { ok: false; status: number; error: string } {
  const proxy = getAiProxy();
  if (!proxy) return { ok: false, status: 503, error: AI_UNAVAILABLE };
  return { ok: true, proxy };
}

/** Text-to-speech, which is ElevenLabs rather than an OpenAI-shaped call. */
export function speechEndpoint(): string | null {
  const origin = process.env.JARVIS_AI_PROXY;
  if (origin) return `${origin.replace(/\/+$/, '')}/tts`;

  const handshake = fromHandshakeFile();
  return handshake ? `http://127.0.0.1:${handshake.port}/tts` : null;
}
