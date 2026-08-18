import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server.js';

import {
  getHermesSessionMessages,
  parseHermesApiKey,
  sendHermesSessionChat,
} from '../../../../../lib/hermes-gateway.ts';

export const runtime = 'nodejs';

const HERMES_GATEWAY_URL = 'http://127.0.0.1:8644';

async function resolveApiKey(): Promise<string> {
  let apiKey = process.env.API_SERVER_KEY?.trim() ?? '';
  if (!apiKey) {
    try {
      const envText = await readFile(
        path.join(os.homedir(), '.hermes', 'profiles', 'camille', '.env'),
        'utf8',
      );
      apiKey = parseHermesApiKey(envText) ?? '';
    } catch {
      // A missing Hermes installation is reported by the caller.
    }
  }
  return apiKey;
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Hermes API Server is not configured. Run Hermes gateway setup first.' },
        { status: 503 },
      );
    }

    const messages = await getHermesSessionMessages(id, { apiKey, baseUrl: HERMES_GATEWAY_URL });
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

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Hermes API Server is not configured. Run Hermes gateway setup first.' },
        { status: 503 },
      );
    }

    const message = await sendHermesSessionChat(id, text, { apiKey, baseUrl: HERMES_GATEWAY_URL });
    return NextResponse.json({ ok: true, message });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: errMessage }, { status: 502 });
  }
}
