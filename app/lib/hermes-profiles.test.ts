import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isValidProfileName, launchdLabel } from './hermes-profiles.ts';

test('accepts valid Hermes profile names', () => {
  for (const name of ['camille', 'bob-the-builder', 'rapid-research-seo', 'x1', 'a1b2']) {
    assert.ok(isValidProfileName(name), `${name} should be valid`);
  }
});

test('rejects names that could escape a path or a launchd label', () => {
  for (const name of [
    '../etc',
    'has space',
    'UPPER',
    'trailing-',
    '-leading',
    'semi;colon',
    '$(whoami)',
    'a',
    '',
    'a'.repeat(41),
    'quote"d',
    'new\nline',
  ]) {
    assert.equal(isValidProfileName(name), false, `${JSON.stringify(name)} should be rejected`);
  }
});

test('launchd label matches the scheme Hermes already uses', () => {
  assert.equal(launchdLabel('camille'), 'ai.hermes.gateway-camille');
});
