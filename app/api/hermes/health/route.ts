import { NextResponse } from 'next/server.js';

import { HERMES_PROFILE, resolveHermesTarget } from '../../../lib/hermes-config.ts';
import { gatewayJobState, startGateway } from '../../../lib/hermes-profiles.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type HermesHealth = 'ok' | 'wedged' | 'down' | 'unconfigured';

/**
 * Health of the profile Camille depends on for voice delegation.
 *
 * launchd already restarts a gateway that exits, so the state worth reporting
 * is the one it can't detect: the process is alive but the API server isn't
 * answering. Combining the launchd job state with an HTTP probe separates:
 *
 *   ok           — job running, API answering
 *   wedged       — job running, API not answering (restart is the fix)
 *   down         — job not running at all (start is the fix)
 *   unconfigured — no API server / key set up for this profile
 *
 * The probe is deliberately cheap and short: this endpoint is polled.
 */
async function probe(profile: string): Promise<{ status: HermesHealth; detail: string | null }> {
  let target: { baseUrl: string; apiKey: string };
  try {
    target = await resolveHermesTarget(profile);
  } catch (err) {
    return { status: 'unconfigured', detail: err instanceof Error ? err.message : String(err) };
  }

  let answering = false;
  try {
    const res = await fetch(`${target.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${target.apiKey}` },
      signal: AbortSignal.timeout(2_500),
    });
    answering = res.ok;
  } catch {
    answering = false;
  }

  if (answering) return { status: 'ok', detail: null };

  const job = await gatewayJobState(profile);
  return job === 'running'
    ? { status: 'wedged', detail: 'Gateway process is running but its API is not answering.' }
    : { status: 'down', detail: 'Gateway is not running.' };
}

export async function GET(req: Request) {
  const profile = new URL(req.url).searchParams.get('profile') ?? HERMES_PROFILE;
  const result = await probe(profile);
  return NextResponse.json({ ok: true, profile, ...result });
}

/**
 * Recovery. Restarting a wedged gateway is the whole point of this endpoint,
 * so it's a POST the UI calls explicitly rather than something that fires
 * automatically off a failed poll — an auto-restart loop against a gateway
 * that's failing for an unrelated reason (expired credentials, say) would
 * thrash without fixing anything.
 */
export async function POST(req: Request) {
  const profile = new URL(req.url).searchParams.get('profile') ?? HERMES_PROFILE;
  try {
    await startGateway(profile);
    return NextResponse.json({ ok: true, profile, action: 'restart' });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
