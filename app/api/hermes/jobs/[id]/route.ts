import { NextResponse } from 'next/server.js';

import { resolveHermesTarget } from '../../../../lib/hermes-config.ts';
import { deleteHermesJob, setHermesJobEnabled } from '../../../../lib/hermes-jobs.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** Enable or disable a job. Hermes supports PATCH here; PUT returns 405. */
export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const profile = new URL(req.url).searchParams.get('profile');

  let enabled: boolean;
  try {
    const body = (await req.json()) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be true or false.' }, { status: 400 });
    }
    enabled = body.enabled;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey } = await resolveHermesTarget(profile);
    await setHermesJobEnabled(id, enabled, { baseUrl, apiKey });
    return NextResponse.json({ ok: true, id, enabled });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function DELETE(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const profile = new URL(req.url).searchParams.get('profile');
  try {
    const { baseUrl, apiKey } = await resolveHermesTarget(profile);
    await deleteHermesJob(id, { baseUrl, apiKey });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
