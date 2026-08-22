import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The fabrication feed — CAD/STL files Hermes generates on disk, surfaced in
 * Camille's Manufacturing bay.
 *
 * GET            -> recent CAD files from the watch folders (newest first)
 * GET ?path=...  -> stream one file (STL/GLB/... for the 3D viewer)
 * POST {path, action: 'reveal'|'open'} -> Finder reveal / open in default app
 *
 * Watch folders: ~/workspace (Hermes's default workspace) plus any paths in
 * local-keys.json `fab_watch_dirs`. Streaming and open are restricted to
 * files that really live inside a watch folder (realpath check) and carry a
 * known CAD extension — this route can read disk, so it stays on a leash.
 */

const VIEWABLE = new Set(['.stl', '.glb', '.gltf']);
const CAD_EXTS = new Set([
  '.stl', '.glb', '.gltf', '.3mf', '.obj', '.step', '.stp', '.iges', '.igs',
  '.scad', '.gcode', '.dxf', '.f3d',
]);
const MAX_FILES = 120;
const MAX_AGE_MS = 45 * 86_400_000; // recent = last 45 days
const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__', 'dist', 'build', '.next']);

interface FabEntry {
  name: string;
  path: string;
  ext: string;
  size: number;
  mtime: number;
  viewable: boolean;
}

function watchRoots(): string[] {
  const roots = [path.join(os.homedir(), 'workspace')];
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.jarvis', 'local-keys.json'), 'utf-8'),
    ) as { fab_watch_dirs?: string[] };
    for (const d of raw.fab_watch_dirs ?? []) {
      if (typeof d === 'string' && d.trim()) {
        roots.push(d.replace(/^~(?=\/|$)/, os.homedir()));
      }
    }
  } catch {
    // Default root only.
  }
  return roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

function scan(dir: string, depth: number, out: FabEntry[], cutoff: number): void {
  if (depth > 4 || out.length > 600) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      scan(p, depth + 1, out, cutoff);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (!CAD_EXTS.has(ext)) continue;
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) continue;
      out.push({
        name: e.name,
        path: p,
        ext: ext.slice(1),
        size: st.size,
        mtime: st.mtimeMs,
        viewable: VIEWABLE.has(ext),
      });
    } catch {
      // File vanished mid-scan; skip.
    }
  }
}

/** Only serve/act on files that truly live inside a watch folder. */
function resolveInsideRoots(requested: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(requested);
  } catch {
    return null;
  }
  const ok = watchRoots().some((r) => {
    try {
      const rr = fs.realpathSync(r);
      return real === rr || real.startsWith(rr + path.sep);
    } catch {
      return false;
    }
  });
  if (!ok) return null;
  if (!CAD_EXTS.has(path.extname(real).toLowerCase())) return null;
  return real;
}

const MIME: Record<string, string> = {
  '.stl': 'model/stl',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain',
  '.3mf': 'model/3mf',
  '.gcode': 'text/plain',
};

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get('path');
  if (!requested) {
    const cutoff = Date.now() - MAX_AGE_MS;
    const out: FabEntry[] = [];
    for (const root of watchRoots()) scan(root, 0, out, cutoff);
    out.sort((a, b) => b.mtime - a.mtime);
    return NextResponse.json({ files: out.slice(0, MAX_FILES), roots: watchRoots() });
  }
  const real = resolveInsideRoots(requested);
  if (!real) {
    return NextResponse.json(
      { error: 'File is outside the fabrication watch folders.' },
      { status: 403 },
    );
  }
  const ext = path.extname(real).toLowerCase();
  let buf: Buffer;
  try {
    buf = fs.readFileSync(real);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: NextRequest) {
  let body: { path?: string; action?: string } = {};
  try {
    body = (await req.json()) as { path?: string; action?: string };
  } catch {
    // Handled below.
  }
  const real = body.path ? resolveInsideRoots(body.path) : null;
  if (!real) {
    return NextResponse.json(
      { error: 'File is outside the fabrication watch folders.' },
      { status: 403 },
    );
  }
  const args = body.action === 'open' ? [real] : ['-R', real];
  try {
    spawn('/usr/bin/open', args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
