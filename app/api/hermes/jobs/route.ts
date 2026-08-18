import { NextResponse } from 'next/server.js';

import { resolveHermesTarget } from '../../../lib/hermes-config.ts';
import { createHermesJob, listHermesJobs } from '../../../lib/hermes-jobs.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Scheduled jobs for a profile. ?profile= selects it; default profile otherwise. */
export async function GET(req: Request) {
  const profile = new URL(req.url).searchParams.get('profile');
  try {
    const { baseUrl, apiKey } = await resolveHermesTarget(profile);
    const jobs = await listHermesJobs({ baseUrl, apiKey });
    return NextResponse.json({ ok: true, jobs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found|no API server|not configured/i.test(message) ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  const profile = new URL(req.url).searchParams.get('profile');

  let body: { name?: unknown; schedule?: unknown; prompt?: unknown; deliver?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name : '';
  const schedule = typeof body.schedule === 'string' ? body.schedule : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const deliver = typeof body.deliver === 'string' ? body.deliver : undefined;

  try {
    const { baseUrl, apiKey } = await resolveHermesTarget(profile);
    const job = await createHermesJob({ name, schedule, prompt, deliver }, { baseUrl, apiKey });
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Missing name/schedule is the user's input problem, not a gateway fault.
    const status = /required/i.test(message) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
