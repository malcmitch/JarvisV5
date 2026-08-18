import assert from 'node:assert/strict';
import test from 'node:test';

import { POST } from './route.ts';

test('POST delegates a Camille voice command to Hermes', async () => {
  const originalKey = process.env.API_SERVER_KEY;
  const originalFetch = globalThis.fetch;
  process.env.API_SERVER_KEY = 'test-secret';

  let forwardedBody: unknown;
  globalThis.fetch = async (_input, init) => {
    forwardedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Hermes finished the task.' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const request = new Request('http://localhost/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'Inspect the project' }),
    });
    const response = await POST(request as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      response: 'Hermes finished the task.',
      sessionId: 'camille-voice',
    });
    assert.deepEqual(forwardedBody, {
      model: 'hermes-agent',
      messages: [{ role: 'user', content: 'Inspect the project' }],
      stream: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.API_SERVER_KEY;
    else process.env.API_SERVER_KEY = originalKey;
  }
});
