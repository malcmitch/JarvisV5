import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { listHermesProfiles, parseApiServerPort, readHermesProfile } from './hermes-config.ts';

const run = promisify(execFile);

/**
 * Profile management: create profiles, expose their API server, and start or
 * stop their gateway on demand — all without leaving Camille.
 *
 * Design notes:
 *
 *  - Every mutation goes through Hermes's own CLI (`hermes profile create`,
 *    `hermes config set`, `hermes gateway install`) rather than Camille
 *    hand-editing config.yaml or writing launchd plists. Hermes owns those
 *    formats; duplicating them here would drift the moment Hermes changes.
 *
 *  - Gateways are installed with --no-start-on-login deliberately. Each
 *    running gateway is a persistent Python process, and a machine with a
 *    handful of profiles would otherwise boot with a handful of daemons.
 *    Camille starts one on demand when you pick it, and stops it when you're
 *    done, so memory is only spent on profiles actually in use.
 *
 *  - Commands are executed with execFile and an argv array (never a shell
 *    string), and profile names are validated against a strict pattern before
 *    they reach any command or filesystem path.
 */

const HERMES_HOME = path.join(os.homedir(), '.hermes');
const PYTHON = path.join(HERMES_HOME, 'hermes-agent', 'venv', 'bin', 'python');
const CLI_MODULE = 'hermes_cli.main';

/** Ports Camille will allocate to new profiles. 8644 is camille's. */
const PORT_RANGE_START = 8645;
const PORT_RANGE_END = 8699;

/** Hermes names its launchd jobs after the profile. */
export function launchdLabel(profile: string): string {
  return `ai.hermes.gateway-${profile}`;
}

/**
 * Hermes requires lowercase alphanumeric profile names. Enforcing that here
 * also guarantees the name is safe to interpolate into a launchd label and to
 * join into a filesystem path.
 */
export function isValidProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(name);
}

export function assertValidProfileName(name: string): void {
  if (!isValidProfileName(name)) {
    throw new Error(
      'Profile names must be lowercase letters, numbers, or hyphens (2–40 characters).',
    );
  }
}

async function hermes(args: string[], profile?: string): Promise<string> {
  const argv = ['-m', CLI_MODULE, ...(profile ? ['--profile', profile] : []), ...args];
  const { stdout } = await run(PYTHON, argv, {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function launchctl(args: string[]): Promise<string> {
  const { stdout } = await run('/bin/launchctl', args, { timeout: 60_000 });
  return stdout.trim();
}

const guiTarget = (label: string) => `gui/${process.getuid?.() ?? 501}/${label}`;

/**
 * Picks the lowest unused port in the allocation range. Reads every profile's
 * configured port so two profiles can never collide, even if one of them has
 * never been started.
 */
export async function allocatePort(): Promise<number> {
  const taken = new Set<number>();
  const profiles = await listHermesProfiles();
  for (const p of profiles) if (p.port) taken.add(p.port);

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error('No free port available in the Hermes range (8645–8699).');
}

/** True when the profile directory already exists on disk. */
export async function profileExists(name: string): Promise<boolean> {
  try {
    await readFile(path.join(HERMES_HOME, 'profiles', name, 'config.yaml'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Ensures the profile's .env carries an API_SERVER_KEY, creating one if absent. */
export async function ensureApiKey(name: string): Promise<void> {
  assertValidProfileName(name);
  const envPath = path.join(HERMES_HOME, 'profiles', name, '.env');
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch {
    existing = '';
  }
  if (/^\s*API_SERVER_KEY\s*=\s*\S/m.test(existing)) return;

  const key = randomBytes(32).toString('hex');
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(envPath, `${prefix}API_SERVER_KEY=${key}\n`, { mode: 0o600 });
}

/**
 * Turns on a profile's local API server and gives it a port, so Camille can
 * talk to it. Idempotent: an already-configured profile keeps its port.
 */
export async function enableApiServer(name: string): Promise<number> {
  assertValidProfileName(name);
  const existing = await readHermesProfile(name);
  // existing?.port is null for a profile that has never had an API server.
  const port = existing?.port ?? (await allocatePort());

  await hermes(['config', 'set', 'platforms.api_server.enabled', 'true'], name);
  await hermes(['config', 'set', 'platforms.api_server.extra.host', '127.0.0.1'], name);
  await hermes(['config', 'set', 'platforms.api_server.extra.port', String(port)], name);
  await ensureApiKey(name);
  return port;
}

/**
 * Installs the profile's launchd job with login-start disabled. The job exists
 * so Camille can start it on demand, but the machine doesn't pay for it at
 * every boot.
 *
 * Hermes writes RunAtLoad=true regardless of --no-start-on-login (verified
 * against hermes gateway install on 2026-08-18), so the flag is passed for
 * correctness and the key is then flipped directly. This is the one place
 * Camille touches a plist; everything else goes through the Hermes CLI.
 * Toggling one boolean is a narrow, reversible edit, and leaving it alone
 * would silently defeat the whole on-demand design.
 */
export async function installGatewayJob(name: string): Promise<void> {
  assertValidProfileName(name);
  await hermes(
    ['gateway', 'install', '--force', '--no-start-now', '--no-start-on-login'],
    name,
  );
  await disableRunAtLoad(name);
}

/** Path to the launchd plist Hermes generates for a profile's gateway. */
export function plistPath(name: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel(name)}.plist`);
}

/**
 * Flips RunAtLoad to false so the gateway doesn't start at login, then
 * reloads the job definition so launchd picks up the change. Silently does
 * nothing if the plist is missing or already disabled.
 */
export async function disableRunAtLoad(name: string): Promise<void> {
  assertValidProfileName(name);
  const file = plistPath(name);
  let xml: string;
  try {
    xml = await readFile(file, 'utf8');
  } catch {
    return;
  }

  const pattern = /(<key>RunAtLoad<\/key>\s*)<true\s*\/>/;
  if (!pattern.test(xml)) return; // already false, or key absent

  await writeFile(file, xml.replace(pattern, '$1<false/>'), 'utf8');

  // Reload so launchd reads the edited definition. bootout may fail when the
  // job isn't currently loaded, which is fine.
  try {
    await launchctl(['bootout', guiTarget(launchdLabel(name))]);
  } catch {
    // Not loaded.
  }
  try {
    await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 501}`, file]);
  } catch {
    // Already bootstrapped.
  }
}

export async function createProfile(
  name: string,
  opts?: { cloneFrom?: string; description?: string },
): Promise<{ name: string; port: number }> {
  assertValidProfileName(name);
  if (await profileExists(name)) {
    throw new Error(`Profile "${name}" already exists.`);
  }

  const args = ['profile', 'create', name];
  if (opts?.cloneFrom) {
    assertValidProfileName(opts.cloneFrom);
    args.push('--clone-from', opts.cloneFrom);
  }
  if (opts?.description) args.push('--description', opts.description.slice(0, 300));

  await hermes(args);
  const port = await enableApiServer(name);
  await installGatewayJob(name);
  return { name, port };
}

/** Starts a profile's gateway, installing its launchd job first if needed. */
export async function startGateway(name: string): Promise<void> {
  assertValidProfileName(name);
  const label = launchdLabel(name);
  try {
    await launchctl(['kickstart', '-k', guiTarget(label)]);
  } catch {
    // Job isn't loaded yet — install it, then start.
    await installGatewayJob(name);
    await launchctl(['kickstart', '-k', guiTarget(label)]);
  }
}

/**
 * Stops a profile's gateway and frees its memory. Uses bootout rather than a
 * signal because Hermes's jobs set KeepAlive: a killed process would simply
 * be restarted by launchd.
 */
export async function stopGateway(name: string): Promise<void> {
  assertValidProfileName(name);
  await launchctl(['bootout', guiTarget(launchdLabel(name))]);
}

/** Reads a profile's configured port straight from disk (no health check). */
export async function configuredPort(name: string): Promise<number | null> {
  assertValidProfileName(name);
  try {
    const text = await readFile(path.join(HERMES_HOME, 'profiles', name, 'config.yaml'), 'utf8');
    return parseApiServerPort(text);
  } catch {
    return null;
  }
}
