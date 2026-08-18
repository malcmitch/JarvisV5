export interface HermesGatewayOptions {
  apiKey: string;
  baseUrl: string;
  sessionId?: string;
  fetchImpl?: typeof fetch;
}

export interface HermesGatewayResult {
  response: string;
  sessionId: string;
}

export interface HermesSessionSummary {
  id: string;
  source: string;
  title: string;
  messageCount: number;
}

export interface HermesSessionMessage {
  role: string;
  content: string;
  reasoning?: string | null;
}

interface HermesChatCompletion {
  error?: {
    message?: string;
  };
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface HermesApiError {
  error?: {
    message?: string;
  };
}

interface HermesSessionListResponse extends HermesApiError {
  data?: Array<{
    id?: string;
    source?: string;
    title?: string;
    message_count?: number;
  }>;
}

interface HermesSessionMessagesResponse extends HermesApiError {
  data?: Array<{
    role?: string;
    content?: string;
    reasoning?: string | null;
    reasoning_content?: string | null;
  }>;
}

interface HermesSessionChatResponse extends HermesApiError {
  message?: {
    role?: string;
    content?: string;
  };
}

export function parseHermesApiKey(envText: string): string | null {
  const match = envText.match(/^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export async function runHermesCommand(
  command: string,
  options: HermesGatewayOptions,
): Promise<HermesGatewayResult> {
  const prompt = command.trim();
  if (!prompt) throw new Error('Hermes command is required.');

  const sessionId = options.sessionId ?? 'camille-voice';
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'X-Hermes-Session-Id': sessionId,
      'X-Hermes-Session-Key': sessionId,
    },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });
  const data = await response.json() as HermesChatCompletion;
  if (!response.ok) {
    const message = data.error?.message ?? response.statusText ?? 'Unknown error';
    throw new Error(`Hermes gateway failed (${response.status}): ${message}`);
  }
  return {
    response: data.choices?.[0]?.message?.content ?? '',
    sessionId,
  };
}

/**
 * Lists every local Hermes session (desktop, CLI, cron, API-created — not
 * only messaging-platform conversations) via the API server's /api/sessions
 * resource. This is the "local task sessions" surface: no Telegram/Discord
 * platform config is required for a session to show up here.
 */
export async function listHermesSessions(
  options: HermesGatewayOptions & { limit?: number },
): Promise<HermesSessionSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const limit = options.limit ?? 50;
  const response = await fetchImpl(`${baseUrl}/api/sessions?limit=${limit}`, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });
  const data = await response.json() as HermesSessionListResponse;
  if (!response.ok) {
    const message = data.error?.message ?? response.statusText ?? 'Unknown error';
    throw new Error(`Hermes gateway failed (${response.status}): ${message}`);
  }
  return (data.data ?? []).map((s) => ({
    id: s.id ?? '',
    source: s.source ?? '',
    title: s.title ?? '',
    messageCount: s.message_count ?? 0,
  }));
}

/** Reads a session's transcript, oldest message first. */
export async function getHermesSessionMessages(
  sessionId: string,
  options: HermesGatewayOptions,
): Promise<HermesSessionMessage[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages?order=oldest`,
    { headers: { Authorization: `Bearer ${options.apiKey}` } },
  );
  const data = await response.json() as HermesSessionMessagesResponse;
  if (!response.ok) {
    const message = data.error?.message ?? response.statusText ?? 'Unknown error';
    throw new Error(`Hermes gateway failed (${response.status}): ${message}`);
  }
  return (data.data ?? []).map((m) => ({
    role: m.role ?? '',
    content: m.content ?? '',
    reasoning: m.reasoning ?? m.reasoning_content ?? null,
  }));
}

/** Sends one message to an existing local session and returns the reply. */
export async function sendHermesSessionChat(
  sessionId: string,
  message: string,
  options: HermesGatewayOptions,
): Promise<HermesSessionMessage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/chat`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    },
  );
  const data = await response.json() as HermesSessionChatResponse;
  if (!response.ok) {
    const errMessage = data.error?.message ?? response.statusText ?? 'Unknown error';
    throw new Error(`Hermes gateway failed (${response.status}): ${errMessage}`);
  }
  return {
    role: data.message?.role ?? 'assistant',
    content: data.message?.content ?? '',
  };
}
