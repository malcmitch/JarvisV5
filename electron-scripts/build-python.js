/**
 * Compiles scripts/computer_use.py into a self-contained binary using
 * PyInstaller inside a minimal virtual environment (.venv_jarvis).
 *
 * Skips recompilation if the binary already exists and the source hasn't
 * changed (comparing mtime). Run `npm run build:python` to force a rebuild.
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const VENV = path.join(ROOT, '.venv_jarvis');
const SCRIPT = path.join(ROOT, 'scripts', 'computer_use.py');
const BINARY_NAME = process.platform === 'win32' ? 'computer_use.exe' : 'computer_use';
const DIST_DIR = path.join(ROOT, 'scripts', 'dist');
const BINARY = path.join(DIST_DIR, BINARY_NAME);

// Windows venvs put their executables in Scripts\, every other platform in bin/.
const IS_WIN = process.platform === 'win32';
const VENV_BIN = path.join(VENV, IS_WIN ? 'Scripts' : 'bin');

const VENV_PYTHON = path.join(VENV_BIN, IS_WIN ? 'python.exe' : 'python3');
const VENV_PIP = path.join(VENV_BIN, IS_WIN ? 'pip.exe' : 'pip');
const VENV_PYINSTALLER = path.join(VENV_BIN, IS_WIN ? 'pyinstaller.exe' : 'pyinstaller');

// Candidate system Python3 binaries for creating the venv. Windows installs and
// the setup-python CI action both expose it as `python`, with no `python3` shim.
const PYTHON_CANDIDATES = [
  path.join(os.homedir(), 'opt', 'anaconda3', 'bin', 'python3'),
  path.join(os.homedir(), 'anaconda3', 'bin', 'python3'),
  '/opt/anaconda3/bin/python3',
  path.join(os.homedir(), 'opt', 'miniconda3', 'bin', 'python3'),
  '/opt/miniconda3/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  'python3',
  'python',
];

// Both binaries are built from one shared venv, so PyInstaller will happily
// trace its way into the other script's dependency tree and bundle it. Naming
// the exclusions keeps each binary to what it actually imports.
//
// Note that scipy and sklearn cannot be excluded from wake_word: openwakeword's
// __init__ imports custom_verifier_model, which imports both at module level,
// so dropping them turns `import openwakeword` into an ImportError at runtime.
const DEV_ONLY_MODULES = [
  'PyInstaller',
  'PyObjCTest',
  'IPython',
  'pytest',
  'matplotlib',
  'pandas',
  'tkinter',
];

const COMPUTER_USE_EXCLUDES = [
  ...DEV_ONLY_MODULES,
  'scipy',
  'sklearn',
  'onnxruntime',
  'openwakeword',
  'sounddevice',
];

const WAKE_WORD_EXCLUDES = [
  ...DEV_ONLY_MODULES,
  'openai',
  'pyautogui',
  'mss',
];

const excludeArgs = (modules) => modules.flatMap((m) => ['--exclude-module', m]);

function findSystemPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      if (candidate !== 'python3' && !fs.existsSync(candidate)) continue;
      execFileSync(candidate, ['--version'], { timeout: 3000, stdio: 'pipe' });
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error('No Python 3 found. Please install Python 3 to build the computer-use binary.');
}

function isBinaryFresh() {
  if (!fs.existsSync(BINARY)) return false;
  const binaryMtime = fs.statSync(BINARY).mtimeMs;
  const sourceMtime = fs.statSync(SCRIPT).mtimeMs;
  return binaryMtime > sourceMtime;
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// Packaging must not depend on PyInstaller succeeding. The app already falls back
// to running the .py with the user's own Python when the binary for their platform
// is absent (see extraResources in electron-builder.yml), so a release build sets
// this and compiles the binaries in a separate step that is allowed to fail.
if (process.env.JARVIS_SKIP_PYTHON === '1') {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  console.log(
    '\n🐍 build:python — skipped (JARVIS_SKIP_PYTHON=1). Whatever is already in\n' +
      '   scripts/dist gets packaged; the .py fallback covers anything missing.\n'
  );
  process.exit(0);
}

console.log('\n🐍 build:python — compiling computer_use binary...\n');

// Ensure venv exists
if (!fs.existsSync(VENV_PYTHON)) {
  console.log('  Creating virtual environment...');
  const sysPython = findSystemPython();
  run(sysPython, ['-m', 'venv', VENV]);
}

// Ensure required packages are installed
console.log('  Installing/verifying Python dependencies...');
run(VENV_PIP, ['install', '--quiet', 'mss', 'pyautogui', 'openai', 'Pillow', 'pyinstaller', 'openwakeword', 'sounddevice']);

// ── Build computer_use binary ──
if (isBinaryFresh()) {
  console.log('  [skip] computer_use binary is up-to-date.\n');
} else {
  console.log('  Running PyInstaller for computer_use...');
  run(VENV_PYINSTALLER, [
    '--onefile',
    '--name', 'computer_use',
    '--distpath', DIST_DIR,
    '--workpath', path.join(ROOT, '.pyinstaller', 'build'),
    '--specpath', path.join(ROOT, '.pyinstaller'),
    ...excludeArgs(COMPUTER_USE_EXCLUDES),
    SCRIPT,
  ]);

  if (!fs.existsSync(BINARY)) {
    console.error('\n❌ PyInstaller did not produce the computer_use binary.\n');
    process.exit(1);
  }
  console.log(`\n✅ computer_use binary ready: ${path.relative(ROOT, BINARY)} (${(fs.statSync(BINARY).size / 1e6).toFixed(1)} MB)\n`);
}

// ── Build wake_word binary ──────────────────────────────────────────
const WAKE_WORD_SCRIPT = path.join(ROOT, 'scripts', 'wake_word.py');
const WAKE_WORD_BINARY_NAME = process.platform === 'win32' ? 'wake_word.exe' : 'wake_word';
const WAKE_WORD_BINARY = path.join(DIST_DIR, WAKE_WORD_BINARY_NAME);
const WAKE_WORD_MODEL_DIR = path.join(ROOT, 'scripts', 'wakeword_models');
const WAKE_WORD_MODELS = [
  path.join(WAKE_WORD_MODEL_DIR, 'jarvis.onnx'),
  path.join(WAKE_WORD_MODEL_DIR, 'jarvis.tflite'),
];

function validateWakeWordModel() {
  for (const modelPath of WAKE_WORD_MODELS) {
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Wake word model missing: ${modelPath}`);
    }

    const stat = fs.statSync(modelPath);
    const head = fs.readFileSync(modelPath, { encoding: 'utf8', flag: 'r' }).slice(0, 256);
    if (stat.size < 100000 || /^\s*</.test(head)) {
      throw new Error(
        `Wake word model is not a valid binary: ${modelPath}. Re-download jarvis_v2 models from raw GitHub URLs.`
      );
    }
  }
}

function isWakeWordBinaryFresh() {
  if (!fs.existsSync(WAKE_WORD_BINARY)) return false;
  const binaryMtime = fs.statSync(WAKE_WORD_BINARY).mtimeMs;
  if (!fs.existsSync(WAKE_WORD_MODEL_DIR)) return false;
  let latestInput = Math.max(
    fs.statSync(WAKE_WORD_SCRIPT).mtimeMs,
    fs.statSync(__filename).mtimeMs
  );
  for (const f of fs.readdirSync(WAKE_WORD_MODEL_DIR)) {
    const mtime = fs.statSync(path.join(WAKE_WORD_MODEL_DIR, f)).mtimeMs;
    if (mtime > latestInput) latestInput = mtime;
  }
  return binaryMtime > latestInput;
}

validateWakeWordModel();

if (isWakeWordBinaryFresh()) {
  console.log('  [skip] wake_word binary is up-to-date.\n');
} else {
  console.log('\n🔊 Building wake_word binary...\n');
  const sep = process.platform === 'win32' ? ';' : ':';
  run(VENV_PYINSTALLER, [
    '--onefile',
    '--name', 'wake_word',
    '--distpath', DIST_DIR,
    '--workpath', path.join(ROOT, '.pyinstaller', 'build'),
    '--specpath', path.join(ROOT, '.pyinstaller'),
    '--collect-data', 'openwakeword',
    '--add-data', WAKE_WORD_MODEL_DIR + sep + 'wakeword_models',
    ...excludeArgs(WAKE_WORD_EXCLUDES),
    WAKE_WORD_SCRIPT,
  ]);

  if (!fs.existsSync(WAKE_WORD_BINARY)) {
    console.error('\n❌ PyInstaller did not produce wake_word binary.\n');
    process.exit(1);
  }
  console.log(`\n✅ wake_word binary ready: ${path.relative(ROOT, WAKE_WORD_BINARY)} (${(fs.statSync(WAKE_WORD_BINARY).size / 1e6).toFixed(1)} MB)\n`);
}
