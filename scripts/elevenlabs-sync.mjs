#!/usr/bin/env node
/**
 * Sync every tool definition in `elevenlabs-tools/` up to the ElevenLabs
 * workspace and attach the whole set to an agent.
 *
 * Tools live in the workspace as standalone resources; the agent references
 * them by id in `conversation_config.agent.prompt.tool_ids`. Defining the same
 * tool *inline* in `prompt.tools` as well makes the model see two copies of
 * every function, which measurably degrades tool selection — so this script
 * keeps client tools in `tool_ids` only and leaves inline entries for system
 * tools alone.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=sk_... node scripts/elevenlabs-sync.mjs [options]
 *
 *   --agent <name|id>     Target agent (default: JarvisV2)
 *   --dry-run             Print the plan without writing anything
 *   --prune-duplicates    Delete redundant workspace tools that share a name
 *   --list                Show the current agent/workspace state and exit
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const API = 'https://api.elevenlabs.io/v1';
const ROOT = path.resolve(import.meta.dirname, '..');
const TOOLS_DIR = path.join(ROOT, 'elevenlabs-tools');

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const AGENT_REF = valueOf('--agent', 'JarvisV2');
const DRY_RUN = has('--dry-run');
const PRUNE = has('--prune-duplicates');
const LIST_ONLY = has('--list');

// ── api key ───────────────────────────────────────────────────────────────────
function resolveApiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  for (const file of ['.env.local', '.env']) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const match = fs
      .readFileSync(p, 'utf-8')
      .match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

const API_KEY = resolveApiKey();
if (!API_KEY) {
  console.error(
    'Missing ELEVENLABS_API_KEY.\n' +
      'Set it in the environment or add it to .env.local:\n' +
      '  ELEVENLABS_API_KEY=sk_...',
  );
  process.exit(1);
}
if (!API_KEY.startsWith('sk_')) {
  console.error(
    `That looks like an API key *ID*, not a key (${API_KEY.slice(0, 8)}...).\n` +
      "Real keys start with 'sk_' and are only shown when created or rotated.",
  );
  process.exit(1);
}

// ── http ──────────────────────────────────────────────────────────────────────
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
  if (!res.ok) {
    throw new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 600)}`);
  }
  return text ? JSON.parse(text) : {};
}

// ── local tool configs ────────────────────────────────────────────────────────
/**
 * The dashboard exports tool parameters as a flat list of `{ id, type,
 * value_type, ... }` entries, but `POST/PATCH /convai/tools` only accepts a
 * JSON Schema object. Convert the committed dashboard shape into the schema the
 * REST API wants; configs already using the object form pass through untouched.
 */
function convertParameters(parameters, toolName) {
  if (!parameters) return undefined;
  if (!Array.isArray(parameters)) return parameters;

  const properties = {};
  const required = [];

  for (const param of parameters) {
    const id = param.id ?? param.name;
    if (!id) {
      console.warn(`  ! ${toolName}: skipping a parameter with no id`);
      continue;
    }

    const prop = { type: param.type ?? 'string' };

    // `description`, `dynamic_variable`, `constant_value` and
    // `is_system_provided` are mutually exclusive ways to populate a value, so
    // only ever emit the one that is actually set.
    if (param.dynamic_variable) {
      prop.dynamic_variable = param.dynamic_variable;
    } else if (param.constant_value !== undefined && param.constant_value !== '') {
      prop.constant_value = param.constant_value;
    } else if (param.is_system_provided) {
      prop.is_system_provided = true;
    } else {
      prop.description = param.description ?? '';
    }

    if (Array.isArray(param.enum) && param.enum.length) prop.enum = param.enum;

    properties[id] = prop;
    if (param.required) required.push(id);
  }

  return { type: 'object', properties, required };
}

/**
 * `disable_interruptions` and `force_pre_tool_speech` are deprecated in favour
 * of the richer `interruption_mode` / `pre_tool_speech` enums. Translate them on
 * the way up so the committed JSON can be migrated gradually.
 */
function normalizeToolConfig(config, filename) {
  const out = { ...config };

  if (out.disable_interruptions !== undefined) {
    if (out.disable_interruptions === true && !out.interruption_mode) {
      out.interruption_mode = 'disable_during_tool';
    }
    delete out.disable_interruptions;
  }
  if (out.force_pre_tool_speech !== undefined) {
    if (out.force_pre_tool_speech === true && !out.pre_tool_speech) {
      out.pre_tool_speech = 'force';
    }
    delete out.force_pre_tool_speech;
  }

  if (!out.name) throw new Error(`${filename}: tool config has no "name"`);
  if (!out.description) throw new Error(`${filename}: tool config has no "description"`);

  out.parameters = convertParameters(out.parameters, out.name);

  // Client tools cap out at 120s; anything longer must run as an async tool.
  if (out.type === 'client' && Number(out.response_timeout_secs) > 120) {
    console.warn(
      `  ! ${out.name}: response_timeout_secs ${out.response_timeout_secs} exceeds the 120s ` +
        'client-tool limit — consider execution_mode "async"',
    );
    out.response_timeout_secs = 120;
  }

  return out;
}

function loadLocalTools() {
  const files = fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  return files.map((file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, file), 'utf-8'));
    return { file, config: normalizeToolConfig(raw, file) };
  });
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const local = loadLocalTools();
  console.log(`Local tool definitions: ${local.length}`);

  // Resolve the target agent.
  const { agents = [] } = await api('GET', '/convai/agents?page_size=100');
  const agent =
    agents.find((a) => a.agent_id === AGENT_REF) ??
    agents.find((a) => a.name?.toLowerCase() === AGENT_REF.toLowerCase());
  if (!agent) {
    console.error(
      `Agent "${AGENT_REF}" not found. Available:\n` +
        agents.map((a) => `  ${a.agent_id}  ${a.name}`).join('\n'),
    );
    process.exit(1);
  }
  console.log(`Target agent: ${agent.name} (${agent.agent_id})\n`);

  // Index the workspace by tool name so we can tell create from update.
  const { tools: workspace = [] } = await api('GET', '/convai/tools');
  const byName = new Map();
  for (const t of workspace) {
    const name = t.tool_config?.name;
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(t.id);
  }

  const full = await api('GET', `/convai/agents/${agent.agent_id}`);
  const prompt = full.conversation_config?.agent?.prompt ?? {};
  const inline = prompt.tools ?? [];
  const inlineClient = inline.filter((t) => t.type !== 'system');
  const inlineSystem = inline.filter((t) => t.type === 'system');

  if (LIST_ONLY) {
    const attachedIds = prompt.tool_ids ?? [];
    console.log(`workspace tools  : ${workspace.length}`);
    console.log(`attached tool_ids: ${attachedIds.length}`);
    console.log(`system tools     : ${inlineSystem.map((t) => t.name).join(', ') || 'none'}`);

    // GET resolves tool_ids back into `tools`, so a name appearing there is not
    // evidence of double registration — only repeated ids in tool_ids are.
    const attachedNames = attachedIds.map((id) => {
      for (const [n, ids] of byName) if (ids.includes(id)) return n;
      return `(unknown:${id})`;
    });
    const seen = new Set();
    const repeats = attachedNames.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    if (repeats.length) {
      console.log(`\nattached more than once: ${[...new Set(repeats)].join(', ')}`);
    }

    const missing = local
      .map((l) => l.config.name)
      .filter((n) => !seen.has(n));
    console.log(`\nnot attached (${missing.length}): ${missing.join(', ') || 'none'}`);
    return;
  }

  // 1. Create or update every local definition.
  const toolIds = [];
  const created = [];
  const updated = [];
  const duplicates = [];

  for (const { config } of local) {
    const existing = byName.get(config.name) ?? [];

    if (existing.length === 0) {
      if (DRY_RUN) {
        console.log(`  + create ${config.name}`);
        toolIds.push(`(new:${config.name})`);
      } else {
        const res = await api('POST', '/convai/tools', { tool_config: config });
        console.log(`  + created ${config.name} -> ${res.id}`);
        toolIds.push(res.id);
      }
      created.push(config.name);
      continue;
    }

    const [keep, ...extra] = existing;
    toolIds.push(keep);
    if (extra.length) duplicates.push({ name: config.name, ids: extra });

    if (DRY_RUN) {
      console.log(`  ~ update ${config.name} (${keep})`);
    } else {
      await api('PATCH', `/convai/tools/${keep}`, { tool_config: config });
      console.log(`  ~ updated ${config.name}`);
    }
    updated.push(config.name);
  }

  // 2. Attach the full set and drop the duplicated inline copies.
  //
  // The API rejects `tools` and `tool_ids` together, so inline system tools have
  // to move into `built_in_tools` (their canonical home) while every client tool
  // is referenced by id.
  const builtIn = { ...(prompt.built_in_tools ?? {}) };
  for (const sys of inlineSystem) {
    const type = sys.params?.system_tool_type ?? sys.name;
    if (!type) continue;
    builtIn[type] = {
      ...(builtIn[type] ?? {}),
      name: sys.name ?? type,
      params: sys.params ?? { system_tool_type: type },
    };
  }
  // Null entries mean "disabled"; sending them back as objects would enable
  // tools the agent never had.
  for (const key of Object.keys(builtIn)) {
    if (!builtIn[key]) delete builtIn[key];
  }

  const payload = {
    conversation_config: {
      agent: {
        prompt: {
          tool_ids: toolIds,
          tools: [],
          built_in_tools: builtIn,
        },
      },
    },
  };

  console.log(
    `\nAttaching ${toolIds.length} tool_ids; ` +
      `clearing ${inlineClient.length} duplicated inline client tools; ` +
      `system tools via built_in_tools: ${Object.keys(builtIn).join(', ') || 'none'}.`,
  );

  if (!DRY_RUN) {
    await api('PATCH', `/convai/agents/${agent.agent_id}`, payload);
    console.log('Agent updated.');
  }

  // 3. Optionally clean up same-name workspace tools left over from re-imports.
  if (duplicates.length) {
    console.log(`\nRedundant workspace tools sharing a name: ${duplicates.length}`);
    for (const d of duplicates) {
      console.log(`  ${d.name}: ${d.ids.join(', ')}`);
      if (PRUNE && !DRY_RUN) {
        for (const id of d.ids) {
          try {
            await api('DELETE', `/convai/tools/${id}`);
            console.log(`    deleted ${id}`);
          } catch (e) {
            console.log(`    could not delete ${id}: ${String(e).slice(0, 160)}`);
          }
        }
      }
    }
    if (!PRUNE) console.log('  (re-run with --prune-duplicates to delete these)');
  }

  console.log(
    `\nDone. created=${created.length} updated=${updated.length} attached=${toolIds.length}` +
      (DRY_RUN ? '  [DRY RUN — nothing written]' : ''),
  );
  if (created.length) console.log(`Newly registered: ${created.join(', ')}`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
