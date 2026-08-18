import assert from 'node:assert/strict';
import test from 'node:test';

import { HERMES_COMMAND_FUNCTION } from './hermes-function.ts';

test('Camille exposes a hermes_command voice tool', async () => {
  const tool = HERMES_COMMAND_FUNCTION;
  assert.deepEqual(tool.tool.parameters, {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The task or instruction Hermes Agent should carry out.',
      },
    },
    required: ['command'],
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input.toString(), '/api/hermes');
    assert.deepEqual(JSON.parse(String(init?.body)), { command: 'Run the checks' });
    return new Response(JSON.stringify({ ok: true, response: 'Checks passed.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    assert.deepEqual(await tool.handler({ command: 'Run the checks' }), {
      ok: true,
      response: 'Checks passed.',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
