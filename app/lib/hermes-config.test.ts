import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseApiServerPort } from './hermes-config.ts';

test('parseApiServerPort reads a nested api_server port', () => {
  const yaml = ['gateway:', '  enabled: true', 'api_server:', '    enabled: true', '    port: 8644', 'other: 1'].join('\n');
  assert.equal(parseApiServerPort(yaml), 8644);
});

test('parseApiServerPort ignores a port under a different key', () => {
  const yaml = ['dashboard:', '  port: 9119', 'api_server:', '  port: 8651'].join('\n');
  assert.equal(parseApiServerPort(yaml), 8651);
});

test('parseApiServerPort does not leak past the api_server block', () => {
  const yaml = ['api_server:', '  enabled: false', 'dashboard:', '  port: 9119'].join('\n');
  assert.equal(parseApiServerPort(yaml), null);
});

test('parseApiServerPort skips comments and returns null when absent', () => {
  assert.equal(parseApiServerPort('# api_server:\n#   port: 8644\nfoo: bar'), null);
});
