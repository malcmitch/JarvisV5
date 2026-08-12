/**
 * Removes the unpacked app directories that electron-builder regenerates.
 *
 * electron-builder copies into these directories without emptying them first,
 * so packaging twice without a clean leaves the previous run's files behind
 * under " 2" / " 3" suffixes — including a second copy of the ~85 MB Python
 * binaries. The installer built from that directory carries all of it.
 *
 * Only the generated directories are touched; installers and anything else
 * parked in release/ are left alone.
 */

const fs = require('fs');
const path = require('path');

const RELEASE_DIR = path.resolve(__dirname, '..', 'release');

// mac-arm64, mac, win-unpacked, linux-unpacked, linux-arm64-unpacked, ...
const GENERATED = /^(mac|mac-[\w-]+|[\w-]*unpacked)$/;

if (!fs.existsSync(RELEASE_DIR)) process.exit(0);

for (const name of fs.readdirSync(RELEASE_DIR)) {
  if (!GENERATED.test(name)) continue;
  const full = path.join(RELEASE_DIR, name);
  if (!fs.statSync(full).isDirectory()) continue;
  fs.rmSync(full, { recursive: true, force: true });
  console.log(`[clean-release] removed ${name}/`);
}
