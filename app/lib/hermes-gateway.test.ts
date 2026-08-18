import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getHermesSessionMessages,
  listHermesSessions,
  parseHermesApiKey,
  runHermesCommand,
  sendHermesSessionChat,
} from './hermes-gateway.ts';

const FAKE_KEY = ['unit', 'test', 'auth', 'token'].join('-');

test('runHermesCommand sends a persistent authenticated Hermes turn', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = input.toString();
    seenInit = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Task completed.' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await runHermesCommand('Check the build', {
    apiKey: FAKE_KEY,
    baseUrl: 'http://127.0.0.1:8642/',
    sessionId: 'camille-voice',
    fetchImpl,
  });

  assert.deepEqual(result, {
    response: 'Task completed.',
    sessionId: 'camille-voice',
  });
  assert.equal(seenUrl, 'http://127.0.0.1:8642/v1/chat/completions');
  assert.equal(seenInit?.method, 'POST');

  const headers = new Headers(seenInit?.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${FAKE_KEY}`);
  assert.equal(headers.get('X-Hermes-Session-Id'), 'camille-voice');
  assert.equal(headers.get('X-Hermes-Session-Key'), 'camille-voice');

  assert.deepEqual(JSON.parse(String(seenInit?.body)), {
    model: 'hermes-agent',
    messages: [{ role: 'user', content: 'Check the build' }],
    stream: false,
  });
});

test('runHermesCommand rejects an empty command before calling Hermes', async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return new Response();
  };

  await assert.rejects(
    runHermesCommand('   ', {
      apiKey: FAKE_KEY,
      baseUrl: 'http://127.0.0.1:8642',
      fetchImpl,
    }),
    /Hermes command is required/,
  );
  assert.equal(called, false);
});

test('runHermesCommand surfaces a Hermes API error', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    error: { message: 'Gateway is paused.' },
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    runHermesCommand('Do the task', {
      apiKey: FAKE_KEY,
      baseUrl: 'http://127.0.0.1:8642',
      fetchImpl,
    }),
    /Hermes gateway failed \(503\): Gateway is paused\./,
  );
});

test('parseHermesApiKey reads a quoted key without exposing other values', () => {
  const key = parseHermesApiKey([
    'OTHER_SECRET=do-not-return-this',
    'API_SERVER_KEY="gateway-secret"',
    'ANOTHER_VALUE=ignored',
  ].join('\n'));

  assert.equal(key, 'gateway-secret');
});

test('listHermesSessions returns every local session regardless of platform', async () => {
  let seenUrl = '';
  let seenHeaders: HeadersInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = input.toString();
    seenHeaders = init?.headers;
    return new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'sess_1', source: 'desktop', title: 'Gesture control needs', message_count: 12 },
        { id: 'sess_2', source: 'cli', title: 'Camille app research', message_count: 4 },
      ],
      limit: 50,
      offset: 0,
      has_more: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const sessions = await listHermesSessions({
    apiKey: FAKE_KEY,
    baseUrl: 'http://127.0.0.1:8644',
    fetchImpl,
  });

  assert.equal(seenUrl, 'http://127.0.0.1:8644/api/sessions?limit=50');
  const headers = new Headers(seenHeaders);
  assert.equal(headers.get('Authorization'), `Bearer ${FAKE_KEY}`);
  assert.deepEqual(sessions, [
    { id: 'sess_1', source: 'desktop', title: 'Gesture control needs', messageCount: 12 },
    { id: 'sess_2', source: 'cli', title: 'Camille app research', messageCount: 4 },
  ]);
});

test('listHermesSessions surfaces a Hermes API error', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    error: { message: 'Session database unavailable' },
  }), { status: 503, headers: { 'Content-Type': 'application/json' } });

  await assert.rejects(
    listHermesSessions({ apiKey: FAKE_KEY, baseUrl: 'http://127.0.0.1:8644', fetchImpl }),
    /Hermes gateway failed \(503\): Session database unavailable/,
  );
});

test('getHermesSessionMessages returns chronological role/content pairs', async () => {
  let seenUrl = '';
  const fetchImpl: typeof fetch = async (input) => {
    seenUrl = input.toString();
    return new Response(JSON.stringify({
      object: 'list',
      session_id: 'sess_1',
      data: [
        { id: '1', role: 'user', content: 'Take a photo and search social media' },
        { id: '2', role: 'assistant', content: 'I want to flag a concern before we scope this' },
      ],
      pagination: { limit: 500, offset: 0, order: 'oldest', returned: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const messages = await getHermesSessionMessages('sess_1', {
    apiKey: FAKE_KEY,
    baseUrl: 'http://127.0.0.1:8644',
    fetchImpl,
  });

  assert.equal(seenUrl, 'http://127.0.0.1:8644/api/sessions/sess_1/messages?order=oldest');
  assert.deepEqual(messages, [
    { role: 'user', content: 'Take a photo and search social media', reasoning: null },
    { role: 'assistant', content: 'I want to flag a concern before we scope this', reasoning: null },
  ]);
});

test('sendHermesSessionChat posts a message and returns the assistant reply', async () => {
  let seenUrl = '';
  let seenBody: unknown;
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = input.toString();
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      object: 'hermes.session.chat.completion',
      session_id: 'sess_1',
      message: { role: 'assistant', content: 'Done — build passes.' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const reply = await sendHermesSessionChat('sess_1', 'Run the tests', {
    apiKey: FAKE_KEY,
    baseUrl: 'http://127.0.0.1:8644',
    fetchImpl,
  });

  assert.equal(seenUrl, 'http://127.0.0.1:8644/api/sessions/sess_1/chat');
  assert.deepEqual(seenBody, { message: 'Run the tests' });
  assert.deepEqual(reply, { role: 'assistant', content: 'Done — build passes.' });
});
