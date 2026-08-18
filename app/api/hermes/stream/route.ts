import { NextRequest, NextResponse } from 'next/server.js';

import { resolveHermesTarget } from '../../../lib/hermes-config.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Streaming proxy: renderer → this route → Hermes /v1/chat/completions (SSE).
 *
 * Exists so the Hermes API key never reaches the renderer. Forwards the
 * upstream byte stream untouched — parsing happens client-side in
 * hermes-stream.ts, keeping this route dumb and the parser testable.
 *
 * Client abort (cancel button / widget unmount) propagates to the upstream
 * fetch via req.signal, so cancelled runs stop consuming the agent.
 *
 * Response headers defend against buffering in the dev HTTPS proxy or any
 * future middleware: no-store, identity encoding, no-transform.
 */
export async function POST(req: NextRequest) {
  let prompt = '';
  let sessionId = '';
  let profile: string | null = null;
  try {
    const body = (await req.json()) as { prompt?: unknown; sessionId?: unknown; profile?: unknown };
    prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    profile = typeof body.profile === 'string' && body.profile.trim() ? body.profile.trim() : null;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!prompt) {
    return NextResponse.json({ error: 'Prompt is required.' }, { status: 400 });
  }
  if (!sessionId) {
    return NextResponse.json({ error: 'Session id is required.' }, { status: 400 });
  }

  let baseUrl: string;
  let apiKey: string;
  try {
    ({ baseUrl, apiKey } = await resolveHermesTarget(profile));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Hermes API Server is not configured.' },
      { status: 503 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Hermes-Session-Id': sessionId,
        'X-Hermes-Session-Key': sessionId,
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
      signal: req.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Hermes gateway unreachable: ${message}` }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    let message = upstream.statusText || 'Unknown error';
    try {
      const data = (await upstream.json()) as { error?: { message?: string } };
      message = data.error?.message ?? message;
    } catch {
      // Keep statusText.
    }
    return NextResponse.json(
      { error: `Hermes gateway failed (${upstream.status}): ${message}` },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'Content-Encoding': 'identity',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
