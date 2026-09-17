# Configuring {{name}}

How to add models, custom providers, datasources, hooks, MCP servers, and
custom agents. Read the relevant section in full before editing anything, then
make the edit, then tell the user to **hard-reload** (see below) so it takes
effect.

You can do all of this yourself with the normal read/edit/write tools — none of
it needs the user to walk an interactive panel. The panels (`/model`,
`/datasource`, `/settings`, `/login`) are conveniences over the same files.

## Where config lives

| What                                                         | File                          |
| ------------------------------------------------------------ | ----------------------------- |
| Global settings (default model, hooks, MCP servers, toggles) | `~/{{dir}}/settings.json`     |
| Auth + custom providers (API keys, OAuth creds, gateways)    | `~/{{dir}}/auth.json`         |
| Datasources (database connections for the `sql` tool)        | `~/{{dir}}/datasources.json`  |
| Custom agents                                                | `~/{{dir}}/agents/<name>.md`  |
| Project settings / hooks (override global)                   | `<cwd>/{{dir}}/settings.json` |
| Project MCP servers (override global)                        | `<cwd>/{{dir}}/mcp.json`      |

All config files are plain JSON — edit them with the normal edit/write tools.
Unknown keys are preserved, so only touch the keys you mean to change. Always
read the existing file first (the edit tool requires it) and keep valid JSON.

Boolean toggles live at the top level of `~/{{dir}}/settings.json` and can also
be flipped via `/settings`. Example: `"askUser": true` enables the `ask` tool,
which lets the agent pause mid-turn and ask you multiple-choice questions
(default off; interactive TUI only — never offered in print mode).

Other notable keys (all managed via `/settings` too):

- `"webSearch": true` — enables the `websearch` tool, DuckDuckGo search with
  no API key (scrapes the HTML endpoint; unofficial, may rate-limit). Default
  off. Works in print mode too; subagents inherit it.
- `"sound": "on"` — interface chimes. `off` is silent (bell included), `on`
  plays a cue when a turn finishes or fails, when the agent is blocked waiting
  on you, at startup and on a cancel, and `max` adds the incidental ones (the
  slash menu opening, the input clearing). Defaults to `on` on macOS, the only
  platform with a player (`afplay`); elsewhere every cue is the terminal bell
  and it defaults off. `/sound [on|off|max]` flips it live and `LOOP_SOUND`
  overrides it for one run (`LOOP_SOUND=0` to silence a script). Attention
  cues always ring the bell as well, so tmux/cmux mark the pane.
- `"memory": false` — disables agent memory. Default on: the agent saves
  durable per-project facts (preferences, decisions, gotchas) as markdown
  files under `~/{{dir}}/agent/memory/<project>/`, keyed by repo root, and
  recalls them via a small index injected each turn. Files are plain
  markdown — edit or delete them freely (`/memory` → "Agent memory (auto)"
  opens the index).
- `"todos": true` — enables the `todo` tool: a visible checklist the agent
  maintains during multi-step work, pinned above the editor while the turn
  runs (`[>]` in progress, `[-]` cancelled) and retired into the scrollback
  as a one-line summary when the turn ends. Lists persist with the session
  (`/resume`, `/fork`, `/tree` restore them). Default off.
- `"backgroundShells": true` — enables background shells. Default **off**, so
  out of the box nothing the agent runs can outlive its own tool call: the
  `shells` tool is not offered, `run_in_background` is refused, and a command
  that outruns its timeout is killed. Turned on, `bash` takes
  `run_in_background` for a command that is not meant to finish (a dev server,
  a watcher, a tail), the `shells` tool reads what one has printed since the
  last look and can kill it, running shells are pinned above the editor, and a
  foreground command that outruns its timeout is moved to the background
  instead of being killed. `/shells` still works either way: the setting
  governs what the *agent* may start, not what you can. Shells never survive
  loop itself; whatever is running is stopped on exit.
- `"herdr": false` — disables herdr agent-state reporting. Default on, and
  only ever active inside a [herdr](https://herdr.dev) pane (detected via the
  env herdr injects): the pane's sidebar entry shows `loop` with live
  working / blocked (waiting on a prompt) / idle state and the session id,
  via herdr's socket API. Outside herdr this does nothing at all.
- `"cmux": false` — disables the [cmux](https://cmux.com) integration. Default
  on, and only ever active inside a cmux pane (detected via the env cmux
  injects). Inside one, every lifecycle event loop already emits as a hook —
  session start/end, prompts, tool calls, todo lists, turn completion — is
  mirrored into cmux's Feed sidebar over its socket, and the prompts that stop
  the agent (bash / file-access / plan approvals and the ask tool's questions)
  are pushed as actionable cards: answer one in cmux's sidebar or from its
  notification buttons and the on-screen prompt closes with that answer.
  Whichever side answers first wins; nothing is ever waited on, so a cmux that
  is gone or slow costs the turn nothing. loop also registers a resume command
  (`loop --session <id>`) with the pane, which cmux offers when it restores
  that terminal. Two limits are cmux's, not loop's: its Feed labels rows from
  an allowlist of agents it knows, so loop's land under the default `claude`
  label (its event stream keeps `_source: "loop"`), and the per-tab agent
  lifecycle dot is only written for agents on that list.
- `"notch": false` — disables notch reporting. Default on, and gated on the
  socket `~/.notch/notch.sock` existing, so it does nothing unless the notch
  app is running. When it is, the same working / blocked / idle state the
  herdr reporter sends is drawn on the MacBook notch — above every app and
  inside fullscreen — alongside the session's name and the last thing the
  agent said. The gate is the socket rather than an env var on purpose: a
  desktop app cannot inject env into a terminal that is already open, so
  starting the notch mid-session works and the next transition appears.
- `"skills": false` — disables skills. Default on (gated by project trust):
  skills are SKILL.md folders under `~/{{dir}}/agent/skills/` (global) and
  `<cwd>/{{dir}}/skills/` (project); the agent loads one via the `skill`
  tool or by reading its file. A skill with `disable-model-invocation` in
  its frontmatter is excluded from the `skill` tool.
- `"uiMode"` — the chat's look. Builtins: `"noir"` (default — dark washed
  canvas, flat `◆` tool rows, collapsing thought blocks) and `"loop"` (the
  classic boxed look). Switch live with `/ui <mode>`; each mode keeps its
  own theme (loop: `dark`/`light` on the `theme` key; other modes under
  `uiThemes`, e.g. `{ "noir": "day" }`).
  Noir ships a third theme, **`system`**: noir's ink with NO canvas of its
  own, so your terminal's own background shows through — a true black, a
  transparency, a background image. It asks the terminal what it is (the
  OSC 11 background colour for the exact canvas, the colour-scheme report as a
  fallback) once at startup, with nothing to configure. Its palette —
  every slot of it, greys and hues and the syntax set — is rebuilt to hold the
  same contrast noir's own themes hold against their washed canvas, so it reads
  on your background the way noir does on its own. The lift is one-sided: a
  terminal darker than noir's canvas is left exactly as it is. Pick it in
  `/settings` → theme, or set `{ "uiThemes": { "noir": "system" } }`.
- `"pinnedInput": true` — hold the prompt on the last rows of the screen. The
  transcript scrolls in its own window above it and the wheel moves only that
  window; the prompt, status line and panels stay put. Off (the default), the
  prompt sits directly under the last message the way a shell prompt follows a
  command's output, sinks to the bottom as the conversation grows, and
  scrolling back moves the whole page. Either way the chat runs on the
  alternate screen and nothing is written into the terminal until you quit.
  Toggle it live in `/settings` → pinned input.
- `"subagentModel"` — default model for subagents (full `provider/model` id,
  cross-provider allowed). An agent file's own `model:` wins over it; unset =
  subagents inherit the parent's model. Invalid/unavailable picks fall back to
  the parent model with a visible warning.
- `"subagentMaxParallel"` — how many subagents may stream at once when the
  model launches several task calls in one step (parallel fan-out). Excess
  tasks queue visibly and start as slots free. Default 4; 0 = unlimited.
- `"bashApprove": true` — ask before every bash command (deny / allow once /
  always allow), like a permission prompt. Default off; interactive TUI only.
- `"bashAllow"` — the legacy global "always allow" list (same `command` /
  `"command subcommand"` pattern shape as `bashDeny`). New "always allow"
  grants persist per-project instead; this list still matches everywhere.
- `"permissions"` — allow/ask/deny rules over the tools
  (`{"deny": ["Bash(rm -rf *)", "Read(secrets/**)"]}`). Trusted projects add
  rules via `<cwd>/{{dir}}/settings.json` under the same key. Read
  `{{name}}://docs/permissions.md` for the full rule syntax, matching
  semantics, and evaluation order before editing these.
- Background tasks (detached/scheduled runs) are managed with `/background`
  in the TUI or `{{name}} goals` on the CLI (add/list/rm/run/tick); the
  background scheduler toggles with `/daemon` (or
  `{{name}} goals daemon install|uninstall|status`). Background tasks live in
  {{name}}'s internal database, not in settings.json.
- Goal mode (`/goal <objective>` in the TUI) drives the current session
  autonomously: a planner writes a plan, the agent keeps working turn after
  turn, and an adversarial verifier audits the result before the goal
  completes (`/goal pause|resume|status|clear`). Its plan/state files live
  under `~/{{dir}}/agent/goal-mode/<session>/` — nothing to configure in
  settings.json.

## Hard reload — REQUIRED after any config change

Config is read into memory at startup. After you edit any file above, the change
does **not** apply to the running session. Tell the user to either:

- run **`/reload`** (re-reads settings.json, auth.json, datasources.json, theme,
  commands, agents, hooks, MCP servers, models), or
- **quit and restart** {{name}}.

End every config task by telling the user which one to do.

---

## Add a model from a built-in provider

Built-in providers: `anthropic`, `openai`, `google`, `xai`, `openrouter`,
`github-copilot`, `deepseek`, `mistral`, `glm`, `zai`, `kimi`, `groq`,
`cerebras`, `zenmux`, `vercel` (Vercel AI Gateway; key from `login vercel` or
`AI_GATEWAY_API_KEY`), `bedrock`, `ollama`.

Their models are discovered automatically once the provider is authenticated —
there is no per-model list to maintain. Two providers need no login at all:
`ollama` (detected local daemon) and `bedrock` (AWS credentials from the aws
CLI / env / SSO; the model list comes from the account's Bedrock access —
region via `AWS_REGION` or `{{env}}_BEDROCK_REGION`). The flow is:

1. Authenticate: the user runs `{{name}} login <provider>` (or `/login`). API keys
   and OAuth creds are stored in `~/{{dir}}/auth.json`; do not hand-write secrets
   into it unless the user asks.
2. Pick the model live with `/model`, or pin a default in `~/{{dir}}/settings.json`:

```json
{
    "defaultModel": "anthropic/claude-opus-4-8"
}
```

Model ids are always `"<provider>/<model>"`. Per-project model memory is
automatic: the last model picked with `/model` in a folder is restored next
time {{name}} starts there (stored in {{name}}'s internal database, not in
settings.json — there is no key to edit for it).

If the user wants a model that isn't on a built-in provider (a gateway, a
self-hosted endpoint, a proxy), that's a **custom provider** — see below.

---

## Add a custom provider (and its models)

Custom providers are gateways or OpenAI/Anthropic/Google-compatible endpoints
(bifrost, litellm, a self-hosted proxy, etc.). They live in `~/{{dir}}/auth.json`
under `customProviders`, keyed by name. Their models are referenced as
`"custom:<name>/<model>"`.

Shape (`CustomProviderConfig`):

```json
{
    "customProviders": {
        "bifrost": {
            "name": "bifrost",
            "sdk": "anthropic",
            "baseURL": "https://gateway.example.com",
            "apiKey": "sk-...",
            "headers": { "x-team": "platform" },
            "models": [
                {
                    "id": "claude-opus-4-8",
                    "name": "Opus via bifrost",
                    "contextWindow": 200000,
                    "maxOutput": 64000,
                    "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 }
                }
            ]
        }
    }
}
```

- `sdk` — the API dialect the endpoint speaks: `"openai"`, `"anthropic"`,
  `"google"`, or `"openai-compatible"`. This decides request shaping (e.g.
  Anthropic prompt caching). Pick the one matching the endpoint.
- `baseURL` — root URL. The version segment (`/v1`, `/v1beta`) is appended
  automatically when missing, so a bare host is fine.
- `apiKey` — gateway key (use a placeholder if the endpoint needs none).
- `auth` — optional richer auth; when absent the flat `apiKey` is used. Kinds:
    - `{ "kind": "apikey", "apiKey": "sk-…" }` — stored key in the vendor header.
    - `{ "kind": "bearer", "token": "…" }` — forces `Authorization: Bearer`.
    - `{ "kind": "env", "var": "MY_KEY" }` — read from the environment at
      request time, never stored.
    - `{ "kind": "helper", "command": "vault read …", "ttlMs": 300000 }` — runs
      the command, stdout is the key. Stdout may also be JSON
      `{ "key": "…", "expiresAt": <epoch-ms or ISO> }` so the key's real
      lifetime drives re-runs. Minted keys persist until expiry; a 401 forces
      a fresh mint.
    - `{ "kind": "oauth" }` — browser PKCE sign-in against the gateway's
      authorization server; tokens refresh automatically. Endpoints are
      discovered from the baseURL; for servers without discovery or dynamic
      registration set `oauth: { authorizationEndpoint, tokenEndpoint,
clientId, clientSecret?, scopes? }`.
    - `{ "kind": "none" }` — headers-only / open endpoints.

    Prefer running the `/login` → custom wizard over hand-writing this.

- `headers` — optional extra headers sent on every request.
- `models` — optional. If the endpoint supports listing, {{name}} can discover
  models; list them here to control exactly what's exposed plus names/pricing.
  Adding a model to an existing custom provider = appending to this array.

Select the model with `/model` (it appears as `custom:bifrost/claude-opus-4-8`)
or pin it: `"defaultModel": "custom:bifrost/claude-opus-4-8"`.

---

## Add a datasource (database connection)

Datasources are the saved connections the `sql` tool queries — read-only SQL
against Postgres, MySQL or Redshift. Every connection has an id (the
`connectionId` you pass to `sql`) and lives in `~/{{dir}}/datasources.json`
under `connections`, keyed by that id.

**Write this file yourself.** It is plain JSON like every other config file:
read it, edit or write it, done. `/datasource` opens an interactive panel over
the same file, but it is not the only way in — if the user asks you to add a
connection, add it. Only send them to the panel for the one thing you cannot do
(testing the connection, see below) or when they'd rather type the password
somewhere you won't see it.

Shape (`DataSourceConfig`):

```json
{
    "connections": {
        "analytics": {
            "type": "postgres",
            "host": "db.internal.example.com",
            "port": 5432,
            "database": "analytics",
            "user": "readonly",
            "password": "${env:ANALYTICS_DB_PASSWORD}",
            "ssl": true
        }
    }
}
```

- The id (`"analytics"` above) must start alphanumeric, then `[a-z0-9_-]`, ≤32
  chars. Reusing an existing id overwrites that connection. Max 50 saved.
- `type` — `"postgres"`, `"mysql"`, or `"redshift"`. Required.
- `host`, `database`, `user` — required, non-empty.
- `port` — required, positive number. Defaults by type if the user didn't say:
  postgres `5432`, mysql `3306`, redshift `5439`.
- `password` — optional (omit for trust/socket/IAM auth). Stored **as written**,
  so prefer a `${env:VAR}` placeholder: it is expanded from the environment at
  connect time, exactly like MCP config, and keeps the secret off disk. Only
  write a literal password when the user hands you one and wants it saved.
- `ssl` — optional TLS toggle. Set `true` for redshift and any remote database;
  `false`/omitted is fine for localhost.

Never invent host/database/user values or guess at a password. Ask for what the
user hasn't given you — a connection with a wrong field looks identical to a
working one until it fails.

**After writing the file, tell the user to run `/reload`** (or restart), then
they can ask for a query. `/reload` re-reads `datasources.json`, so the `sql`
tool sees the new connection — its tool description lists the available
connection ids, and that list is built per turn from this file.

**Testing the connection is the user's step, not yours.** There is no tool that
dials a database; `sql` only runs queries against an already-saved connection.
Either point them at `/datasource` → pick the connection → **test** (it reports
the real handshake result), or — once they've reloaded — just run a cheap
`sql` query like `select 1` and read the error if it fails.

What the `sql` tool will and won't do, so you set expectations correctly:

- Read-only, two layers. A static check rejects insert, update, delete, merge,
  drop, alter, create, truncate, grant, revoke, call, copy, lock (and file
  read/write functions) anywhere in the statement, and only allows a leading
  `select`, `with`, `explain`, `show`, `describe`, `values` or `table`. Then the
  query runs inside a rolled-back `READ ONLY` transaction, so the engine itself
  refuses writes. Don't offer to mutate data through it.
- One statement per call. Discover schema through `information_schema` (or the
  dialect's catalog) before querying, and put a `LIMIT` on exploratory queries.
- The tool is in the default toolset. Restricted custom agents need `sql` named
  in their `tools:` frontmatter — the built-in `data-analyst` and `plan` agents
  already have it.

---

## Add a hook

Hooks are Claude-Code-compatible lifecycle commands under the `hooks` key.
Global hooks go in `~/{{dir}}/settings.json`; project hooks in
`<cwd>/{{dir}}/settings.json` (project groups run after global groups).

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Notification`, `PermissionRequest`, `PreCompact`, `SubagentStop`, `Stop`,
`SessionEnd`.

Shape — each event maps to matcher groups; each group has `hooks` (command list):

```json
{
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "bash",
                "hooks": [{ "type": "command", "command": "./scripts/check.sh", "timeout": 60 }]
            }
        ],
        "Stop": [
            {
                "hooks": [{ "type": "command", "command": "notify-send '{{name}} done'", "async": true }]
            }
        ]
    }
}
```

- `matcher` — for tool events, the tool name to match (e.g. `"bash"`, `"edit"`).
  Omit to match everything.
- `command` — shell command. It receives a JSON payload on stdin (cwd,
  `hook_event_name`, `tool_name`, `tool_input`, `tool_output`, `prompt`, …).
- `timeout` — seconds (default 60). `async: true` = fire-and-forget.
- Exit code contract: `0` → stdout parsed as JSON for control fields
  (`decision`, `permissionDecision`, `updatedInput`, `additionalContext`,
  `systemMessage`); `2` → block, stderr is the reason; any other → non-blocking
  warning.

Existing Claude Code hook scripts port over 1:1.

---

## Add an MCP server

MCP servers are declared under `mcpServers` in `~/{{dir}}/settings.json` (global),
or per-project in `<cwd>/{{dir}}/mcp.json` (project entries win on name clash).
The project file accepts either `{ "mcpServers": { ... } }` or a bare map.

Two transports:

**stdio** (local subprocess):

```json
{
    "mcpServers": {
        "filesystem": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
            "env": { "FOO": "bar" }
        }
    }
}
```

**http / sse** (remote):

```json
{
    "mcpServers": {
        "linear": {
            "type": "http",
            "url": "https://mcp.linear.app/mcp",
            "headers": { "Authorization": "Bearer ${env:LINEAR_TOKEN}" },
            "auth": "oauth"
        }
    }
}
```

- `enabled: false` keeps the entry but skips connecting.
- `auth: "oauth"` runs the browser login flow; omit it for static-header auth.
- Secrets: use `${env:VAR}` in any string value (resolved from the environment)
  so tokens stay out of plaintext config. For servers that block anonymous
  client registration, set `clientId` / `clientSecret` / `scopes`.
- MCP has a master switch: `"mcp": false` disables all servers.

### Limiting what a server contributes

`allowedTools` / `deniedTools` filter a server's tools by its OWN tool names
(not loop's `mcp__<server>__…` keys). A denied tool is never advertised to the
model at all, so it costs no context and cannot be planned around. `deniedTools`
wins over `allowedTools`, and `"allowedTools": []` means none.

```json
{
    "mcpServers": {
        "github": {
            "type": "http",
            "url": "https://api.githubcopilot.com/mcp/",
            "allowedTools": ["list_issues", "get_issue", "create_issue"],
            "deniedTools": ["delete_repository"]
        }
    }
}
```

For large setups there is also `mcpToolSearch` (global setting): above the
threshold — 50 tools by default — the individual MCP tools stop being
advertised and the model reaches them through one `mcp_tools` tool that
searches, describes and calls them. Set a number to move the line, `false` to
always advertise everything, `true` to always search.

### Resources, prompts and elicitation

Servers that publish more than tools are used automatically:

- **Resources** — the agent reads them with the `mcp_resource` tool, and you can
  point at one in the composer with `@mcp:<server>:<uri>` (type `@mcp:` to
  complete).
- **Prompts** — each becomes a `/mcp:<server>:<prompt>` slash command, with
  arguments completed by the server itself (`name=value` or positional).
- **Elicitation** — a server may ask you a question mid-tool-call; loop shows it
  with the server's name on it. Outside interactive mode these are declined
  rather than left hanging.
- A server's own `instructions` from its handshake are included in the system
  prompt, attributed to that server.

### Staying connected

Connected servers are probed on a timer (`tools/list`, every 60s) so a server
that is up but no longer answering is caught rather than silently advertised;
`LOOP_MCP_HEALTH_INTERVAL_MS=0` turns that off. A server that drops is
reconnected automatically with backoff, and `/mcp` offers `inspect` and
`check health` per server.

---

## Create a custom agent

Custom agents are named system prompts at `~/{{dir}}/agents/<name>.md`. Each file
registers a `/<name>` slash command. The name must start alphanumeric and be
≤32 chars of `[a-z0-9_-]` (case-insensitive).

Format — optional frontmatter with `tools:` and/or `model:` lines, then the
prompt body:

```markdown
---
tools: read, grep, find, ls
model: openai/gpt-5-mini
---

You are a meticulous code reviewer. You investigate and report; you never edit.
```

- `tools:` — comma-separated subset of: `read, write, edit, bash, ls, grep,
find, sql, shells, task, ask, websearch, plan, todo, skill`. Omit the
  frontmatter entirely to grant all tools. `ask`, `websearch`, `todo` and
  `shells` only activate when their settings toggles (`askUser` / `webSearch`
  / `todos` / `backgroundShells`) are on;
  `skill` rides the `skills` setting + project trust. `plan` is the
  plan-delivery tool: calling it ends the agent's turn with a finished plan
  the user can hand to an implementing agent — name it only for
  planner-style agents.
- `model:` — full `provider/model` id this agent runs on when spawned as a
  subagent (task tool). Cross-provider is fine. Omit = inherit (the
  `subagentModel` setting if set, else the parent's model). If the id is
  unknown or its provider isn't logged in, the run falls back to the parent's
  model with a warning instead of failing.
- No frontmatter = full toolset, inherited model.
- Built-in names (`default`, `plan`, `data-analyst`) are special: saving a file
  under one of those names overrides only its **prompt** and **model** — their
  tool sets are fixed and ignored. Delete the file to reset.
- An agent that has `bash` but neither `write` nor `edit` runs bash read-only
  (sandboxed) — useful for review/plan-style agents.

Write the file with the write tool, then have the user hard-reload so the new
`/<name>` command appears.
