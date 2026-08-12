# ElevenLabs Client Tools

Client tool definitions for the Jarvis ElevenLabs agent. These files are the
source of truth — do **not** hand-edit tools in the ElevenLabs dashboard, because
the next sync will overwrite them.

Every tool name here must have a matching handler in
[`app/lib/functions.ts`](../app/lib/functions.ts). A tool the agent can call but
the client can't handle fails silently mid-conversation.

## Syncing

```bash
# one-time: put your key somewhere the scripts can find it
echo 'ELEVENLABS_API_KEY=sk_...' >> ../.env.local

npm run el:list        # what's registered vs. what's attached
npm run el:sync:dry    # preview the changes
npm run el:sync        # create/update every tool and attach it to the agent
npm run el:tune        # LLM, turn-taking, and the managed prompt sections
```

Both scripts default to the `JarvisV2` agent; pass `--agent "<name|id>"` to
target another one. `el:sync` also accepts `--prune-duplicates` to delete
leftover workspace tools that share a name (skipped when another agent still
references them).

`npm run el:tune` changes the model and rewrites the `# Memory` block in the
system prompt. Use `--keep-model` to leave the LLM alone, and `--dry-run` to
preview.

Agent configs are backed up to `_backups/` before changes.

## Format notes

The committed JSON uses the dashboard's export shape, where `parameters` is a
flat list of `{ id, type, value_type, ... }` entries. The REST API only accepts a
JSON Schema object, so `elevenlabs-sync.mjs` converts it on the way up — which is
why these files could previously only be imported by hand.

The sync also translates the deprecated `disable_interruptions` and
`force_pre_tool_speech` flags into `interruption_mode` / `pre_tool_speech`.

Client tools cap `response_timeout_secs` at 120s. Anything slower should use
`"execution_mode": "async"` and report progress through a contextual update
rather than blocking the conversation.

## Tools

Memory (per-account, backed by `app/api/memory`):

| File | expects_response | timeout |
|------|-----------------|---------|
| `remember.json` | ✅ | 5s |
| `recall.json` | ✅ | 5s |
| `forget.json` | ✅ | 5s |

Everything else:

| File | expects_response | timeout |
|------|-----------------|---------|
| `get_date.json` | ✅ | 3s |
| `get_time.json` | ✅ | 3s |
| `get_location.json` | ✅ | 10s |
| `get_battery_level.json` | ✅ | 3s |
| `xray.json` | ✅ | 20s |
| `take_photo.json` | ✅ | 10s |
| `get_now_playing.json` | ✅ | 5s |
| `computer_use.json` | ✅ | 60s |
| `3d_printing.json` | ✅ | 120s |
| `run_shell_command.json` | ✅ | 15s |
| `web_search.json` | ✅ | 10s |
| `control_music.json` | ✅ | 5s |
| `find_datasheet.json` | ✅ | 15s |
| `image_generation.json` | ✅ | 60s |
| `navigate_to_page.json` | ✅ | 5s |
| `desktop_mode.json` | ✅ | 3s |
| `calendar_command.json` | ✅ | 10s |
| `home_assistant_command.json` | ✅ | 10s |
| `printer_command.json` | ✅ | 10s |
| `control_hud.json` | ❌ | 1s |
| `show_hud_text.json` | ❌ | 1s |
| `open_url.json` | ❌ | 1s |
| `open_pdf.json` | ❌ | 1s |
| `map_command.json` | ❌ | 5s |
| `add_home_widget.json` | ❌ | 1s |
| `open_3d_model.json` | ✅ | 5s |
| `fullscreen.json` | ✅ | 3s |
| `lock_interface.json` | ✅ | 5s |
| `set_timer.json` | ✅ | 5s |
| `set_reminder.json` | ✅ | 5s |
| `hud_layout.json` | ✅ | 5s |
| `briefing.json` | ✅ | 15s |
| `set_theme.json` | ✅ | 5s |
| `ambient_mode.json` | ✅ | 5s |

## System tools

Enabled on the agent via `built_in_tools`, not defined here: `end_call`,
`language_detection`, `skip_turn`. `end_call` is what lets Jarvis hang up, so the
`jarvis_disconnect` handler in `functions.ts` has no tool file by design.

On the current workspace tier only `memory_entry_search` is accepted from
ElevenLabs' native memory tools — `memory_entry_create`, `memory_entry_update`,
`memory_entry_delete` and `agent_prompt_change` are silently dropped. That's why
memory is implemented as the client tools above.
