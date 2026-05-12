/**
 * Post-build script: copies static assets into the Next.js standalone output
 * so the packaged Electron app is self-contained.
 *
 * Run after `next build` and before `electron-builder`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STANDALONE = path.join(ROOT, '.next', 'standalone');
const STATIC_SRC = path.join(ROOT, '.next', 'static');
const STATIC_DEST = path.join(STANDALONE, '.next', 'static');
const PUBLIC_SRC = path.join(ROOT, 'public');
const PUBLIC_DEST = path.join(STANDALONE, 'public');
// Copy the whole scripts dir (includes dist/computer_use binary)
const SCRIPTS_SRC = path.join(ROOT, 'scripts');
const SCRIPTS_DEST = path.join(STANDALONE, 'scripts');
const ELEMENTS_SRC = path.join(ROOT, 'elements');
const ELEMENTS_DEST = path.join(STANDALONE, 'elements');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  [skip] ${src} does not exist`);
    return;
  }
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log(`  [ok] ${path.relative(ROOT, src)} → ${path.relative(ROOT, dest)}`);
}

console.log('\n📦 Post-build: copying assets into standalone output...\n');

// If a previous packaging run left ./release inside standalone, remove it or
// the next electron-builder pass nests full installers inside the app (GB bloat).
const strayRelease = path.join(STANDALONE, 'release');
if (fs.existsSync(strayRelease)) {
  fs.rmSync(strayRelease, { recursive: true, force: true });
  console.log('  [ok] removed stray .next/standalone/release (prevents recursive pack)\n');
}

copyDir(STATIC_SRC, STATIC_DEST);
copyDir(PUBLIC_SRC, PUBLIC_DEST);
copyDir(SCRIPTS_SRC, SCRIPTS_DEST);
copyDir(ELEMENTS_SRC, ELEMENTS_DEST);

// Strip macOS extended attributes (resource forks) from the standalone output.
// Without this, codesign fails with "resource fork, Finder information, or
// similar detritus not allowed" when packaging on macOS.
if (process.platform === 'darwin') {
  const { execSync } = require('child_process');
  try {
    execSync(`xattr -cr "${STANDALONE}"`, { stdio: 'pipe' });
    console.log('  [ok] stripped extended attributes from standalone output');
  } catch {
    // Non-fatal — xattr may not be available in all environments
  }
}

// Scrub any sensitive files that Next.js may have copied from the project root
// into the standalone output. These must never ship inside a packaged app.
const SENSITIVE_FILES = [
  'jarvis-server-settings.json',
  'jarvis-mcp.config.json',
  'jarvis-skills.config.json',
  '.env',
  '.env.local',
];
for (const f of SENSITIVE_FILES) {
  const target = path.join(STANDALONE, f);
  if (fs.existsSync(target)) {
    fs.rmSync(target);
    console.log(`  [scrubbed] ${f} removed from standalone (contains secrets)`);
  }
}

console.log('\n✅ Standalone output is ready.\n');
