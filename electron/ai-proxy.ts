/**
 * A loopback bridge that lets local server code reach paid AI services without
 * holding a credential.
 *
 * The account token lives in this process and nowhere else. But two things that
 * are not this process still need to make AI calls: the bundled Next.js server,
 * which owns the route handlers, and the Python computer-use script it spawns.
 * Passing the token to either would put a bearer into a child process
 * environment, where it outlives the request and shows up in crash dumps.
 *
 * Instead this listens on 127.0.0.1 and speaks OpenAI's own URL shape, so those
 * callers point an ordinary OpenAI client at it and swap in the real account
 * token here, per request, from the live session. Callers authenticate with a
 * random per-launch secret: it is worthless outside this machine and this run,
 * and it means a page that happens to guess the port cannot spend anyone's
 * credits — browsers cannot set an Authorization header cross-origin without a
 * CORS preflight, which this deliberately never answers.
 */

import { app } from 'electron';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cloudFetch, getAccessToken, webOrigin } from './auth';

/** Matches the cap on the server, so oversized bodies fail here and cheaply. */
const MAX_BODY_BYTES = 4_000_000;

interface Handshake {
  port: number;
  secret: string;
}

let server: http.Server | null = null;
let handshake: Handshake | null = null;

const secret = randomBytes(32).toString('hex');

/** Where a child process looks to find this bridge. */
export function handshakePaths(): string[] {
  const paths = [path.join(app.getPath('userData'), 'ai-proxy.json')];
  // In development the Next server runs on its own, outside this process's
  // environment, with the project root as its working directory.
  if (!app.isPackaged) paths.push(path.join(process.cwd(), 'ai-proxy.json'));
  return paths;
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!aborted) resolve(null);
    });
  });
}

function deny(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'jarvis_local_proxy' } }));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (presented !== secret) {
    deny(res, 401, 'This bridge is not for you.');
    return;
  }

  const url = req.url ?? '/';

  // Only the OpenAI-shaped surface and the text-to-speech endpoint are relayed.
  // The account server allowlists the specific paths behind these; this only has
  // to avoid becoming an open forwarder.
  let target: string;
  if (url.startsWith('/v1/')) {
    target = `${webOrigin()}/api/desktop/openai${url}`;
  } else if (url === '/tts') {
    target = `${webOrigin()}/api/desktop/elevenlabs/tts`;
  } else {
    deny(res, 404, `Not routed: ${url}`);
    return;
  }

  const token = await getAccessToken();
  if (!token) {
    deny(res, 401, 'Please sign in to Camille.');
    return;
  }

  const body = req.method === 'GET' ? undefined : await readBody(req);
  if (body === null) {
    deny(res, 413, 'That request is too large to send through Camille.');
    return;
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (req.headers['content-type']) {
    headers['Content-Type'] = String(req.headers['content-type']);
  }

  try {
    const upstream = await fetch(target, {
      method: req.method ?? 'POST',
      headers,
      // Copied into a plain view: fetch's typings accept an ArrayBuffer but not
      // Node's Buffer, whose backing store may be shared.
      ...(body && body.length > 0
        ? { body: new Uint8Array(body).buffer as ArrayBuffer }
        : {}),
      // See cloudFetch: a followed cross-origin redirect loses the bearer token.
      redirect: 'manual',
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      console.error(
        `[ai-proxy] ${target} redirected to ${upstream.headers.get('location')}. ` +
          'JARVIS_WEB_ORIGIN must be the canonical host.'
      );
      deny(res, 502, 'The account server is misconfigured for this build.');
      return;
    }

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    // Relayed chunk by chunk so streamed completions stay streamed.
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[ai-proxy] Could not reach the account server:', err);
    deny(res, 502, 'Could not reach the AI service.');
  }
}

/**
 * Starts the bridge and publishes where to find it. Returns the environment a
 * child process needs, so the Next server is told at spawn time rather than
 * having to poll for the handshake file.
 */
export async function startAiProxy(): Promise<Record<string, string>> {
  if (handshake) {
    return {
      JARVIS_AI_PROXY: `http://127.0.0.1:${handshake.port}`,
      JARVIS_AI_PROXY_SECRET: handshake.secret,
    };
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[ai-proxy] Unhandled failure:', err);
      try {
        deny(res, 500, 'Something went wrong.');
      } catch {
        /* the response was already sent */
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server!.once('error', reject);
    // Port 0 asks the OS for a free one, so two Camille installs cannot collide.
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('The AI bridge did not report a port.'));
    });
  });

  handshake = { port, secret };

  const payload = JSON.stringify(handshake);
  for (const file of handshakePaths()) {
    try {
      // 0600: the secret is the only thing standing between another account on
      // this machine and the user's credits.
      await fs.writeFile(file, payload, { mode: 0o600 });
    } catch (err) {
      console.error(`[ai-proxy] Could not publish the bridge at ${file}:`, err);
    }
  }

  return {
    JARVIS_AI_PROXY: `http://127.0.0.1:${port}`,
    JARVIS_AI_PROXY_SECRET: secret,
  };
}

export async function stopAiProxy(): Promise<void> {
  server?.close();
  server = null;
  handshake = null;
  // Leaving a stale port and secret behind would send the next launch's route
  // handlers at a socket that is no longer listening.
  await Promise.all(
    handshakePaths().map((file) => fs.rm(file, { force: true }).catch(() => {}))
  );
}

/** Reports whether a voice minute can still be bought, for pre-flight checks. */
export async function voiceHeartbeat(minutes = 1) {
  return cloudFetch('/api/desktop/voice/heartbeat', { body: { minutes } });
}
