import assert from 'node:assert/strict';
import test from 'node:test';

import { GET, POST } from './route.ts';

const FAKE_KEY = ['unit', 'test', 'auth', 'token'].join('-');

function withFakeKey<T>(run: () => Promise<T>): Promise<T> {
  const originalKey = process.env.API_SERVER_KEY;
  process.env.API_SERVER_KEY = FAKE_KEY;
  return run().finally(() => {
    if (originalKey === undefined) delete process.env.API_SERVER_KEY;
    else process.env.API_SERVER_KEY = originalKey;
  });
}

test('GET reads a session transcript oldest-first', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (input) => {
    seenUrl = input.toString();
    return new Response(JSON.stringify({
      object: 'list',
      session_id: 'sess_1',
      data: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi there' }],
      pagination: { limit: 500, offset: 0, order: 'oldest', returned: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await withFakeKey(async () => {
      const request = new Request('http://localhost/api/hermes/sessions/sess_1/messages');
      const response = await GET(request as never, { params: Promise.resolve({ id: 'sess_1' }) });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      });
      assert.equal(seenUrl, 'http://127.0.0.1:8644/api/sessions/sess_1/messages?order=oldest');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST sends a message to an existing session and returns the reply', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenBody: unknown;
  globalThis.fetch = async (input, init) => {
    seenUrl = input.toString();
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      object: 'hermes.session.chat.completion',
      session_id: 'sess_1',
      message: { role: 'assistant', content: 'Done.' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await withFakeKey(async () => {
      const request = new Request('http://localhost/api/hermes/sessions/sess_1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Run the tests' }),
      });
      const response = await POST(request as never, { params: Promise.resolve({ id: 'sess_1' }) });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        message: { role: 'assistant', content: 'Done.' },
      });
      assert.equal(seenUrl, 'http://127.0.0.1:8644/api/sessions/sess_1/chat');
      assert.deepEqual(seenBody, { message: 'Run the tests' });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST rejects an empty message before calling Hermes', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response();
  };

  try {
    await withFakeKey(async () => {
      const request = new Request('http://localhost/api/hermes/sessions/sess_1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '   ' }),
      });
      const response = await POST(request as never, { params: Promise.resolve({ id: 'sess_1' }) });

      assert.equal(response.status, 400);
      assert.equal(called, false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
