/**
 * Streaming support for Hermes chat.
 *
 * Two layers:
 *
 *  1. createHermesSSEParser — a pure, dependency-free SSE parser for the
 *     Hermes /v1/chat/completions stream format (OpenAI chunk shape plus a
 *     Hermes `hermes` status object and in-stream `error` objects). Pure so
 *     it runs identically in node:test, the Next server, and the renderer.
 *
 *  2. streamHermesChat — browser-side helper the HUD uses. Talks to
 *     Camille's own /api/hermes/stream proxy (never to Hermes directly —
 *     the API key must stay server-side) and feeds the parser.
 *
 * Format ground truth: tests/fixtures/hermes-stream-error-401.txt, captured
 * from a live camille-profile gateway. Notable Hermes behaviors observed:
 *  - Errors arrive as VALID SSE chunks with finish_reason "error" and both
 *    an OpenAI-style `error` object and a `hermes` status object. The HTTP
 *    status is still 200, so HTTP-level error handling alone is not enough.
 *  - A terminal `data: [DONE]` line always follows, even after an error.
 * Tool-progress event shapes are handled defensively (any unrecognized
 * delta content or hermes payload is surfaced via onToolEvent) until a
 * tool-using fixture pins the exact format.
 */

export interface HermesStreamChunk {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: unknown[];
      [key: string]: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string };
  hermes?: {
    completed?: boolean;
    partial?: boolean;
    failed?: boolean;
    error?: string;
    error_code?: string;
    [key: string]: unknown;
  };
}

export interface HermesStreamCallbacks {
  /** Incremental assistant text. */
  onDelta?: (text: string) => void;
  /** Tool activity or any structured non-text payload (shape defensive). */
  onToolEvent?: (event: { kind: string; payload: unknown }) => void;
  /** Terminal success. `full` is the concatenated assistant text. */
  onDone?: (full: string, usage?: HermesStreamChunk['usage']) => void;
  /** Terminal failure — in-stream Hermes error or transport error. */
  onError?: (message: string, code?: string) => void;
}

export interface HermesSSEParser {
  /** Feed raw decoded text as it arrives off the wire. */
  feed: (text: string) => void;
  /** Signal end of input (stream closed). Safe to call once. */
  end: () => void;
}

/**
 * Incremental SSE parser. Handles the classic pitfalls:
 *  - one event split across multiple network chunks (buffers partial lines)
 *  - multiple events arriving in a single chunk
 *  - malformed JSON data lines (skipped, never fatal)
 *  - error-in-stream with HTTP 200 (Hermes behavior, see header comment)
 *  - guarantees exactly one terminal callback (onDone OR onError)
 */
export function createHermesSSEParser(callbacks: HermesStreamCallbacks): HermesSSEParser {
  let buffer = '';
  let fullText = '';
  let usage: HermesStreamChunk['usage'] | undefined;
  let terminated = false;

  const finishOk = () => {
    if (terminated) return;
    terminated = true;
    callbacks.onDone?.(fullText, usage);
  };

  const finishErr = (message: string, code?: string) => {
    if (terminated) return;
    terminated = true;
    callbacks.onError?.(message, code);
  };

  const handleChunk = (chunk: HermesStreamChunk) => {
    // In-stream errors take priority over anything else in the chunk.
    const hermesFailed = chunk.hermes?.failed === true;
    const finish = chunk.choices?.[0]?.finish_reason;
    if (chunk.error || hermesFailed || finish === 'error') {
      const message =
        chunk.error?.message ?? chunk.hermes?.error ?? 'Hermes reported an error mid-stream.';
      finishErr(message, chunk.hermes?.error_code ?? chunk.error?.type);
      return;
    }

    if (chunk.usage) usage = chunk.usage;

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      fullText += delta.content;
      callbacks.onDelta?.(delta.content);
    }

    // Defensive tool-event surfacing until a tool fixture pins the shape:
    // OpenAI-style tool_calls, or any hermes payload beyond the known
    // status booleans, gets forwarded raw for the UI to render as status.
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      callbacks.onToolEvent?.({ kind: 'tool_calls', payload: delta.tool_calls });
    }
    if (chunk.hermes) {
      const known = new Set(['completed', 'partial', 'failed', 'error', 'error_code']);
      const extras = Object.keys(chunk.hermes).filter((k) => !known.has(k));
      if (extras.length > 0) {
        callbacks.onToolEvent?.({ kind: 'hermes_status', payload: chunk.hermes });
      }
    }
  };

  const processLine = (line: string) => {
    if (terminated) return;
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return; // comments / blank keep-alives
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') {
      finishOk();
      return;
    }
    try {
      handleChunk(JSON.parse(data) as HermesStreamChunk);
    } catch {
      // Malformed line — skip it, never crash the stream.
    }
  };

  return {
    feed(text: string) {
      if (terminated) return;
      buffer += text;
      // SSE events are newline-delimited; keep the trailing partial line.
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        processLine(line);
        if (terminated) return;
      }
    },
    end() {
      if (terminated) return;
      if (buffer.trim()) processLine(buffer); // final unterminated line
      if (!terminated) {
        // Stream closed without [DONE] — treat as truncation, not success.
        finishErr('Hermes stream ended unexpectedly (no [DONE] received).', 'stream_truncated');
      }
    },
  };
}

export interface StreamHermesChatOptions extends HermesStreamCallbacks {
  prompt: string;
  /** Hermes session to bind this exchange to (X-Hermes-Session-Id). */
  sessionId: string;
  /** Hermes profile to route to. Omit for the default (camille) profile. */
  profile?: string;
  /** Wire to a cancel button; aborting resolves via onError('cancelled'). */
  signal?: AbortSignal;
  /** Test injection. */
  fetchImpl?: typeof fetch;
  /** Camille's proxy endpoint. */
  endpoint?: string;
}

/**
 * Browser-side: stream one exchange through Camille's /api/hermes/stream
 * proxy. Resolves after the terminal callback has fired.
 */
export async function streamHermesChat(options: StreamHermesChatOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? '/api/hermes/stream';
  const parser = createHermesSSEParser(options);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: options.prompt,
        sessionId: options.sessionId,
        ...(options.profile ? { profile: options.profile } : {}),
      }),
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) {
      options.onError?.('Cancelled.', 'cancelled');
      return;
    }
    options.onError?.(err instanceof Error ? err.message : String(err), 'network');
    return;
  }

  if (!response.ok || !response.body) {
    let message = `Hermes stream failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    options.onError?.(message, `http_${response.status}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.end();
  } catch (err) {
    if (options.signal?.aborted) {
      options.onError?.('Cancelled.', 'cancelled');
      return;
    }
    options.onError?.(err instanceof Error ? err.message : String(err), 'stream_read');
  }
}
