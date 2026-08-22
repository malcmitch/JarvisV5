import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The Camille gateway — true two-way chat with the Hermes agent.
 *
 * POST { text } here and it is delivered to Hermes's webhook platform
 * (route "camille"), which activates the agent with the message AS THE USER.
 * The agent's reply is delivered to the gateway log tagged with the same
 * delivery id the webhook POST returned, so this handler tails the log until
 * the matching response appears and returns it.
 *
 * Config comes from ~/.jarvis/local-keys.json:
 *   hermes_webhook_url    e.g. http://localhost:8646/webhooks/camille
 *   hermes_webhook_secret HMAC-SHA256 signing secret from `hermes webhook subscribe`
 */

const REPLY_TIMEOUT_MS = 90_000;
const POLL_MS = 1500;

interface GatewayConfig {
  url: string;
  secret: string;
}

function gatewayConfig(): GatewayConfig | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.jarvis', 'local-keys.json'), 'utf-8'),
    ) as { hermes_webhook_url?: string; hermes_webhook_secret?: string };
    if (raw.hermes_webhook_url && raw.hermes_webhook_secret) {
      return { url: raw.hermes_webhook_url, secret: raw.hermes_webhook_secret };
    }
  } catch {
    // Fall through.
  }
  return null;
}

function gatewayLogPath(): string {
  return path.join(os.homedir(), '.hermes', 'logs', 'gateway.log');
}

/**
 * The reply appears in the gateway log as:
 *   ... [webhook] Response for webhook:camille:<deliveryId>: <text...>
 * possibly spanning multiple lines until the next timestamped log line.
 */
function findReplyInLog(log: string, deliveryId: string): string | null {
  // A delivery can produce several response entries (e.g. a "switched to
  // fallback model" notice before the real answer) — take the LAST one.
  const marker = new RegExp(
    `\\[webhook\\] Response for webhook:camille:${deliveryId}: `,
    'g',
  );
  let m: RegExpExecArray | null;
  let last: number = -1;
  let lastLen = 0;
  while ((m = marker.exec(log)) !== null) {
    last = m.index;
    lastLen = m[0].length;
  }
  if (last === -1) return null;
  const rest = log.slice(last + lastLen);
  // The next log record starts with "YYYY-MM-DD HH:MM:SS" at line start.
  const next = rest.search(/\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  let text = (next === -1 ? rest : rest.slice(0, next)).trim();
  // Strip the model's fenced reasoning preamble; the spoken answer follows it.
  text = text.replace(/💭 ?\*\*Reasoning:\*\*\s*```[\s\S]*?```/g, '').trim();
  return text.length > 0 ? text : null;
}

/** Provider-switch notices are status, not answers — keep waiting past them. */
function isStatusNotice(text: string): boolean {
  return text.startsWith('🔄');
}

export async function POST(req: NextRequest) {
  const config = gatewayConfig();
  if (!config) {
    return NextResponse.json(
      { error: 'Gateway not configured (hermes_webhook_url / hermes_webhook_secret missing from local-keys.json).' },
      { status: 503 },
    );
  }

  let text = '';
  try {
    const body = (await req.json()) as { text?: string };
    text = (body.text ?? '').trim();
  } catch {
    // Handled below.
  }
  if (!text) {
    return NextResponse.json({ error: 'Missing text' }, { status: 400 });
  }

  const payload = Buffer.from(JSON.stringify({ message: text }), 'utf-8');
  const signature = crypto.createHmac('sha256', config.secret).update(payload).digest('hex');

  let deliveryId: string | null = null;
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${signature}`,
      },
      body: new Uint8Array(payload).buffer as ArrayBuffer,
    });
    const data = (await res.json().catch(() => null)) as { delivery_id?: string; status?: string } | null;
    if (!res.ok || !data?.delivery_id) {
      return NextResponse.json(
        { error: `Hermes gateway refused the message (${res.status}).` },
        { status: 502 },
      );
    }
    deliveryId = data.delivery_id;
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach the Hermes gateway: ${String(err)}. Is it running? (hermes gateway start)` },
      { status: 502 },
    );
  }

  // Wait for the agent's reply to land in the gateway log.
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  const logPath = gatewayLogPath();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      // The log rotates rarely and stays small enough to read whole; if it
      // ever grows huge, read just the tail.
      const stat = fs.statSync(logPath);
      const readFrom = Math.max(0, stat.size - 512 * 1024);
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(stat.size - readFrom);
      fs.readSync(fd, buf, 0, buf.length, readFrom);
      fs.closeSync(fd);
      const reply = findReplyInLog(buf.toString('utf-8'), deliveryId);
      if (reply && !isStatusNotice(reply)) {
        return NextResponse.json({ reply, deliveryId });
      }
    } catch {
      // Log unreadable this tick; keep waiting.
    }
  }

  return NextResponse.json(
    {
      error: 'Hermes accepted the message but no reply appeared within 90s. It may still be thinking — check back in the session list.',
      deliveryId,
    },
    { status: 504 },
  );
}
