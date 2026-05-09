import { NextRequest, NextResponse } from 'next/server';
import { McpServerManager } from '@/app/lib/mcp/server-manager';
import { GOOGLE_CALENDAR_SERVER_NAME } from '@/app/lib/mcp/dynamic-config';
import type { ICalEvent } from '@/app/api/ical/route';

// Common tool names used by different Google Calendar MCP implementations
const LIST_EVENT_TOOLS = [
  'list-events',
  'list_events',
  'listEvents',
  'get-events',
  'get_events',
];

interface GCalEvent {
  id?: string;
  summary?: string;
  title?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string } | string;
  end?: { dateTime?: string; date?: string } | string;
}

function normalizeEvent(ev: GCalEvent): ICalEvent {
  const rawStart = ev.start;
  const rawEnd   = ev.end;

  let startIso = '';
  let endIso   = '';
  let allDay    = false;

  if (typeof rawStart === 'string') {
    startIso = rawStart;
  } else if (rawStart?.dateTime) {
    startIso = new Date(rawStart.dateTime).toISOString();
  } else if (rawStart?.date) {
    startIso = `${rawStart.date}T00:00:00.000Z`;
    allDay = true;
  }

  if (typeof rawEnd === 'string') {
    endIso = rawEnd;
  } else if (rawEnd?.dateTime) {
    endIso = new Date(rawEnd.dateTime).toISOString();
  } else if (rawEnd?.date) {
    endIso = `${rawEnd.date}T00:00:00.000Z`;
  }

  return {
    id:          ev.id ?? Math.random().toString(36),
    title:       ev.summary ?? ev.title ?? '(No title)',
    start:       startIso,
    end:         endIso || startIso,
    allDay,
    description: ev.description || undefined,
    location:    ev.location   || undefined,
  };
}

function parseEventsFromText(text: string): GCalEvent[] {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as GCalEvent[];
    // Some MCP servers wrap in { events: [...] } or { items: [...] }
    if (parsed.events) return parsed.events as GCalEvent[];
    if (parsed.items)  return parsed.items  as GCalEvent[];
  } catch { /* fall through */ }

  // Try to extract a JSON array from mixed text
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      return JSON.parse(match[0]) as GCalEvent[];
    } catch { /* ignore */ }
  }

  return [];
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const now      = new Date();
  const timeMin  = searchParams.get('timeMin')  ?? new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const timeMax  = searchParams.get('timeMax')  ?? new Date(now.getFullYear(), now.getMonth() + 4, 0).toISOString();
  const maxResults = parseInt(searchParams.get('maxResults') ?? '250', 10);

  try {
    const manager = McpServerManager.getInstance();
    await manager.initialize();

    const server = manager.getServer(GOOGLE_CALENDAR_SERVER_NAME);
    if (!server?.connected) {
      return NextResponse.json(
        { error: 'Google Calendar MCP not connected', events: [] },
        { status: 503 },
      );
    }

    // Discover which list-events tool this implementation uses
    const toolName = LIST_EVENT_TOOLS.find((name) =>
      server.tools.some((t) => t.name === name),
    );

    if (!toolName) {
      console.error(
        '[calendar-events] No list-events tool found. Available tools:',
        server.tools.map((t) => t.name),
      );
      return NextResponse.json(
        {
          error: `No list-events tool found. Available: ${server.tools.map((t) => t.name).join(', ')}`,
          events: [],
        },
        { status: 404 },
      );
    }

    const result = await manager.callTool(GOOGLE_CALENDAR_SERVER_NAME, toolName, {
      timeMin,
      timeMax,
      maxResults,
      calendarId: 'primary',
      singleEvents: true,
      orderBy: 'startTime',
    });

    if (result.isError) {
      return NextResponse.json(
        { error: result.content[0]?.text ?? 'MCP tool error', events: [] },
        { status: 500 },
      );
    }

    const rawText  = result.content.map((c) => c.text ?? '').join('\n');
    const rawEvents = parseEventsFromText(rawText);
    const events    = rawEvents.map(normalizeEvent).filter((e) => e.start);

    return NextResponse.json({ events, toolUsed: toolName });
  } catch (err) {
    console.error('[calendar-events] Error:', err);
    return NextResponse.json(
      { error: String(err), events: [] },
      { status: 500 },
    );
  }
}
