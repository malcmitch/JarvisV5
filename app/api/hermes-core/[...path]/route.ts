import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Authenticated streaming proxy to the Hermes WebUI API — the engine behind
 * Camille's native Hermes Command page.
 *
 * Any /api/hermes-core/<rest> request is forwarded to <hermes_webui_url>/<rest>
 * with the WebUI's auth cookie attached. Camille logs in on demand with the
 * password from ~/.jarvis/local-keys.json and holds the session cookie in
 * module state, re-authenticating once on 401. Response bodies are streamed
 * straight through, so SSE endpoints (chat/stream, session events) work.
 */

interface CoreConfig {
  url: string;
  password: string;
}

function coreConfig(): CoreConfig | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.jarvis', 'local-keys.json'), 'utf-8'),
    ) as { hermes_webui_url?: string; hermes_webui_password?: string };
    if (raw.hermes_webui_url && raw.hermes_webui_password && !raw.hermes_webui_password.includes('PASTE')) {
      return { url: raw.hermes_webui_url.replace(/\/$/, ''), password: raw.hermes_webui_password };
    }
  } catch {
    // Fall through.
  }
  return null;
}

let cachedCookie: string | null = null;

async function login(config: CoreConfig): Promise<string | null> {
  try {
    const res = await fetch(`${config.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: config.password }),
    });
    if (!res.ok) return null;
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) return null;
    cachedCookie = setCookie.split(';')[0];
    return cachedCookie;
  } catch {
    return null;
  }
}

async function forward(req: NextRequest, params: { path: string[] }): Promise<Response> {
  const config = coreConfig();
  if (!config) {
    return NextResponse.json(
      { error: 'Hermes core not configured — set hermes_webui_url and hermes_webui_password in local-keys.json.' },
      { status: 503 },
    );
  }

  const rest = params.path.join('/');
  const search = req.nextUrl.search ?? '';
  const target = `${config.url}/${rest}${search}`;

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();

  const attempt = async (cookie: string | null): Promise<Response> =>
    fetch(target, {
      method: req.method,
      headers: {
        ...(req.headers.get('content-type') ? { 'Content-Type': req.headers.get('content-type')! } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Accept: req.headers.get('accept') ?? '*/*',
      },
      ...(body && body.byteLength > 0 ? { body } : {}),
      redirect: 'manual',
      // SSE responses must not buffer.
      // @ts-expect-error duplex is required by undici for streaming but not typed
      duplex: 'half',
    });

  let cookie = cachedCookie ?? (await login(config));
  let upstream = await attempt(cookie);
  if (upstream.status === 401) {
    cookie = await login(config);
    if (!cookie) {
      return NextResponse.json(
        { error: 'Hermes WebUI rejected the stored password.' },
        { status: 502 },
      );
    }
    upstream = await attempt(cookie);
  }

  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'no-store');
  // Keep SSE flowing through any intermediary.
  if (contentType?.includes('text/event-stream')) {
    headers.set('Connection', 'keep-alive');
    headers.set('X-Accel-Buffering', 'no');
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, await ctx.params);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, await ctx.params);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, await ctx.params);
}
