import { NextResponse } from 'next/server.js';

import { enableApiServer, startGateway, stopGateway } from '../../../../../lib/hermes-profiles.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Starts or stops one profile's gateway on demand.
 *
 * Start is the interesting case: a profile the user has never exposed has no
 * api_server port and no launchd job, so start enables the API server first
 * and lets startGateway install the job. That makes "click an offline profile
 * to use it" work for any profile, not just pre-configured ones.
 */
export async function POST(req: Request, context: RouteContext) {
  const { name } = await context.params;

  let action = 'start';
  try {
    const body = (await req.json()) as { action?: unknown };
    if (typeof body.action === 'string') action = body.action;
  } catch {
    // No body means start.
  }

  try {
    if (action === 'stop') {
      await stopGateway(name);
      return NextResponse.json({ ok: true, action: 'stop' });
    }
    if (action !== 'start') {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }

    const port = await enableApiServer(name);
    await startGateway(name);
    return NextResponse.json({ ok: true, action: 'start', port });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /must be lowercase/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
