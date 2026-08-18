import { NextResponse } from 'next/server.js';

import { resolveHermesTarget } from '../../../lib/hermes-config.ts';
import { listHermesSessions } from '../../../lib/hermes-gateway.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // Standard URL parsing rather than req.nextUrl: works with any Request, so
  // the route stays testable without constructing Next-specific objects.
  const profile = new URL(req.url).searchParams.get('profile');
  try {
    const { baseUrl, apiKey } = await resolveHermesTarget(profile);
    const sessions = await listHermesSessions({ apiKey, baseUrl });
    return NextResponse.json({ ok: true, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found|no API server key|not configured/i.test(message) ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
