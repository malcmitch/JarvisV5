import { NextRequest, NextResponse } from 'next/server';
import { mkdir, writeFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/** Scratch space for the single frame a reverse-image-search run uploads.
 *  Never trust a caller-supplied path outside this dir (see DELETE below). */
const TEMP_DIR = path.join(os.tmpdir(), 'camille-reverse-search');

export async function POST(req: NextRequest) {
  try {
    const { imageBase64 } = (await req.json()) as { imageBase64?: string };
    if (!imageBase64) {
      return NextResponse.json({ error: 'Missing image' }, { status: 400 });
    }

    await mkdir(TEMP_DIR, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
    const filePath = path.join(TEMP_DIR, filename);
    await writeFile(filePath, Buffer.from(imageBase64, 'base64'));

    return NextResponse.json({ success: true, path: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Best-effort cleanup of the captured frame once the search finishes.
 *  Only ever deletes files inside our own temp dir. */
export async function DELETE(req: NextRequest) {
  try {
    const { path: filePath } = (await req.json()) as { path?: string };
    if (!filePath) {
      return NextResponse.json({ error: 'Missing path' }, { status: 400 });
    }
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(TEMP_DIR);
    if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
      return NextResponse.json({ error: 'Refusing to delete outside temp dir' }, { status: 400 });
    }
    await unlink(resolved).catch(() => { /* already gone */ });
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
