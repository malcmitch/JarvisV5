import { NextResponse } from 'next/server.js';

import { listHermesProfiles, resolveHermesTarget } from '../../../lib/hermes-config.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists every Hermes profile on this machine that exposes an api_server port,
 * with a live reachability check so the picker can distinguish "profile exists"
 * from "profile's gateway is actually running". A profile whose gateway isn't
 * up can't be chatted with, and saying so up front beats a silent failure
 * after the user picks it.
 *
 * The health probe is short (2.5s) and runs in parallel — this route sits in
 * front of a picker, so it must not stall the UI when a profile is down.
 */
export async function GET() {
  const profiles = await listHermesProfiles();

  const checked = await Promise.all(
    profiles.map(async (p) => {
      if (!p.hasKey) return { ...p, online: false, reason: 'no API key configured' };
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
        return { ...p, online: false, reason: 'gateway not running' };
      }
    }),
  );

  return NextResponse.json({ ok: true, profiles: checked });
}
