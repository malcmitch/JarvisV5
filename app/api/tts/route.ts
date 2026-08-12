import { NextRequest, NextResponse } from 'next/server';
import { requireAiProxy, speechEndpoint, AI_UNAVAILABLE } from '../../lib/aiProxy';

/**
 * Speech synthesis for the Audio Lab.
 *
 * Both providers are reached through the signed-in account rather than a
 * user-supplied key: ElevenLabs via the account server's own text-to-speech
 * route, which already knows which voice Jarvis speaks with, and OpenAI through
 * the metered proxy. Neither credential exists on this machine.
 */

type Provider = 'openai' | 'elevenlabs';

interface TtsBody {
  provider?: Provider;
  text?: string;
  /** OpenAI voice id */
  voice?: string;
  /** Optional explicit ElevenLabs voice id; defaults to the agent's own voice */
  elevenLabsVoiceId?: string;
  /** OpenAI: gpt-4o-mini-tts | tts-1 | tts-1-hd */
  openaiModel?: string;
  /** ElevenLabs model id */
  elevenLabsModel?: string;
}

const MAX_CHARS = 4096;

function audioResponse(audio: ArrayBuffer, provider: Provider, voice: string) {
  return new NextResponse(audio, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': 'attachment; filename="jarvis-speech.mp3"',
      'Cache-Control': 'no-store',
      'X-Jarvis-Provider': provider,
      'X-Jarvis-Voice': voice,
    },
  });
}

async function speakWithOpenAI(text: string, body: TtsBody) {
  const bridge = requireAiProxy();
  if (!bridge.ok) {
    return NextResponse.json({ error: bridge.error }, { status: bridge.status });
  }

  const voice = (body.voice ?? 'echo').trim();
  const model = (body.openaiModel ?? 'gpt-4o-mini-tts').trim();

  const call = (withModel: string) =>
    fetch(`${bridge.proxy.baseURL}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridge.proxy.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: withModel,
        input: text,
        voice,
        response_format: 'mp3',
      }),
    });

  let res = await call(model);
  // Not every account has gpt-4o-mini-tts enabled.
  if (!res.ok && model === 'gpt-4o-mini-tts') res = await call('tts-1-hd');

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return NextResponse.json(
      { error: `OpenAI speech failed (${res.status}): ${detail.slice(0, 300)}` },
      { status: 502 },
    );
  }

  return audioResponse(await res.arrayBuffer(), 'openai', voice);
}

async function speakWithElevenLabs(text: string, body: TtsBody) {
  const endpoint = speechEndpoint();
  if (!endpoint) {
    return NextResponse.json({ error: AI_UNAVAILABLE }, { status: 503 });
  }

  const voiceId = (body.elevenLabsVoiceId ?? '').trim();

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      ...(voiceId ? { voiceId } : {}),
      ...(body.elevenLabsModel ? { modelId: body.elevenLabsModel.trim() } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: string } | null;
    return NextResponse.json(
      { error: detail?.error ?? `Speech failed (${res.status}).` },
      { status: res.status === 402 || res.status === 403 ? res.status : 502 },
    );
  }

  return audioResponse(await res.arrayBuffer(), 'elevenlabs', voiceId || 'agent');
}

export async function POST(req: NextRequest) {
  let body: TtsBody;
  try {
    body = (await req.json()) as TtsBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const text = (body.text ?? '').trim();
  if (!text) {
    return NextResponse.json({ error: 'Text is required' }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return NextResponse.json(
      { error: `Text must be ${MAX_CHARS} characters or fewer` },
      { status: 400 },
    );
  }

  try {
    return body.provider === 'openai'
      ? await speakWithOpenAI(text, body)
      : await speakWithElevenLabs(text, body);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
