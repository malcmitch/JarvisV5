import { NextResponse } from 'next/server';
import { JARVIS_DATA_DIR } from '@/app/lib/mcp/dynamic-config';
import path from 'path';
import fs from 'fs';

const TOKEN_PATH = path.join(JARVIS_DATA_DIR, 'google-calendar-mcp', 'tokens.json');

export async function GET() {
  const authenticated = fs.existsSync(TOKEN_PATH);
  return NextResponse.json({ authenticated, tokenPath: TOKEN_PATH });
}
