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
// NOTE: scripts/ is deliberately NOT copied here. The PyInstaller binaries are
// ~85 MB and electron-builder already places them at Resources/scripts via
// extraResources; main.ts hands that path to the server as JARVIS_SCRIPTS_DIR.
// Copying them here too would ship the same binaries twice in every installer.
const ELEMENTS_SRC = path.join(ROOT, 'elements');
const ELEMENTS_DEST = path.join(STANDALONE, 'elements');

/**
 * Deletes iCloud conflict copies ("server 2.js", "computer_use 2", "app 3/").
 *
 * This project lives under a synced Desktop, so iCloud forks any file the build
 * rewrites while it is uploading. The forks are indistinguishable from real
 * build output to electron-builder, and they are not small: a stale
 * "computer_use 2" alone put an extra 30 MB of months-old binary into every
 * installer. Sweeping them here keeps them out of the package; moving the
 * project off the synced folder is what actually stops them being created.
 */
const ICLOUD_DUPLICATE = /^(.+?) \d+(\.[^.]+)?$/;

function purgeICloudDuplicates(dir, removed = []) {
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const match = ICLOUD_DUPLICATE.exec(entry.name);
    // Only treat it as a conflict copy if the file it shadows is really there.
    if (match && fs.existsSync(path.join(dir, `${match[1]}${match[2] || ''}`))) {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(path.relative(ROOT, full));
      continue;
    }
    if (entry.isDirectory()) purgeICloudDuplicates(full, removed);
  }
  return removed;
}

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
  '.DS_Store',
  'intro.mp4',            // unreferenced 9MB video
];
const JUNK_DIRS = [
  'electron', 'electron-scripts', 'buildfiles',
  'elevenlabs-tools',
  '.pyinstaller', '.playwright-mcp',
  'social-captures',      // runtime scratch dir, may contain session HTML/PII
  '.venv_jarvis',
  '.git',
  'scripts',              // shipped once at Resources/scripts by electron-builder
  'art-source',           // uncompressed 3D masters; public/models has the shipped versions
];

// Build-time-only packages that Next's tracer pulls in but server.js never
// requires at runtime. Each is tens of megabytes in the installer.
const JUNK_MODULES = [
  'typescript',
  '@types',
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
for (const m of JUNK_MODULES) {
  const target = path.join(STANDALONE, 'node_modules', m);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`  [ok] removed node_modules/${m}/`);
  }
}
console.log();

copyDir(STATIC_SRC, STATIC_DEST);
copyDir(PUBLIC_SRC, PUBLIC_DEST);
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

// Run last: the copies above are exactly what iCloud forks, and scripts/dist is
// packaged straight from the project tree rather than from the standalone dir.
const duplicates = [
  ...purgeICloudDuplicates(STANDALONE),
  ...purgeICloudDuplicates(path.join(ROOT, 'scripts')),
];
if (duplicates.length) {
  console.log(`\n  [ok] removed ${duplicates.length} iCloud conflict copy(ies):`);
  for (const d of duplicates.slice(0, 10)) console.log(`       ${d}`);
  if (duplicates.length > 10) console.log(`       …and ${duplicates.length - 10} more`);
}

// Report the biggest contributors so installer bloat is obvious at build time.
function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    try {
      total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch { /* unreadable entry — ignore */ }
  }
  return total;
}

const entries = fs.readdirSync(STANDALONE, { withFileTypes: true })
  .map((e) => {
    const full = path.join(STANDALONE, e.name);
    return { name: e.name, size: e.isDirectory() ? dirSize(full) : fs.statSync(full).size };
  })
  .sort((a, b) => b.size - a.size);

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`\n📊 Payload: ${mb(entries.reduce((s, e) => s + e.size, 0))} total`);
for (const e of entries.slice(0, 8)) {
  console.log(`  ${mb(e.size).padStart(10)}  ${e.name}`);
}

console.log('\n✅ Standalone output is ready.\n');
