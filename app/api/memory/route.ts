import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Per-account long-term memory for Jarvis.
 *
 * ElevenLabs only exposes `memory_entry_search` as a built-in tool on this
 * workspace tier — creating and updating entries is not available — so the
 * store lives here and is surfaced to the agent through the remember / recall /
 * forget client tools.
 *
 * Entries are grouped by `accountId` so several people can share one Jarvis
 * install without seeing each other's memories.
 */

const MAX_ENTRIES_PER_ACCOUNT = 500;

export interface MemoryEntry {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
}

type MemoryFile = Record<string, MemoryEntry[]>;

function getMemoryPath(): string {
  const base = process.env.JARVIS_DATA_DIR || process.cwd();
  return path.join(base, 'jarvis-memory.json');
}

function readAll(): MemoryFile {
  try {
    const p = getMemoryPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as MemoryFile;
  } catch {
    return {};
  }
}

function writeAll(data: MemoryFile): void {
  fs.writeFileSync(getMemoryPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function normalizeAccount(value: unknown): string {
  if (typeof value !== 'string') return 'default';
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed.slice(0, 64) : 'default';
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to',
  'of', 'in', 'on', 'at', 'for', 'my', 'me', 'i', 'you', 'it', 'that', 'this',
  'do', 'does', 'did', 'what', 'whats', 'who', 'how', 'about',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Ranks entries against a query using token overlap, then breaks ties with
 * importance and recency. Deliberately dependency-free — the corpus is capped
 * at a few hundred short strings per account, so a linear scan is plenty.
 */
function scoreEntry(entry: MemoryEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) return entry.importance;

  const haystack = `${entry.text} ${entry.category}`.toLowerCase();
  const entryTokens = new Set(tokenize(haystack));

  let overlap = 0;
  for (const token of queryTokens) {
    if (entryTokens.has(token)) overlap += 1;
    else if (haystack.includes(token)) overlap += 0.5;
  }
  if (overlap === 0) return 0;

  const coverage = overlap / queryTokens.length;
  const ageDays =
    (Date.now() - new Date(entry.createdAt).getTime()) / 86_400_000;
  const recency = 1 / (1 + Math.max(0, ageDays) / 90);

  return coverage * 10 + entry.importance * 2 + recency;
}

function summarize(entries: MemoryEntry[], limit: number): string {
  return entries
    .slice(0, limit)
    .map((e) => `- [${e.category}] ${e.text}`)
    .join('\n');
}

/** GET /api/memory?accountId=kevin&limit=25 — digest injected at session start. */
export async function GET(req: NextRequest) {
  const accountId = normalizeAccount(req.nextUrl.searchParams.get('accountId'));
  const limit = Math.min(
    Number(req.nextUrl.searchParams.get('limit')) || 25,
    100,
  );

  const entries = readAll()[accountId] ?? [];
  const ranked = [...entries].sort(
    (a, b) =>
      b.importance - a.importance ||
      new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime(),
  );

  return NextResponse.json({
    accountId,
    total: entries.length,
    entries: ranked.slice(0, limit),
    digest: summarize(ranked, limit),
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const accountId = normalizeAccount(body.accountId);
  const all = readAll();
  const entries = all[accountId] ?? [];

  if (action === 'remember') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return NextResponse.json(
        { error: 'text is required' },
        { status: 400 },
      );
    }

    const category =
      typeof body.category === 'string' && body.category.trim()
        ? body.category.trim().toLowerCase().slice(0, 40)
        : 'general';
    const importance = Math.min(
      Math.max(Number(body.importance) || 0.5, 0),
      1,
    );

    // Overwrite a near-identical memory instead of accumulating duplicates.
    const existing = entries.find(
      (e) => e.text.toLowerCase() === text.toLowerCase(),
    );
    if (existing) {
      existing.category = category;
      existing.importance = Math.max(existing.importance, importance);
      existing.lastUsedAt = new Date().toISOString();
      all[accountId] = entries;
      writeAll(all);
      return NextResponse.json({
        ok: true,
        updated: true,
        id: existing.id,
        total: entries.length,
      });
    }

    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      text: text.slice(0, 500),
      category,
      importance,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      useCount: 0,
    };
    entries.push(entry);

    // Evict the least important / stalest entries once over the cap.
    if (entries.length > MAX_ENTRIES_PER_ACCOUNT) {
      entries.sort(
        (a, b) =>
          b.importance - a.importance ||
          new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime(),
      );
      entries.length = MAX_ENTRIES_PER_ACCOUNT;
    }

    all[accountId] = entries;
    writeAll(all);
    return NextResponse.json({
      ok: true,
      created: true,
      id: entry.id,
      total: entries.length,
    });
  }

  if (action === 'recall') {
    const query = typeof body.query === 'string' ? body.query : '';
    const limit = Math.min(Number(body.limit) || 5, 25);
    const queryTokens = tokenize(query);

    const hits = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const now = new Date().toISOString();
    for (const { entry } of hits) {
      entry.lastUsedAt = now;
      entry.useCount += 1;
    }
    if (hits.length) {
      all[accountId] = entries;
      writeAll(all);
    }

    return NextResponse.json({
      ok: true,
      count: hits.length,
      memories: hits.map(({ entry }) => ({
        id: entry.id,
        text: entry.text,
        category: entry.category,
      })),
      summary: hits.length
        ? summarize(hits.map((h) => h.entry), limit)
        : 'No matching memories.',
    });
  }

  if (action === 'forget') {
    const id = typeof body.id === 'string' ? body.id : '';
    const query = typeof body.query === 'string' ? body.query : '';

    let removed: MemoryEntry[] = [];
    if (id) {
      removed = entries.filter((e) => e.id === id);
      all[accountId] = entries.filter((e) => e.id !== id);
    } else if (query) {
      const queryTokens = tokenize(query);
      const best = entries
        .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)[0];
      if (best) {
        removed = [best.entry];
        all[accountId] = entries.filter((e) => e.id !== best.entry.id);
      }
    } else {
      return NextResponse.json(
        { error: 'id or query is required' },
        { status: 400 },
      );
    }

    if (removed.length === 0) {
      return NextResponse.json({ ok: true, removed: 0, message: 'No matching memory found.' });
    }

    writeAll(all);
    return NextResponse.json({
      ok: true,
      removed: removed.length,
      forgot: removed.map((e) => e.text),
    });
  }

  if (action === 'list') {
    return NextResponse.json({ ok: true, total: entries.length, entries });
  }

  return NextResponse.json(
    { error: `unknown action: ${action || '(none)'}` },
    { status: 400 },
  );
}
