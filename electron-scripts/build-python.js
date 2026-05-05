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

const VENV_PYTHON = path.join(VENV, 'bin', process.platform === 'win32' ? 'python.exe' : 'python3');
const VENV_PIP = path.join(VENV, 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
const VENV_PYINSTALLER = path.join(VENV, 'bin', process.platform === 'win32' ? 'pyinstaller.exe' : 'pyinstaller');

// Candidate system Python3 binaries for creating the venv
const PYTHON_CANDIDATES = [
  path.join(os.homedir(), 'opt', 'anaconda3', 'bin', 'python3'),
  path.join(os.homedir(), 'anaconda3', 'bin', 'python3'),
  '/opt/anaconda3/bin/python3',
  path.join(os.homedir(), 'opt', 'miniconda3', 'bin', 'python3'),
  '/opt/miniconda3/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  'python3',
];

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

console.log('\n🐍 build:python — compiling computer_use binary...\n');

if (isBinaryFresh()) {
  console.log('  [skip] binary is up-to-date.\n');
  process.exit(0);
}

// Ensure venv exists
if (!fs.existsSync(VENV_PYTHON)) {
  console.log('  Creating virtual environment...');
  const sysPython = findSystemPython();
  run(sysPython, ['-m', 'venv', VENV]);
}

// Ensure required packages are installed
console.log('  Installing/verifying Python dependencies...');
run(VENV_PIP, ['install', '--quiet', 'mss', 'pyautogui', 'openai', 'Pillow', 'pyinstaller']);

// Compile
console.log('  Running PyInstaller...');
run(VENV_PYINSTALLER, [
  '--onefile',
  '--name', 'computer_use',
  '--distpath', DIST_DIR,
  '--workpath', path.join(ROOT, '.pyinstaller', 'build'),
  '--specpath', path.join(ROOT, '.pyinstaller'),
  SCRIPT,
]);

if (!fs.existsSync(BINARY)) {
  console.error('\n❌ PyInstaller did not produce the expected binary.\n');
  process.exit(1);
}

console.log(`\n✅ Binary ready: ${path.relative(ROOT, BINARY)} (${(fs.statSync(BINARY).size / 1e6).toFixed(1)} MB)\n`);
