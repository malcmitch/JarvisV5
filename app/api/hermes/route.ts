import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server.js';

import { parseHermesApiKey, runHermesCommand } from '../../lib/hermes-gateway.ts';

export const runtime = 'nodejs';

const HERMES_GATEWAY_URL = 'http://127.0.0.1:8644';
const HERMES_SESSION_ID = 'camille-voice';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { command?: unknown };
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) {
      return NextResponse.json({ error: 'Hermes command is required.' }, { status: 400 });
    }

    let apiKey = process.env.API_SERVER_KEY?.trim() ?? '';
    if (!apiKey) {
      try {
        const envText = await readFile(
          path.join(os.homedir(), '.hermes', 'profiles', 'camille', '.env'),
          'utf8',
        );
        apiKey = parseHermesApiKey(envText) ?? '';
      } catch {
        // A missing Hermes installation is reported below without exposing paths or secrets.
      }
    }
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Hermes API Server is not configured. Run Hermes gateway setup first.' },
        { status: 503 },
      );
    }

    const result = await runHermesCommand(command, {
      apiKey,
      baseUrl: HERMES_GATEWAY_URL,
      sessionId: HERMES_SESSION_ID,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
