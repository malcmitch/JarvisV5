import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from './route.ts';

const FAKE_KEY = ['unit', 'test', 'auth', 'token'].join('-');

test('GET lists local Hermes sessions using the camille profile key', async () => {
  const originalKey = process.env.API_SERVER_KEY;
  const originalFetch = globalThis.fetch;
  process.env.API_SERVER_KEY = FAKE_KEY;

  let seenUrl = '';
  let seenAuth: string | null = null;
  globalThis.fetch = async (input, init) => {
    seenUrl = input.toString();
    seenAuth = new Headers(init?.headers).get('Authorization');
    return new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'sess_1', source: 'desktop', title: 'Gesture control needs', message_count: 12 },
      ],
      limit: 50,
      offset: 0,
      has_more: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await GET();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      sessions: [
        { id: 'sess_1', source: 'desktop', title: 'Gesture control needs', messageCount: 12 },
      ],
    });
    assert.equal(seenUrl, 'http://127.0.0.1:8644/api/sessions?limit=50');
    assert.equal(seenAuth, `Bearer ${FAKE_KEY}`);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.API_SERVER_KEY;
    else process.env.API_SERVER_KEY = originalKey;
  }
});
