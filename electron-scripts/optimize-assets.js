/**
 * Compresses the 3D assets in public/models so they can ship inside an
 * installer. Source models come out of DCC tools with 4K–8K PNG textures and
 * uncompressed vertex data; a single suit was 102 MB, which is more than the
 * entire rest of the app combined.
 *
 * Each model is rewritten with meshopt-compressed geometry and WebP textures
 * capped at 2048px. Both are read natively by three's GLTFLoader — drei's
 * useGLTF installs MeshoptDecoder by default — so nothing on the render side
 * has to change.
 *
 * Originals are moved to art-source/ (gitignored) rather than overwritten, so
 * the uncompressed masters stay available for re-exporting at different
 * settings. That directory is not needed to build or run the app and can be
 * deleted or archived elsewhere.
 *
 * Usage: npm run optimize:assets [-- --force]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'models');
const MASTERS_DIR = path.join(ROOT, 'art-source', 'models');

const FORCE = process.argv.includes('--force');
const MAX_TEXTURE_SIZE = 2048;
const TMP_PREFIX = '__obj2gltf_';

/**
 * True if the GLB already carries meshopt-compressed geometry, which means a
 * previous run produced it. Re-optimizing would re-encode the WebP textures a
 * second time and lose quality for no size benefit.
 */
function isAlreadyOptimized(file) {
  if (path.extname(file).toLowerCase() !== '.glb') return false;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    // GLB: 12-byte header, then a JSON chunk (8-byte chunk header + payload).
    // The extension list lives near the start of the JSON, so a partial read
    // is enough and avoids pulling a 100 MB buffer into memory.
    const header = Buffer.alloc(20);
    if (fs.readSync(fd, header, 0, 20, 0) < 20) return false;
    if (header.readUInt32LE(0) !== 0x46546c67) return false; // 'glTF'
    // The whole JSON chunk has to be read: extensionsUsed is written after the
    // accessor and mesh tables, so it sits at the very end of the chunk.
    const jsonLength = header.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    fs.readSync(fd, json, 0, jsonLength, 20);
    return json.toString('utf8').includes('EXT_meshopt_compression');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('.') || entry.name.startsWith(TMP_PREFIX)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(glb|gltf|obj)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Wavefront OBJ stores geometry as ASCII decimal text, so a single boot part
 * runs to 18 MB. Converting to glTF is what makes it compressible at all.
 */
function objToGltf(input, output) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'obj2gltf', 'bin', 'obj2gltf.js'), '-i', input, '-o', output, '--binary'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

const models = walk(MODELS_DIR);
if (models.length === 0) {
  console.log('\n[optimize-assets] no models found — nothing to do.\n');
  process.exit(0);
}

console.log(`\n[optimize-assets] ${models.length} model(s) in public/models\n`);

let totalBefore = 0;
let totalAfter = 0;
let converted = 0;
let skipped = 0;
let failed = 0;

for (const model of models) {
  const rel = path.relative(MODELS_DIR, model);
  const sizeBefore = fs.statSync(model).size;

  if (!FORCE && isAlreadyOptimized(model)) {
    skipped++;
    totalBefore += sizeBefore;
    totalAfter += sizeBefore;
    continue;
  }

  // Stash the master, then optimize out of it. Reading from art-source keeps
  // the operation restartable: a crash mid-run can't leave a half-written file
  // as the only copy.
  const master = path.join(MASTERS_DIR, rel);
  fs.mkdirSync(path.dirname(master), { recursive: true });
  if (!fs.existsSync(master)) fs.renameSync(model, master);
  else fs.rmSync(model, { force: true });

  // .gltf models keep their payload in sibling .bin files or base64 URIs;
  // writing .glb folds everything into one binary container.
  const output = model.replace(/\.(gltf|obj)$/i, '.glb');

  // OBJ has to become glTF before the optimizer can touch it.
  let source = master;
  let intermediate = null;
  if (/\.obj$/i.test(master)) {
    // obj2gltf picks its container format from the output extension, so the
    // scratch file has to keep a real .glb suffix.
    intermediate = path.join(path.dirname(output), `${TMP_PREFIX}${path.basename(output)}`);
    const conversion = objToGltf(master, intermediate);
    if (conversion.status !== 0 || !fs.existsSync(intermediate)) {
      fs.rmSync(intermediate, { force: true });
      fs.copyFileSync(master, model);
      failed++;
      console.error(`  [fail] ${rel} (obj2gltf)`);
      console.error((conversion.stderr || conversion.stdout || '').split('\n').slice(-6).join('\n'));
      totalBefore += sizeBefore;
      totalAfter += sizeBefore;
      continue;
    }
    source = intermediate;
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js'),
      'optimize',
      source,
      output,
      '--compress', 'meshopt',
      '--texture-compress', 'webp',
      '--texture-size', String(MAX_TEXTURE_SIZE),
      // Vertex decimation is where this pipeline visibly damages a model, and
      // these assets are texture-bound rather than geometry-bound, so the size
      // it would save is not worth the artifacts.
      '--simplify', 'false',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );

  if (intermediate) fs.rmSync(intermediate, { force: true });

  if (result.status !== 0 || !fs.existsSync(output)) {
    // Put the master back so the app still has a usable asset.
    fs.copyFileSync(master, model);
    failed++;
    console.error(`  [fail] ${rel}`);
    console.error((result.stderr || result.stdout || '').split('\n').slice(-6).join('\n'));
    totalBefore += sizeBefore;
    totalAfter += sizeBefore;
    continue;
  }

  const sizeAfter = fs.statSync(output).size;
  totalBefore += sizeBefore;
  totalAfter += sizeAfter;
  converted++;

  const pct = ((1 - sizeAfter / sizeBefore) * 100).toFixed(0);
  console.log(`  ${mb(sizeBefore).padStart(9)} → ${mb(sizeAfter).padStart(9)}  (-${pct}%)  ${rel}`);
}

console.log(
  `\n[optimize-assets] ${converted} optimized, ${skipped} already compressed` +
  (failed ? `, ${failed} failed` : '')
);
console.log(`[optimize-assets] ${mb(totalBefore)} → ${mb(totalAfter)}\n`);

if (failed) process.exitCode = 1;
