# Draft: register `loop` as a cmux-integrated agent

Ready to file against [`manaflow-ai/cmux`](https://github.com/manaflow-ai/cmux)
as an issue or a PR description. Nothing here is required for loop's cmux
integration to work — it works against stock cmux today. This closes the two
gaps that only cmux can close. Everything below was measured against cmux
1.3.2 on macOS.

---

## What loop already does

[loop](https://github.com/notshekhar/loop) is a terminal coding agent. Inside a
cmux pane it detects `CMUX_SURFACE_ID` + `CMUX_SOCKET_PATH` and speaks the
socket directly, with no install step and no generated hook files:

- **Telemetry.** Every lifecycle event it emits — `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TodoWrite`, `Notification`,
  `Stop` (with `last_assistant_message`), `SessionEnd` — goes out as
  `feed.push` with `_source: "loop"` and `wait_timeout_seconds: 0`. loop's hook
  payloads are already Claude Code–shaped, so no translation happens.
- **Actionable cards.** Its approvals (bash, file access, plan mode) and its
  ask tool's questions are pushed with `_opencode_request_id`, which parks the
  connection; the decision comes back on it as
  `result: {status: "resolved", decision: {...}}` and is applied to the prompt
  showing in the terminal. The on-screen prompt and the cmux card race — first
  answer wins, the other is withdrawn — so a Feed timeout costs nothing.

## What it cannot do, and what would fix it

### 1. The Feed source enum coerces `loop` to `claude`

`feed.push` keeps `_source` in the events stream — `cmux events --category
feed` shows `"source": "loop"` — but the stored item comes back as
`"source": "claude"`. Probing one push per candidate name and reading
`~/.cmuxterm/workstream.jsonl` back:

| `_source` sent                                                                                   | stored `source` |
| ------------------------------------------------------------------------------------------------ | --------------- |
| `pi`, `amp`, `cursor`, `gemini`, `copilot`, `codebuddy`, `factory`, `qoder`, `hermes-agent`      | itself          |
| `loop` (and `omp`, `campfire`, `kiro`, `kimi`, `rovodev`, `antigravity`, `custom`, `unknown`, …) | `claude`        |

So loop's rows are attributed to Claude Code in the sidebar, and a pane running
both is indistinguishable.

**Ask:** add `loop` to the source enum. If a general escape hatch is preferable
to a per-agent entry, a `custom:<name>` form — the shape herdr uses for exactly
this problem — would cover every agent that is not worth an enum entry, and
loop would switch to it happily.

### 2. `cmux hooks loop <event>` is rejected, so there is no lifecycle state

```
$ cmux hooks loop session-start --workspace $CMUX_WORKSPACE_ID --surface $CMUX_SURFACE_ID
Error: Unknown hooks target: loop
```

`~/.cmuxterm/<agent>-hook-sessions.json` is what carries
`agentLifecycle: running | idle | needsInput`, and with it the tab indicator,
Agent Hibernation, and automatic session restore on relaunch. All of it is
per-agent by construction, so an agent cmux does not know gets none of it.

`cmux hooks feed --source loop --event PermissionRequest` is accepted but
records the event as generic tool telemetry rather than a permission card —
the event mapping is per-source too. (The raw `feed.push` verb _does_ honour
`hook_event_name` for an unknown source, which is why loop uses the socket
directly rather than the CLI bridge.)

**Ask:** register `loop` the way Campfire is registered — a natively
integrated agent, no installer, because the bridge ships inside the agent:

| Field           | Value                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Agent name      | `loop`                                                                                                                           |
| Binary checked  | `loop`                                                                                                                           |
| Installed file  | none — built in, like Claude Code's wrapper and Campfire's native bridge                                                         |
| Session restore | `loop --session <id>`                                                                                                            |
| Feed bridge     | `PermissionRequest`, `AskUserQuestion`, `ExitPlanMode` (blocking); `PreToolUse` / `PostToolUse` / `TodoWrite` / `Stop` telemetry |
| Disable env     | `CMUX_LOOP_HOOKS_DISABLED=1`                                                                                                     |

If `cmux hooks loop <event>` accepts the same subcommands the `pi` extension
uses (`session-start`, `prompt-submit`, `notification`, `stop`), loop will call
them instead of pushing those four over the socket — the payloads are already
identical.

## Why not install a hook file like the other agents

loop's cmux support is built into loop and gated on cmux's own env, so there is
nothing to install, nothing to keep in sync with a cmux upgrade, and nothing
left behind if loop is uninstalled. `cmux hooks setup` would have nothing to
write. This is the Campfire arrangement, and it is the reason the ask is for a
registration rather than a generated `~/.loop/agent/extensions/cmux-session.ts`
(which would also work — loop's extension API is a fork of pi's, so cmux's
existing pi extension nearly runs on it unmodified).
