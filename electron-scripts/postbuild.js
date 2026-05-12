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

// ── Aggressively clean the standalone directory ──────────────────────────────
// Next.js copies the entire project root into standalone. Remove anything that
// is not needed at runtime — otherwise old release folders, source files, and
// config files balloon the installer by gigabytes.

// 1. Remove any directory that looks like a release / dist artifact
const releasePatterns = ['release', 'dist-electron', 'dist', 'out'];
if (!fs.existsSync(STANDALONE)) {
  console.warn(`  [skip] standalone not found — run next build first\n`);
  process.exit(0);
}
for (const name of fs.readdirSync(STANDALONE)) {
  const full = path.join(STANDALONE, name);
  // Remove directories that look like release outputs (case-insensitive contains "release")
  if (fs.statSync(full).isDirectory() && (
    releasePatterns.includes(name.toLowerCase()) ||
    name.toLowerCase().includes('release') ||
    name.toLowerCase().startsWith('jarvis release') ||
    name.toLowerCase().startsWith('jarvis setup')
  )) {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`  [ok] removed stray release dir: ${name}`);
  }
}

// 2. Remove source/config files that should never ship
const JUNK_FILES = [
  'electron-builder.yml',
  'next.config.ts', 'next.config.js', 'next.config.mjs',
  'postcss.config.mjs', 'postcss.config.js',
  'eslint.config.mjs', 'eslint.config.js', '.eslintrc.js', '.eslintrc.json',
  'tsconfig.json', 'tsconfig.electron.json', 'tsconfig.tsbuildinfo',
  'instrumentation.ts',
  'icon.png',
  'README.md', 'MCP_AND_SKILLS_README.md',
  'env.example',
  'jarvis-server-settings.json',  // secrets — must never ship
  'jarvis-mcp.config.json',
  'jarvis-skills.config.json',
  'jarvis-mcp.config.json.example',
  'jarvis-skills.config.json.example',
  'package-lock.json',
];
const JUNK_DIRS = [
  'electron', 'electron-scripts', 'buildfiles',
  'elevenlabs-tools',
  '.pyinstaller', '.playwright-mcp',
];

for (const f of JUNK_FILES) {
  const target = path.join(STANDALONE, f);
  if (fs.existsSync(target)) {
    fs.rmSync(target);
    console.log(`  [ok] removed ${f}`);
  }
}
for (const d of JUNK_DIRS) {
  const target = path.join(STANDALONE, d);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`  [ok] removed dir ${d}/`);
  }
}
console.log();

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
