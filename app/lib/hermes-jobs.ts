import { HERMES_REQUEST_TIMEOUT_MS } from './hermes-config.ts';

/**
 * Hermes scheduled jobs (cron), as exposed by the local API server.
 *
 * Endpoint shapes were probed against a live gateway rather than assumed:
 *   GET    /api/jobs        -> { jobs: [...] }
 *   POST   /api/jobs        -> { job }        requires name + schedule
 *   PATCH  /api/jobs/:id    -> enable/disable (PUT is 405)
 *   DELETE /api/jobs/:id    -> 200
 *
 * A job's `schedule` is an object, not a string: recurring jobs and one-shots
 * are different kinds, and the server supplies a human `display` for both,
 * which is what the UI shows rather than reformatting cron expressions.
 */

export interface HermesJobSchedule {
  kind?: string;
  display?: string;
  run_at?: string;
  expression?: string;
}

export interface HermesJob {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  deliver: string | null;
  schedule: HermesJobSchedule | null;
  scheduleDisplay: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

interface RawJob {
  id?: string;
  name?: string;
  prompt?: string;
  enabled?: boolean;
  deliver?: string | null;
  schedule?: HermesJobSchedule | null;
  schedule_display?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
}

export interface HermesJobsOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

function normalise(raw: RawJob): HermesJob {
  return {
    id: raw.id ?? '',
    name: raw.name?.trim() || (raw.id ?? 'untitled'),
    prompt: raw.prompt ?? '',
    enabled: raw.enabled !== false,
    deliver: raw.deliver ?? null,
    schedule: raw.schedule ?? null,
    // Prefer whatever the server calls it; both spellings appear depending on
    // whether the job is recurring or one-shot.
    scheduleDisplay:
      raw.schedule_display?.trim() ||
      raw.schedule?.display?.trim() ||
      raw.schedule?.expression?.trim() ||
      'unscheduled',
    nextRunAt: raw.next_run_at ?? null,
    lastRunAt: raw.last_run_at ?? null,
    lastStatus: raw.last_status ?? null,
    lastError: raw.last_error ?? null,
  };
}

async function call<T>(
  path: string,
  options: HermesJobsOptions,
  init?: RequestInit,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(HERMES_REQUEST_TIMEOUT_MS),
  });

  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok || data?.error) {
    throw new Error(data?.error ?? `Hermes jobs request failed (${response.status}).`);
  }
  return data as T;
}

/**
 * Lists jobs, disabled ones included.
 *
 * The bare endpoint omits disabled jobs, which makes a paused job disappear
 * from the UI entirely — pausing would effectively be an irreversible hide.
 * include_disabled keeps them listed so they can be resumed.
 */
export async function listHermesJobs(options: HermesJobsOptions): Promise<HermesJob[]> {
  const data = await call<{ jobs?: RawJob[] }>('/api/jobs?include_disabled=true', options);
  return (data.jobs ?? []).map(normalise);
}

export interface CreateHermesJobInput {
  /** Human-friendly name. Required by the server. */
  name: string;
  /** '30m', 'every 2h', or a cron expression. Required by the server. */
  schedule: string;
  /** What the agent should do when it fires. */
  prompt?: string;
  /** Where output goes: 'local', 'origin', 'telegram', 'platform:chat_id'. */
  deliver?: string;
}

export async function createHermesJob(
  input: CreateHermesJobInput,
  options: HermesJobsOptions,
): Promise<HermesJob> {
  const name = input.name.trim();
  const schedule = input.schedule.trim();
  if (!name) throw new Error('A job name is required.');
  if (!schedule) throw new Error('A schedule is required (e.g. "30m", "every 2h", "0 9 * * *").');

  const data = await call<{ job?: RawJob }>('/api/jobs', options, {
    method: 'POST',
    body: JSON.stringify({
      name,
      schedule,
      prompt: input.prompt?.trim() ?? '',
      deliver: input.deliver?.trim() || 'local',
    }),
  });
  if (!data.job) throw new Error('Hermes accepted the job but returned nothing.');
  return normalise(data.job);
}

export async function setHermesJobEnabled(
  id: string,
  enabled: boolean,
  options: HermesJobsOptions,
): Promise<void> {
  if (!id) throw new Error('A job id is required.');
  await call(`/api/jobs/${encodeURIComponent(id)}`, options, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

export async function deleteHermesJob(id: string, options: HermesJobsOptions): Promise<void> {
  if (!id) throw new Error('A job id is required.');
  await call(`/api/jobs/${encodeURIComponent(id)}`, options, { method: 'DELETE' });
}
