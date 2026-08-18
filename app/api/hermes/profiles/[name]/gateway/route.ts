import { NextResponse } from 'next/server.js';

import {
  applyChatOnly,
  enableApiServer,
  restoreAllPlatforms,
  startGateway,
  stopGateway,
} from '../../../../../lib/hermes-profiles.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Starts or stops one profile's gateway on demand.
 *
 * Start does the whole setup: a profile the user has never exposed has no
 * api_server port and no launchd job, so start enables the API server, trims
 * it to chat-only, and lets startGateway install the job. That makes "click a
 * stopped profile to use it" work for any profile, not just configured ones.
 *
 * Chat-only is the default because Camille only ever talks to the API server.
 * Leaving a profile's messaging adapters on means booting Telegram, Discord,
 * SMS and Home Assistant clients that retry unreachable endpoints in a loop —
 * measured at over 100% CPU on a profile whose Telegram and Home Assistant
 * hosts were unreachable. Pass chatOnly: false to boot the full stack, or use
 * action "restore-platforms" to undo it permanently.
 */
export async function POST(req: Request, context: RouteContext) {
  const { name } = await context.params;

  let action = 'start';
  let chatOnly = true;
  try {
    const body = (await req.json()) as { action?: unknown; chatOnly?: unknown };
    if (typeof body.action === 'string') action = body.action;
    if (typeof body.chatOnly === 'boolean') chatOnly = body.chatOnly;
  } catch {
    // No body means a chat-only start.
  }

  try {
    if (action === 'stop') {
      await stopGateway(name);
      return NextResponse.json({ ok: true, action: 'stop' });
    }

    if (action === 'restore-platforms') {
      await restoreAllPlatforms(name);
      return NextResponse.json({ ok: true, action: 'restore-platforms' });
    }

    if (action !== 'start') {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }

    const port = await enableApiServer(name);
    if (chatOnly) await applyChatOnly(name);
    await startGateway(name);
    return NextResponse.json({ ok: true, action: 'start', port, chatOnly });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /must be lowercase/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
