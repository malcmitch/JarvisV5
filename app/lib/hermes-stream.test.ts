import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createHermesSSEParser, streamHermesChat } from './hermes-stream.ts';

// ── Helpers ──────────────────────────────────────────────────────────────

interface Collected {
  deltas: string[];
  tools: Array<{ kind: string; payload: unknown }>;
  done: { full: string; usage?: unknown } | null;
  error: { message: string; code?: string } | null;
}

function collect(): { c: Collected; callbacks: Parameters<typeof createHermesSSEParser>[0] } {
  const c: Collected = { deltas: [], tools: [], done: null, error: null };
  return {
    c,
    callbacks: {
      onDelta: (t) => c.deltas.push(t),
      onToolEvent: (e) => c.tools.push(e),
      onDone: (full, usage) => (c.done = { full, usage }),
      onError: (message, code) => (c.error = { message, code }),
    },
  };
}

const chunk = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
const contentChunk = (text: string) =>
  chunk({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });

// ── Parser: happy path ───────────────────────────────────────────────────

test('parses a clean multi-event stream into deltas and done', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(chunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
  p.feed(contentChunk('Hello'));
  p.feed(contentChunk(' world'));
  p.feed('data: [DONE]\n\n');
  p.end();

  assert.deepEqual(c.deltas, ['Hello', ' world']);
  assert.equal(c.done?.full, 'Hello world');
  assert.equal(c.error, null);
});

test('captures usage from the final chunk', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(contentChunk('hi'));
  p.feed(
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
  );
  p.feed('data: [DONE]\n\n');

  assert.deepEqual(c.done?.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
});

// ── Parser: chunk-boundary pitfalls ──────────────────────────────────────

test('handles one event split across multiple network chunks', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  const full = contentChunk('split across the wire');
  p.feed(full.slice(0, 25));
  p.feed(full.slice(25, 60));
  p.feed(full.slice(60));
  p.feed('data: [DONE]\n\n');

  assert.deepEqual(c.deltas, ['split across the wire']);
  assert.equal(c.done?.full, 'split across the wire');
});

test('handles multiple events arriving in a single chunk', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(contentChunk('a') + contentChunk('b') + 'data: [DONE]\n\n');

  assert.deepEqual(c.deltas, ['a', 'b']);
  assert.equal(c.done?.full, 'ab');
});

test('skips malformed JSON lines without crashing or terminating', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(contentChunk('good'));
  p.feed('data: {not valid json!!!\n\n');
  p.feed(contentChunk(' still going'));
  p.feed('data: [DONE]\n\n');

  assert.equal(c.done?.full, 'good still going');
  assert.equal(c.error, null);
});

test('ignores blank keep-alives and comment lines', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed('\n\n: keep-alive comment\n\n');
  p.feed(contentChunk('ok'));
  p.feed('data: [DONE]\n\n');

  assert.equal(c.done?.full, 'ok');
});

// ── Parser: error handling (the Hermes-specific part) ────────────────────

test('REAL FIXTURE: in-stream 401 error surfaces via onError, not onDone', () => {
  // Captured live from the camille-profile gateway on 2026-08-18. Hermes
  // returns HTTP 200 and reports the failure inside the stream — a parser
  // that only checks HTTP status shows the user a silent empty response.
  const raw = readFileSync(
    path.join(process.cwd(), 'tests', 'fixtures', 'hermes-stream-error-401.txt'),
    'utf8',
  );
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(raw);
  p.end();

  assert.equal(c.done, null, 'error streams must not resolve as success');
  assert.match(c.error?.message ?? '', /OAuth access token has expired/);
  assert.equal(c.error?.code, 'agent_error');
  assert.deepEqual(c.deltas, [], 'no content deltas in this fixture');
});

test('terminal callbacks fire exactly once even if [DONE] follows an error', () => {
  const { callbacks } = collect();
  let doneCount = 0;
  let errorCount = 0;
  const p = createHermesSSEParser({
    ...callbacks,
    onDone: () => doneCount++,
    onError: () => errorCount++,
  });
  p.feed(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: 'boom' } }));
  p.feed('data: [DONE]\n\n');
  p.end();

  assert.equal(errorCount, 1);
  assert.equal(doneCount, 0);
});

test('stream closing without [DONE] reports truncation, not success', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(contentChunk('partial answer'));
  p.end();

  assert.equal(c.done, null);
  assert.equal(c.error?.code, 'stream_truncated');
});

// ── Parser: defensive tool-event surfacing ───────────────────────────────

test('forwards tool_calls deltas as tool events', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(
    chunk({
      choices: [
        { index: 0, delta: { tool_calls: [{ id: 't1', function: { name: 'terminal' } }] }, finish_reason: null },
      ],
    }),
  );
  p.feed('data: [DONE]\n\n');

  assert.equal(c.tools.length, 1);
  assert.equal(c.tools[0].kind, 'tool_calls');
});

test('forwards unknown hermes payload fields as hermes_status events', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(
    chunk({
      choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
      hermes: { completed: false, tool: 'terminal', step: 'running ls' },
    }),
  );
  p.feed('data: [DONE]\n\n');

  assert.equal(c.tools.length, 1);
  assert.equal(c.tools[0].kind, 'hermes_status');
});

test('known-only hermes status booleans do NOT produce tool-event noise', () => {
  const { c, callbacks } = collect();
  const p = createHermesSSEParser(callbacks);
  p.feed(
    chunk({
      choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
      hermes: { completed: false, partial: true, failed: false },
    }),
  );
  p.feed('data: [DONE]\n\n');

  assert.equal(c.tools.length, 0);
});

// ── streamHermesChat: transport behavior via injected fetch ──────────────

function streamResponseFrom(text: string, opts?: { status?: number }): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit in two chunks to exercise the decode/feed loop.
      const mid = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, mid)));
      controller.enqueue(encoder.encode(text.slice(mid)));
      controller.close();
    },
  });
  return new Response(body, { status: opts?.status ?? 200 });
}

test('streamHermesChat sends prompt+sessionId and resolves via onDone', async () => {
  const { c, callbacks } = collect();
  let seenUrl = '';
  let seenBody: Record<string, unknown> = {};
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return streamResponseFrom(contentChunk('streamed!') + 'data: [DONE]\n\n');
  }) as typeof fetch;

  await streamHermesChat({ prompt: 'hi', sessionId: 'widget-42', fetchImpl, ...callbacks });

  assert.equal(seenUrl, '/api/hermes/stream');
  assert.equal(seenBody.prompt, 'hi');
  assert.equal(seenBody.sessionId, 'widget-42');
  assert.equal(c.done?.full, 'streamed!');
});

test('streamHermesChat surfaces proxy JSON errors from non-OK responses', async () => {
  const { c, callbacks } = collect();
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: 'Hermes API Server is not configured.' }), {
      status: 503,
    })) as typeof fetch;

  await streamHermesChat({ prompt: 'hi', sessionId: 's', fetchImpl, ...callbacks });

  assert.equal(c.done, null);
  assert.match(c.error?.message ?? '', /not configured/);
  assert.equal(c.error?.code, 'http_503');
});

test('streamHermesChat reports abort as cancelled', async () => {
  const { c, callbacks } = collect();
  const controller = new AbortController();
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    controller.abort();
    const err = new Error('The operation was aborted.');
    (err as Error & { name: string }).name = 'AbortError';
    if (init?.signal?.aborted) throw err;
    throw err;
  }) as typeof fetch;

  await streamHermesChat({
    prompt: 'hi',
    sessionId: 's',
    signal: controller.signal,
    fetchImpl,
    ...callbacks,
  });

  assert.equal(c.error?.code, 'cancelled');
});

test('streamHermesChat forwards the profile when one is selected', async () => {
  const { c, callbacks } = collect();
  let seenBody: Record<string, unknown> = {};
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return streamResponseFrom(contentChunk('ok') + 'data: [DONE]\n\n');
  }) as typeof fetch;

  await streamHermesChat({ prompt: 'hi', sessionId: 's', profile: 'rapid', fetchImpl, ...callbacks });

  assert.equal(seenBody.profile, 'rapid');
  assert.equal(c.done?.full, 'ok');
});

test('streamHermesChat omits profile entirely when none is selected', async () => {
  const { callbacks } = collect();
  let seenBody: Record<string, unknown> = {};
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return streamResponseFrom('data: [DONE]\n\n');
  }) as typeof fetch;

  await streamHermesChat({ prompt: 'hi', sessionId: 's', fetchImpl, ...callbacks });

  assert.ok(!('profile' in seenBody), 'default profile must not be sent explicitly');
});
