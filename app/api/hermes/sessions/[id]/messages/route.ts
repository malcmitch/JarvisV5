import { NextRequest, NextResponse } from 'next/server.js';

import { resolveHermesTarget } from '../../../../../lib/hermes-config.ts';
import {
  getHermesSessionMessages,
  sendHermesSessionChat,
} from '../../../../../lib/hermes-gateway.ts';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profile = new URL(req.url).searchParams.get('profile');
    let apiKey: string;
    let baseUrl: string;
    try {
      ({ apiKey, baseUrl } = await resolveHermesTarget(profile));
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Hermes API Server is not configured.' },
        { status: 503 },
      );
    }

    const messages = await getHermesSessionMessages(id, { apiKey, baseUrl });
    return NextResponse.json({ ok: true, messages });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await req.json() as { message?: unknown };
    const text = typeof body.message === 'string' ? body.message.trim() : '';
    if (!text) {
      return NextResponse.json({ error: 'A non-empty message is required.' }, { status: 400 });
    }

    const profile = new URL(req.url).searchParams.get('profile');
    let apiKey: string;
    let baseUrl: string;
    try {
      ({ apiKey, baseUrl } = await resolveHermesTarget(profile));
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Hermes API Server is not configured.' },
        { status: 503 },
      );
    }

    const message = await sendHermesSessionChat(id, text, { apiKey, baseUrl });
    return NextResponse.json({ ok: true, message });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: errMessage }, { status: 502 });
  }
}
