<!-- title: Configuration -->
<!-- order: 9 -->
<!-- blurb: What lives in ~/.loop, the settings worth knowing, per-project config, and adding a model the catalog doesn't have. -->

## Where things live

```
~/.loop/
├── auth.json          # provider tokens, custom gateways, bot tokens (mode 600)
├── settings.json      # defaultModel, thinkingLevel, hooks, mcpServers, toggles
├── models.json        # user-added models / catalog overrides
├── catalog.json       # model catalog cache
├── agent.db           # SQLite: session trees, cost ledger, memory, reminders, tasks
├── agents/*.md        # custom agents (and built-in prompt overrides)
├── extensions/        # installed JS extensions
└── agent/
    ├── prompts/*.md   # custom slash commands
    ├── skills/*.md    # auto-registered skills
    ├── themes/*.json  # custom themes
    └── memory/        # per-project durable facts
```

All config files are plain JSON. Unknown keys are preserved, so editing one key won't disturb the rest.

## Per-project config

`<repo>/.loop/` holds project settings, hooks, skills, and MCP servers, and overrides the global ones. It's gated by **project trust**: the first time you open a repo that ships hooks or skills, loop asks before executing anything.

The last model you picked in a folder is remembered per project.

`AGENTS.md` and `CLAUDE.md` in a repo load automatically as workspace context. `/init` writes one by reading the codebase.

## Settings worth knowing

`/settings` toggles these live; they're top-level keys in `settings.json`.

| Key                   | Default                  | What                                                                           |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `defaultModel`        | —                        | Full `provider/model` id                                                       |
| `thinkingLevel`       | —                        | `off` … `xhigh`                                                                |
| `theme`               | `night`                  | `night` / `day` / `system`, plus any JSON theme in `agent/themes/`             |
| `webSearch`           | off                      | The `websearch` tool (DuckDuckGo, no API key)                                  |
| `askUser`             | off                      | Lets the agent pause and ask you multiple-choice questions                     |
| `todos`               | off                      | Visible checklist the agent maintains during multi-step work                   |
| `memory`              | on                       | Durable per-project facts under `agent/memory/<project>/`                      |
| `skills`              | on                       | SKILL.md folders, gated by project trust                                       |
| `subagentModel`       | —                        | Default model for subagents; an agent file's own `model:` wins                 |
| `subagentMaxParallel` | `4`                      | How many subagents stream at once (`0` = unlimited)                            |
| `bashApprove`         | off                      | Ask before every bash command                                                  |
| `bashDeny`            | `git commit`, `git push` | Commands `bash` refuses outright                                               |
| `permissions`         | —                        | allow/ask/deny rules over tools                                                |
| `sandbox`             | off                      | Kernel-enforced bash isolation — see [Extending](extend.html#the-bash-sandbox) |
| `claudeHooksFilter`   | —                        | Which imported `~/.claude` hooks to keep                                       |

`permissions` takes rules over tool calls:

```json
{
    "permissions": {
        "deny": ["Bash(rm -rf *)", "Read(secrets/**)"]
    }
}
```

Trusted projects can add their own under the same key in `<repo>/.loop/settings.json`. `/permissions` manages them from the TUI.

Changing settings by hand needs a **hard reload** (`/reload`) to take effect.

## Adding a model

If a model isn't in the catalog — a brand-new release, an OpenRouter `:free` variant, a private deployment — add it via `/model` → **+ add model…**, or by hand in `~/.loop/models.json`:

```json
{
    "openrouter/nex-agi/nex-n2-pro:free": {
        "id": "openrouter/nex-agi/nex-n2-pro:free",
        "provider": "openrouter",
        "name": "Nex AGI: Nex-N2-Pro (free)",
        "contextWindow": 262144,
        "maxOutput": 262144,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "reasoning": true,
        "modalities": ["text", "image"],
        "available": true
    }
}
```

Keys are full `provider/model-id` ids. Entries merge **over** the built-in catalog, so the same file also overrides pricing or context windows of models loop already knows.

`cost` is per million tokens and defaults to `0` — set it if you want cost tracking to bill the model. The id isn't validated up front; a wrong one simply errors on the first request.

The catalog itself refreshes from models.dev hourly, so new public models usually just appear without you doing anything.

## Themes

`night` (default) and `day` wash the canvas — they claim the terminal's own background and foreground, so the whole screen is the theme's. `system` is the same ink with no canvas of its own: it asks the terminal what its background is and rebuilds every slot to hold the same contrast against it, so your true black, transparency or background image shows through.

Drop pi-mono-format JSON themes into `~/.loop/agent/themes/` and pick one via `/theme` or `/settings → theme` — it applies live, and the pick is saved under the `theme` key.

## Environment variables

| Variable                    | What                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `LOOP_HOME`                 | Where loop's files live (default `~/.loop`)                               |
| `LOOP_SKIP_VERSION_CHECK=1` | Silence the startup update check                                          |
| `LOOP_OLLAMA_BASE_URL`      | Point at a non-default Ollama host                                        |
| `<PROVIDER>_API_KEY`        | Provider credentials — see [Signing in](login.html#environment-variables) |
