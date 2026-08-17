import { app, dialog, net } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Self-updater for unsigned builds.
 *
 * electron-updater refuses to install updates on macOS without a code
 * signature, so this module does the swap itself: check the GitHub fork for a
 * newer release, download the zip for this arch, unpack it with `ditto`
 * (preserves bundle structure and resource forks), then hand off to a detached
 * shell script that waits for the app to exit, replaces the bundle in place,
 * strips the quarantine flag, and relaunches.
 *
 * Deliberately conservative: any failure at any step logs and gives up until
 * the next check. The running app is never touched until the new bundle is
 * fully extracted and verified on disk.
 */

const REPO = 'malcmitch/JarvisV5';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const FIRST_CHECK_DELAY_MS = 15 * 1000;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

let updateInProgress = false;

function parseVersion(v: string): number[] {
  return v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = r[i] ?? 0;
    const b = l[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function pickAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  const wantArm = process.arch === 'arm64';
  const zips = assets.filter((a) => a.name.endsWith('.zip') && a.name.includes('mac'));
  const match = zips.find((a) => (wantArm ? a.name.includes('arm64') : !a.name.includes('arm64')));
  return match ?? null;
}

async function fetchLatestRelease(): Promise<Release | null> {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'camille-self-update', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as Release;
  } catch {
    return null;
  }
}

async function downloadToFile(url: string, dest: string): Promise<boolean> {
  try {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': 'camille-self-update' },
    });
    if (!res.ok || !res.body) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return buf.length > 1024 * 1024; // sanity: a real app zip is > 1 MB
  } catch {
    return false;
  }
}

function runDitto(zipPath: string, destDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/ditto', ['-x', '-k', zipPath, destDir], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function currentBundlePath(): string | null {
  // .../Camille.app/Contents/MacOS/Camille -> .../Camille.app
  const exe = app.getPath('exe');
  const bundle = path.resolve(exe, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

async function applyUpdate(release: Release, asset: ReleaseAsset): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camille-update-'));
  const zipPath = path.join(workDir, asset.name);

  if (!(await downloadToFile(asset.browser_download_url, zipPath))) {
    console.error('[self-update] download failed');
    return;
  }

  const extractDir = path.join(workDir, 'extracted');
  fs.mkdirSync(extractDir);
  if (!(await runDitto(zipPath, extractDir))) {
    console.error('[self-update] unzip failed');
    return;
  }

  const appName = fs.readdirSync(extractDir).find((n) => n.endsWith('.app'));
  const oldBundle = currentBundlePath();
  if (!appName || !oldBundle) {
    console.error('[self-update] no .app in zip or cannot locate current bundle');
    return;
  }
  const newBundle = path.join(extractDir, appName);
  // The new bundle may carry a different display name (e.g. Jarvis -> Camille);
  // install it under its own name next to the old one.
  const destBundle = path.join(path.dirname(oldBundle), appName);

  const script = [
    '#!/bin/bash',
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.5; done`,
    `rm -rf ${JSON.stringify(oldBundle)}`,
    `rm -rf ${JSON.stringify(destBundle)}`,
    `mv ${JSON.stringify(newBundle)} ${JSON.stringify(destBundle)}`,
    `xattr -cr ${JSON.stringify(destBundle)} 2>/dev/null || true`,
    `open ${JSON.stringify(destBundle)}`,
    `rm -rf ${JSON.stringify(workDir)}`,
  ].join('\n');
  const scriptPath = path.join(workDir, 'swap.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

async function checkOnce(interactive: boolean): Promise<void> {
  if (updateInProgress) return;
  const release = await fetchLatestRelease();
  if (!release) return;
  const remote = release.tag_name;
  if (!isNewer(remote, app.getVersion())) return;

  const asset = pickAsset(release.assets);
  if (!asset) {
    console.error(`[self-update] release ${remote} has no matching mac zip asset`);
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Update available',
    message: `Camille ${remote.replace(/^v/, '')} is available (you have ${app.getVersion()}).`,
    detail: 'Camille will download the update, restart, and pick up right where she left off.',
    buttons: ['Install and restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  updateInProgress = true;
  try {
    await applyUpdate(release, asset);
  } finally {
    updateInProgress = false;
  }
  void interactive;
}

export function startSelfUpdate(): void {
  if (process.platform !== 'darwin') return; // mac-only for now
  if (!app.isPackaged) return; // never in dev
  setTimeout(() => void checkOnce(false), FIRST_CHECK_DELAY_MS);
  setInterval(() => void checkOnce(false), CHECK_INTERVAL_MS);
}
