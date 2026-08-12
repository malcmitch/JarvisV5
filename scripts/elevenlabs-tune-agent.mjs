#!/usr/bin/env node
/**
 * Apply Jarvis's runtime tuning to an ElevenLabs agent: the LLM, turn-taking
 * behaviour, and the memory section of the system prompt.
 *
 * Split from `elevenlabs-sync.mjs` so tool registration and behavioural tuning
 * can be run independently — syncing tools should never silently change the
 * model or the prompt.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=sk_... node scripts/elevenlabs-tune-agent.mjs [options]
 *
 *   --agent <name|id>   Target agent (default: JarvisV2)
 *   --dry-run           Print the diff without writing
 *   --keep-model        Leave the configured LLM alone
 *   --model <id>        Override the LLM (default: gemini-3.6-flash)
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const API = 'https://api.elevenlabs.io/v1';
const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const AGENT_REF = valueOf('--agent', 'JarvisV2');
const DRY_RUN = has('--dry-run');
const KEEP_MODEL = has('--keep-model');
const MODEL = valueOf('--model', 'gemini-3.6-flash');
const REASONING = valueOf('--reasoning', 'low');

function resolveApiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  for (const file of ['.env.local', '.env']) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf-8').match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

const API_KEY = resolveApiKey();
if (!API_KEY?.startsWith('sk_')) {
  console.error("Missing or malformed ELEVENLABS_API_KEY (must start with 'sk_').");
  process.exit(1);
}

async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      'xi-api-key': API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

// The memory tools only pay off if the agent is told when to reach for them,
// so this block is managed here rather than hand-edited in the dashboard.
const MEMORY_SECTION = `# Memory
You have a persistent, per-account memory that survives between conversations.

Known about the user (account: {{jarvis_account}}):
{{jarvis_memory}}

- **recall** — call this *before* answering anything that depends on personal context not already listed above, and before asking the user to repeat something. Never say "I don't know your X" without calling recall first.
- **remember** — call this the moment the user states a preference, a name, a nickname, a measurement, a routine, or says "remember that" / "from now on". One clean fact per call, third person. Do not announce it beyond a two-word confirmation.
- **forget** — call this when the user corrects you or says a stored fact is wrong, then call remember with the corrected version.
Facts already listed above are in memory — do not store them again.`;

const MEMORY_HEADING = '# Memory';

/** Replaces the managed memory block, or appends it before `# Goal`. */
function withMemorySection(prompt) {
  if (prompt.includes(MEMORY_HEADING)) {
    return prompt.replace(
      new RegExp(`${MEMORY_HEADING}[\\s\\S]*?(?=\\n# |$)`),
      `${MEMORY_SECTION}\n\n`,
    );
  }
  if (prompt.includes('\n# Goal')) {
    return prompt.replace('\n# Goal', `\n${MEMORY_SECTION}\n\n# Goal`);
  }
  return `${prompt.trimEnd()}\n\n${MEMORY_SECTION}\n`;
}

const STALE_TOOL_LINE = /^\*\*Other tools available:\*\*.*$/m;
const FRESH_TOOL_LINE =
  '**Other tools available:** get_time, get_date, get_location, get_battery_level, ' +
  'web_search, image_generation, run_shell_command, computer_use, find_datasheet, open_url, ' +
  'open_pdf, open_3d_model, control_music, get_now_playing, take_photo, xray, calendar_command, ' +
  'printer_command, fullscreen, desktop_mode, briefing, set_timer, set_reminder, set_theme, ' +
  'hud_layout, lock_interface, ambient_mode, show_hud_text, 3d_printing, remember, recall, forget';

async function main() {
  const { agents = [] } = await api('GET', '/convai/agents?page_size=100');
  const agent =
    agents.find((a) => a.agent_id === AGENT_REF) ??
    agents.find((a) => a.name?.toLowerCase() === AGENT_REF.toLowerCase());
  if (!agent) {
    console.error(`Agent "${AGENT_REF}" not found.`);
    process.exit(1);
  }

  const full = await api('GET', `/convai/agents/${agent.agent_id}`);
  const prompt = full.conversation_config?.agent?.prompt ?? {};
  const turn = full.conversation_config?.turn ?? {};

  let text = prompt.prompt ?? '';
  const before = { model: prompt.llm, turnModel: turn.turn_model, promptLen: text.length };

  text = withMemorySection(text);
  text = STALE_TOOL_LINE.test(text)
    ? text.replace(STALE_TOOL_LINE, FRESH_TOOL_LINE)
    : text;

  const promptPatch = { prompt: text };
  if (!KEEP_MODEL) {
    promptPatch.llm = MODEL;
    // `reasoning_effort` is validated against the *new* model, and the accepted
    // values differ per provider (OpenAI accepts "none", Gemini does not), so a
    // model switch has to carry a compatible value or the PATCH is rejected.
    promptPatch.reasoning_effort = REASONING;
  }

  const payload = {
    conversation_config: {
      agent: {
        prompt: promptPatch,
        // The client supplies real values at session start; these placeholders
        // keep the dashboard test bench and any client that forgets to pass
        // them from failing on an unresolved variable.
        dynamic_variables: {
          dynamic_variable_placeholders: {
            jarvis_account: 'default',
            jarvis_memory: '(nothing remembered yet)',
            jarvis_local_time: 'unknown',
          },
        },
      },
      turn: {
        // turn_v3 is the current detection model; v2 is legacy.
        turn_model: 'turn_v3',
        turn_eagerness: 'normal',
        // Never hang up on Jarvis mid-task just because nobody is talking.
        silence_end_call_timeout: -1,
        // Speak a filler instead of going silent while a slow tool or LLM runs.
        soft_timeout_config: {
          timeout_seconds: 3.0,
          message: 'Working on it, sir.',
          additional_soft_timeout_messages: [
            'Still processing.',
            'One moment.',
          ],
          randomize_fillers: true,
          max_soft_timeouts_per_generation: 3,
        },
      },
    },
  };

  console.log(`Agent: ${agent.name} (${agent.agent_id})`);
  console.log(
    `  llm        : ${before.model} -> ${KEEP_MODEL ? '(unchanged)' : `${MODEL} (reasoning_effort=${REASONING})`}`,
  );
  console.log(`  turn_model : ${before.turnModel} -> turn_v3`);
  console.log(`  soft timeout fillers: enabled at 3.0s`);
  console.log(`  prompt     : ${before.promptLen} -> ${text.length} chars`);
  console.log(`  memory section: ${text.includes(MEMORY_HEADING) ? 'present' : 'MISSING'}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN — nothing written]');
    return;
  }

  await api('PATCH', `/convai/agents/${agent.agent_id}`, payload);
  console.log('\nAgent updated.');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
