/**
 * Copies the MediaPipe vision wasm runtime out of node_modules and into
 * public/mediapipe/wasm, where FilesetResolver loads it from at runtime.
 *
 * The wasm is ~33 MB and must match the installed @mediapipe/tasks-vision
 * version exactly, so it is generated here instead of being committed.
 *
 * Run via `npm run sync:mediapipe` (also wired into postinstall + build).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const DEST = path.join(ROOT, 'public', 'mediapipe', 'wasm');

if (!fs.existsSync(SRC)) {
  console.warn('[sync-mediapipe] @mediapipe/tasks-vision not installed — skipping');
  process.exit(0);
}

fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const file of fs.readdirSync(SRC)) {
  const from = path.join(SRC, file);
  const to = path.join(DEST, file);
  // Skip files that are already byte-identical so repeat builds stay fast.
  if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) continue;
  fs.copyFileSync(from, to);
  copied++;
}

// Drop stale wasm left over from a previously installed version.
const expected = new Set(fs.readdirSync(SRC));
for (const file of fs.readdirSync(DEST)) {
  if (!expected.has(file)) {
    fs.rmSync(path.join(DEST, file));
    console.log(`[sync-mediapipe] removed stale ${file}`);
  }
}

console.log(`[sync-mediapipe] wasm runtime ready (${copied} file(s) copied)`);
