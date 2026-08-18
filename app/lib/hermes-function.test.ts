import assert from 'node:assert/strict';
import { test } from 'node:test';

import { trimForSpeech } from './hermes-function.ts';

test('short replies pass through untouched', () => {
  const text = 'The command finished successfully.';
  assert.equal(trimForSpeech(text), text);
});

test('trims to a sentence boundary rather than mid-word', () => {
  const text = `${'A sentence that is long enough to matter. '.repeat(20)}`;
  const out = trimForSpeech(text);
  assert.ok(out.length <= 500, 'stays within the speakable limit');
  assert.ok(out.endsWith('.'), `should end on a sentence, got: ...${out.slice(-25)}`);
});

test('falls back to a word boundary when there is no punctuation', () => {
  // Command output frequently has no sentence punctuation at all.
  const text = 'token '.repeat(300);
  const out = trimForSpeech(text);
  assert.ok(out.length <= 500);
  assert.ok(!out.endsWith('toke'), 'must not cut a word in half');
});

test('handles a single unbroken blob without punctuation or spaces', () => {
  const out = trimForSpeech('x'.repeat(2000));
  assert.equal(out.length, 500, 'hard cut is the last resort');
});

test('ignores a sentence break so early it would lose the answer', () => {
  // A stray full stop near the start shouldn't truncate to two words.
  const text = `Ok. ${'more detail that the user actually wants '.repeat(30)}`;
  const out = trimForSpeech(text);
  assert.ok(out.length > 100, `kept too little: ${out}`);
});

test('respects a custom limit', () => {
  assert.ok(trimForSpeech('word '.repeat(100), 50).length <= 50);
});
