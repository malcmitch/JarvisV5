import { NextResponse } from 'next/server.js';

import { listHermesProfiles, resolveHermesTarget } from '../../../lib/hermes-config.ts';
import { createProfile } from '../../../lib/hermes-profiles.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists every Hermes profile on this machine, with a live reachability check
 * so the picker can distinguish "profile exists" from "profile's gateway is
 * actually running". Profiles with no API server yet are listed too, marked
 * "not set up", so the UI can offer to enable and start them rather than
 * hiding them.
 *
 * The health probe is short (2.5s) and runs in parallel — this route sits in
 * front of a picker, so it must not stall the UI when a profile is down.
 */
export async function GET() {
  const profiles = await listHermesProfiles();

  const checked = await Promise.all(
    profiles.map(async (p) => {
      if (!p.port) return { ...p, online: false, reason: 'not set up' };
      if (!p.hasKey) return { ...p, online: false, reason: 'no API key' };
      try {
        const { baseUrl, apiKey } = await resolveHermesTarget(p.name);
        const res = await fetch(`${baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(2_500),
        });
        return res.ok
          ? { ...p, online: true, reason: null }
          : { ...p, online: false, reason: `gateway returned ${res.status}` };
      } catch {
        return { ...p, online: false, reason: 'stopped' };
      }
    }),
  );

  return NextResponse.json({ ok: true, profiles: checked });
}

/** Creates a profile, exposes its API server, and installs its (login-disabled) gateway job. */
export async function POST(req: Request) {
  let name = '';
  let cloneFrom: string | undefined;
  let description: string | undefined;
  try {
    const body = (await req.json()) as { name?: unknown; cloneFrom?: unknown; description?: unknown };
    name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
    cloneFrom = typeof body.cloneFrom === 'string' && body.cloneFrom.trim() ? body.cloneFrom.trim() : undefined;
    description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : undefined;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const created = await createProfile(name, { cloneFrom, description });
    return NextResponse.json({ ok: true, profile: created });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /must be lowercase|already exists/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
