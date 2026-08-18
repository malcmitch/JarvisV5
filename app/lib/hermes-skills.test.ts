import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFrontmatterField } from './hermes-skills.ts';

const SAMPLE = [
  '---',
  'name: ascii-art',
  'description: "ASCII art: pyfiglet, cowsay, boxes, image-to-ascii."',
  'version: 4.0.0',
  'author: 0xbyt4, Hermes Agent',
  'license: MIT',
  'dependencies: []',
  '---',
  '',
  '# ASCII Art',
  'description: this line is body text, not frontmatter',
].join('\n');

test('reads plain scalar fields', () => {
  assert.equal(readFrontmatterField(SAMPLE, 'name'), 'ascii-art');
  assert.equal(readFrontmatterField(SAMPLE, 'version'), '4.0.0');
});

test('strips surrounding quotes but keeps inner punctuation', () => {
  assert.equal(
    readFrontmatterField(SAMPLE, 'description'),
    'ASCII art: pyfiglet, cowsay, boxes, image-to-ascii.',
  );
});

test('ignores matching keys in the body after the frontmatter block', () => {
  // The body repeats "description:"; the first (real) value must win.
  assert.match(readFrontmatterField(SAMPLE, 'description') ?? '', /pyfiglet/);
});

test('returns null for absent fields and for files without frontmatter', () => {
  assert.equal(readFrontmatterField(SAMPLE, 'homepage'), null);
  assert.equal(readFrontmatterField('# Just a heading\nname: nope', 'name'), null);
});

test('handles single quotes and stray whitespace', () => {
  const md = ["---", "name:    'spaced-out'   ", "---"].join('\n');
  assert.equal(readFrontmatterField(md, 'name'), 'spaced-out');
});

test('treats an empty value as missing', () => {
  assert.equal(readFrontmatterField('---\nname: \n---', 'name'), null);
});
