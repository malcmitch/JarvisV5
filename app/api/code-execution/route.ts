import { NextRequest, NextResponse } from 'next/server';

const XAI_API_URL = 'https://api.x.ai/v1/responses';
const MODEL = 'grok-4.3';
const TIMEOUT_MS = 60_000;

export async function POST(req: NextRequest) {
  try {
    const { task, xaiApiKey } = await req.json();

    if (!task || typeof task !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid task' }, { status: 400 });
    }
    if (!xaiApiKey || typeof xaiApiKey !== 'string') {
      return NextResponse.json({ error: 'Missing xAI API key' }, { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let raw: Response;
    try {
      raw = await fetch(XAI_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${xaiApiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          input: [{ role: 'user', content: task }],
          tools: [{ type: 'code_interpreter' }],
          temperature: 0.1,
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!raw.ok) {
      const errBody = await raw.text();
      return NextResponse.json(
        { error: `xAI API error ${raw.status}: ${errBody}` },
        { status: raw.status },
      );
    }

    const data = await raw.json();

    // Extract the text output from the response
    const output = data.output ?? [];
    const textContent: string[] = [];

    for (const item of output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === 'output_text' && block.text) {
            textContent.push(block.text);
          }
        }
      }
    }

    const result = textContent.join('\n').trim() || 'Code executed successfully (no text output).';

    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
