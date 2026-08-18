import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUIET_BUILT_IN_TOOLS,
  QUIET_TURN_CONFIG,
  withVoiceBehaviorSection,
} from './elevenlabs-prompt.mjs';

test('quiet turn config does not re-engage during an open Camille session', () => {
  assert.equal(QUIET_TURN_CONFIG.turn_timeout, -1);
  assert.equal(QUIET_TURN_CONFIG.turn_eagerness, 'patient');
  assert.equal(QUIET_TURN_CONFIG.silence_end_call_timeout, -1);
  assert.equal(QUIET_TURN_CONFIG.soft_timeout_config.timeout_seconds, -1);
});

test('voice behavior tells Camille to stop after answering', () => {
  const prompt = withVoiceBehaviorSection('You are Camille.\n\n# Goal\nHelp the user.');

  assert.match(prompt, /Never re-engage the user because of silence/);
  assert.match(prompt, /Do not ask .*what next/i);
  assert.ok(prompt.indexOf('# Voice behavior') < prompt.indexOf('# Goal'));
});

test('voice behavior skips ambient noise instead of commenting on it', () => {
  const prompt = withVoiceBehaviorSection('You are Camille.');

  assert.match(prompt, /ambient sounds/i);
  assert.match(prompt, /call `skip_turn`/i);
  assert.deepEqual(QUIET_BUILT_IN_TOOLS.skip_turn.params, {
    system_tool_type: 'skip_turn',
  });
});

test('voice behavior replacement is idempotent', () => {
  const once = withVoiceBehaviorSection('You are Camille.\n\n# Goal\nHelp the user.');
  const twice = withVoiceBehaviorSection(once);

  assert.equal(twice, once);
  assert.equal((twice.match(/# Voice behavior/g) ?? []).length, 1);
});
