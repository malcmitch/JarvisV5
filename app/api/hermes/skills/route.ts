import { NextResponse } from 'next/server.js';

import { listHermesSkills } from '../../../lib/hermes-skills.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Installed skills for a profile, read from disk. ?profile= selects it. */
export async function GET(req: Request) {
  const profile = new URL(req.url).searchParams.get('profile');
  try {
    const skills = await listHermesSkills(profile);
    return NextResponse.json({ ok: true, skills });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
