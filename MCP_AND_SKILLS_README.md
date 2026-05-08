# MCP & Skills — Extending Jarvis

Jarvis V5 supports two complementary systems for extending what your AI assistant can do: **MCP Servers** and **Skills**. Both are configured via JSON files placed in the project root directory.

---

## Table of Contents

- [What is MCP?](#what-is-mcp)
- [How to Configure MCP Servers](#how-to-configure-mcp-servers)
- [How to Configure Skills](#how-to-configure-skills)
- [How Jarvis Discovers Tools at Startup](#how-jarvis-discovers-tools-at-startup)
- [Name Collision Rules](#name-collision-rules)
- [Example: Setting Up the Filesystem Server](#example-setting-up-the-filesystem-server)
- [Example: Creating a Custom Skill](#example-creating-a-custom-skill)
- [Troubleshooting](#troubleshooting)
- [Popular MCP Servers to Try](#popular-mcp-servers-to-try)
- [Notes](#notes)

---

## What is MCP?

**MCP** stands for **Model Context Protocol**. It is an open standard (originally created by Anthropic) that defines how AI applications connect to external tools and data sources. Think of it as a "USB-C for AI" — a universal protocol that lets any MCP-compatible AI assistant (like Jarvis) talk to any MCP-compatible server.

An **MCP server** is a separate process that exposes tools (functions), resources (data), and prompts. Jarvis spawns these processes, calls their tools via JSON-RPC messages over stdin/stdout, and surfaces them as capabilities the AI model can invoke.

For example:
- A **filesystem** MCP server lets Jarvis read and write files on your machine.
- A **GitHub** MCP server lets Jarvis search repositories, read issues, and manage PRs.
- A **Playwright** MCP server lets Jarvis take screenshots of web pages.

---

## How to Configure MCP Servers

MCP servers are configured in a file called `jarvis-mcp.config.json` in the project root directory.

### Step 1: Copy the example file

```bash
cp jarvis-mcp.config.json.example jarvis-mcp.config.json
```

### Step 2: Edit the file

The file has the following structure:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@org/server-package", "arg1", "arg2"],
      "env": {
        "API_KEY": "your_key_here"
      },
      "disabled": false
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | The executable to run (e.g. `npx`, `node`, `python`) |
| `args` | string[] | Yes | Arguments passed to the command |
| `env` | object | No | Environment variables to set for the server process |
| `disabled` | boolean | No | Set to `true` to keep the config but skip loading the server |

> **Note:** JSON does not support comments. The example file includes `"_comment"` fields — these are ignored by the loader and are purely informational. Remove them from your live config if you prefer a cleaner file.

### Step 3: Install dependencies

Most MCP servers are distributed as npm packages and are run via `npx`, which auto-installs them on first use. No separate install step is needed for `npx`-based servers.

For servers that require global installation:

```bash
npm install -g @modelcontextprotocol/server-filesystem
```

### Step 4: Restart Jarvis

MCP servers are initialized when the `McpServerManager` first starts. A restart of the app (or reload of the web interface) is sufficient to pick up config changes.

---

## How to Configure Skills

**Skills** are a higher-level abstraction built on top of MCP (and optionally shell commands). A skill bundles related tools together under a named group. Skills can:

- **Wrap MCP tools** with friendlier names, labels, and parameter schemas.
- **Run shell commands** directly as tools.
- **Compose** multiple tools into a cohesive capability set.

Skills are configured in a file called `jarvis-skills.config.json` in the project root directory.

### Step 1: Copy the example file

```bash
cp jarvis-skills.config.json.example jarvis-skills.config.json
```

### Step 2: Structure of a skill

```json
{
  "skills": [
    {
      "name": "my_skill",
      "description": "Description of this skill group",
      "tools": [
        {
          "name": "my_tool",
          "label": "My Tool",
          "description": "What this tool does",
          "parameters": {
            "type": "object",
            "properties": {
              "param1": {
                "type": "string",
                "description": "Description of param1"
              }
            },
            "required": ["param1"]
          },
          "handler": {
            "type": "mcp",
            "server": "filesystem",
            "tool": "read"
          }
        }
      ]
    }
  ]
}
```

### Handler types

#### MCP handler

Proxies execution to an MCP server tool:

```json
{
  "type": "mcp",
  "server": "filesystem",
  "tool": "read"
}
```

| Field | Description |
|-------|-------------|
| `server` | The name of an MCP server defined in `jarvis-mcp.config.json` |
| `tool` | The name of a tool exposed by that MCP server |

#### Shell handler

Runs a shell command directly:

```json
{
  "type": "shell",
  "command": "df -h"
}
```

You can reference tool parameters in the command string using `${paramName}` syntax. For example, if your tool accepts a `limit` parameter:

```json
{
  "type": "shell",
  "command": "ps aux --sort=-%mem | head -n ${limit}"
}
```

---

## How Jarvis Discovers Tools at Startup

When Jarvis starts (or the web page loads), the following sequence happens:

1. **Static function registry** (`FUNCTION_REGISTRY` in `app/lib/functions.ts`) — These are Jarvis's built-in tools (web search, computer use, image generation, music control, etc.). Always loaded first.

2. **MCP servers** (`jarvis-mcp.config.json`):
   - The `McpServerManager` reads the config file from the project root.
   - For each enabled server, it spawns the process, performs the MCP initialization handshake, and requests the list of available tools via `tools/list`.
   - Tools are registered under their original MCP names (e.g. `read`, `search_code`).

3. **Skills** (`jarvis-skills.config.json`):
   - The `SkillManager` reads the config file from the project root.
   - Each tool inside a skill is registered with a **prefixed name**: `{skill_name}_{tool_name}`.
     - For example, a tool named `read_file` inside a skill named `code` becomes `code_read_file`.
   - This prefixing prevents name collisions across skills and with MCP tools.

4. **Dynamic function loader** (`loadDynamicFunctions` in `app/lib/dynamic-functions.ts`):
   - Fetches MCP tools from the `/api/mcp` endpoint.
   - Fetches skill tools from the `/api/skills` endpoint.
   - Merges all three sources (static, MCP, skills) into a single combined list.
   - The merged list is passed to the AI model as available functions.

---

## Name Collision Rules

Since tools come from three different sources, name collisions are resolved with this priority:

```
Static (built-in) > MCP tools > Skill tools
```

| Source | Priority | Details |
|--------|----------|---------|
| **Static** (built-in) | Highest | Always wins. If an MCP tool or skill tool has the same name, it is skipped with a warning in the console. |
| **MCP** | Middle | Loaded after static. An MCP tool is only added if no static function with the same name exists. |
| **Skills** | Lowest | Loaded last. A skill tool is only added if no static function AND no MCP tool with the same name exists. |

For skill tools, the tool name is `{skill_name}_{tool_name}`, so name collisions across skills are inherently avoided. For example, two different skills can both have a tool named `search` without conflict because they become `skill1_search` and `skill2_search`.

You can check the browser's developer console (or the Electron terminal) for collision warnings like:

```
[dynamic-fn] Name collision: MCP tool "web_search" conflicts with built-in function. Skipping.
```

---

## Example: Setting Up the Filesystem Server

Here is a step-by-step walkthrough to give Jarvis filesystem access on your machine.

### 1. Copy the config

```bash
cp jarvis-mcp.config.json.example jarvis-mcp.config.json
```

### 2. Edit the filesystem server entry

Update the paths to match directories you want Jarvis to access:

```json
"filesystem": {
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "/home/yourname/Desktop",
    "/home/yourname/Documents",
    "/home/yourname/Projects"
  ],
  "env": {}
}
```

**Security note:** Only the directories listed in `args` will be accessible. Jarvis cannot read or write files outside these paths.

### 3. (Optional) Add a code-reader skill

Create `jarvis-skills.config.json`:

```json
{
  "skills": [
    {
      "name": "code",
      "description": "Code reading tools",
      "tools": [
        {
          "name": "read_file",
          "label": "Read File",
          "description": "Read the contents of a file",
          "parameters": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Absolute path to the file"
              }
            },
            "required": ["path"]
          },
          "handler": {
            "type": "mcp",
            "server": "filesystem",
            "tool": "read"
          }
        }
      ]
    }
  ]
}
```

### 4. Restart Jarvis

Reload the web page or restart the Electron app. If everything is set up correctly, you should see log messages in the console:

```
[mcp] Loaded config: 1 server(s) defined
[mcp] Initializing 1 MCP server(s)...
[mcp] Connecting to server: filesystem (npx)
[mcp] Server "filesystem" initialized: 5 tool(s) available
```

---

## Example: Creating a Custom Skill

Suppose you want to create a skill that lets Jarvis check your system's weather and disk space. You'd create a `jarvis-skills.config.json` like this:

```json
{
  "skills": [
    {
      "name": "weather",
      "description": "Weather information tools",
      "tools": [
        {
          "name": "get_forecast",
          "label": "Get Forecast",
          "description": "Fetch the weather forecast for a city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string",
                "description": "The city name"
              }
            },
            "required": ["city"]
          },
          "handler": {
            "type": "shell",
            "command": "curl -s 'wttr.in/${city}?format=%C+%t+%w+%h'"
          }
        }
      ]
    },
    {
      "name": "system",
      "description": "System monitoring tools",
      "tools": [
        {
          "name": "disk",
          "label": "Disk Usage",
          "description": "Show disk usage",
          "parameters": {
            "type": "object",
            "properties": {},
            "required": []
          },
          "handler": {
            "type": "shell",
            "command": "df -h /"
          }
        }
      ]
    }
  ]
}
```

After restarting Jarvis, the AI will have access to three new tools:
- `weather_get_forecast` — fetches weather via `wttr.in`
- `system_disk` — runs `df -h /`

---

## Troubleshooting

### MCP server fails to start

Check the browser console or Electron terminal for error messages like:

```
[mcp] Server "filesystem" error: spawn npx ENOENT
```

**Fix:** Make sure `npx` (or whatever command you specified) is available on your `PATH`. Restart the Electron app from a terminal where the command is available, or use an absolute path like `/usr/local/bin/npx`.

### "No config file found"

```
[mcp] No config file found, skipping MCP initialization
```

**Fix:** Ensure `jarvis-mcp.config.json` exists in the project root directory (`/home/berle/Desktop/TGP/Concept-Bytes/JarvisV5`). Copy the `.example` file:

```bash
cp jarvis-mcp.config.json.example jarvis-mcp.config.json
```

### Server connects but shows 0 tools

Some MCP servers need a few seconds to initialize. If tools persistently show as 0, the server may have failed during its initialization handshake. Check for stderr messages:

```
[mcp:myserver:stderr] Error: Something went wrong
```

**Fix:** Verify the server package is installed correctly. Try running the command manually:

```bash
npx -y @modelcontextprotocol/server-filesystem /tmp
```

### Tool name collision

If you see a warning like:

```
[dynamic-fn] Name collision: Skill tool "code_read" conflicts with existing function. Skipping.
```

This means a tool name conflicts with a higher-priority source. Rename your tool in the skills config to avoid the collision. The full name after prefixing is checked — for skills, this is `{skill_name}_{tool_name}`.

### Skill tool not working

If a skill tool with a `shell` handler fails, check:
1. The shell command is compatible with your operating system.
2. `${paramName}` placeholders in the command match the parameter names in the `parameters` schema.
3. The command runs successfully when executed manually in a terminal.

### MCP tool not working

If a skill tool with an `mcp` handler fails:
1. Verify that the MCP server name matches exactly (case-sensitive) what's in `jarvis-mcp.config.json`.
2. Verify the tool name matches exactly what the MCP server exposes (use `GET /api/mcp` to list all available tools).
3. Check that the MCP server is in `connected` state.

---

## Popular MCP Servers to Try

| Server | Package | Description | Requires API Key? |
|--------|---------|-------------|-------------------|
| **Filesystem** | `@modelcontextprotocol/server-filesystem` | Read, write, list, and search files in allowed directories | No |
| **GitHub** | `@modelcontextprotocol/server-github` | Search repos, read issues, manage PRs, browse code | Yes — GitHub PAT |
| **SQLite** | `@modelcontextprotocol/server-sqlite` | Query and explore local SQLite databases | No |
| **Fetch** | `@modelcontextprotocol/server-fetch` | Fetch URLs and scrape web content | No |
| **Playwright** | `@modelcontextprotocol/server-playwright` | Browser automation: screenshots, clicks, form fills | No |
| **Brave Search** | `@modelcontextprotocol/server-brave-search` | Web and local search via Brave Search API | Yes — Brave API key |
| **Memory** | `@modelcontextprotocol/server-memory` | Persistent knowledge graph for cross-session memory | No |
| **Puppeteer** | `@modelcontextprotocol/server-puppeteer` | Headless browser automation (alternative to Playwright) | No |
| **PostgreSQL** | `@modelcontextprotocol/server-postgres` | Query PostgreSQL databases | Yes — database credentials |
| **Slack** | `@modelcontextprotocol/server-slack` | Read and send Slack messages | Yes — Slack token |
| **Linear** | `@modelcontextprotocol/server-linear` | Manage Linear issues and projects | Yes — Linear API key |
| **Notion** | `@modelcontextprotocol/server-notion` | Search and read Notion pages | Yes — Notion API key |
| **Sequential Thinking** | `@modelcontextprotocol/server-sequential-thinking` | Structured multi-step reasoning | No |

> **Tip:** Browse the full MCP server ecosystem at [github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers).

---

## Notes

- **No GUI yet** — All MCP and Skills configuration is currently file-based. There is no settings UI for configuring servers or skills. Edit the JSON files directly.
- **JSON is strict** — Trailing commas are not allowed. Use a JSON linter if you encounter parse errors.
- **Startup order matters** — MCP servers must be configured before skills can reference them. Skill tools that use `type: "mcp"` refer to servers by name in `jarvis-mcp.config.json`.
- **Security** — Shell-based skill tools run with the same privileges as the Jarvis process. Only add shell skills you trust. For MCP-based tools, the server defines its own security boundaries (e.g., the filesystem server only allows access to explicitly listed directories).
- **Cross-platform** — Shell commands in skills should be compatible with the platform you run Jarvis on (Linux, macOS, or Windows). The `command` field in `jarvis-mcp.config.json` can use platform-specific paths or tools (e.g., `python3` on Linux/macOS, `python` on Windows).
