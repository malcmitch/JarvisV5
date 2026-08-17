import OpenAI from 'openai';
import { NextRequest, NextResponse } from 'next/server';
import { requireAiProxy } from '../../lib/aiProxy';

/**
 * Text-in, text-out endpoint for external voice bridges — built for the
 * "Hey Siri, ask Camille …" Apple Shortcut running on HomePods.
 *
 * POST { text: "what's the shop temperature" }  -> { reply: "…" }
 * GET  ?q=…&format=text                          -> plain text reply
 *
 * Replies are written to be SPOKEN (Siri reads them verbatim): short,
 * no markdown, no emoji, no URLs unless asked.
 */

const DEFAULT_MODEL = 'gpt-4.1-mini';

const SPOKEN_PERSONA =
  'You are Camille, a helpful AI assistant for Malc\'s home and workshop. ' +
  'A woman, calm and composed, effortlessly witty, a little playful. ' +
  'Your answer will be read aloud by Siri on a HomePod, so: keep it to one to three ' +
  'spoken sentences, plain text only, no markdown, no emoji, no lists, no URLs unless asked. ' +
  'If a request needs hands (controlling devices, files, apps), say what you would do and ' +
  'suggest asking Camille on the desktop, which has full control.';

async function answer(text: string, model: string): Promise<{ reply?: string; error?: string; status: number }> {
  const bridge = requireAiProxy();
  if (!bridge.ok) {
    return { error: bridge.error, status: bridge.status };
  }
  const client = new OpenAI(bridge.proxy);
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.7,
    max_completion_tokens: 220,
    messages: [
      { role: 'system', content: SPOKEN_PERSONA },
      { role: 'user', content: text },
    ],
  });
  const reply = completion.choices[0]?.message?.content?.trim();
  if (!reply) return { error: 'Empty reply from model', status: 502 };
  return { reply, status: 200 };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { text?: string; q?: string; model?: string };
    const text = (body.text ?? body.q ?? '').trim();
    if (!text) {
      return NextResponse.json({ error: 'Missing text' }, { status: 400 });
    }
    const result = await answer(text, (body.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL);
    if (!result.reply) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ reply: result.reply });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const text = (searchParams.get('q') ?? searchParams.get('text') ?? '').trim();
  if (!text) {
    return new NextResponse('Missing q parameter', { status: 400 });
  }
  const result = await answer(text, DEFAULT_MODEL);
  const asText =
    searchParams.get('format') === 'text' ||
    (req.headers.get('accept') ?? '').includes('text/plain');
  if (!result.reply) {
    return asText
      ? new NextResponse(result.error ?? 'error', { status: result.status })
      : NextResponse.json({ error: result.error }, { status: result.status });
  }
  return asText
    ? new NextResponse(result.reply, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    : NextResponse.json({ reply: result.reply });
}
