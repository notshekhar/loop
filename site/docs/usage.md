<!-- title: Daily use -->
<!-- order: 4 -->
<!-- blurb: Sessions, the session tree, models, agents, tools, and every slash command worth knowing. -->

## Starting loop

```
loop                              # interactive TUI in the current directory
loop --cwd ~/code/other           # somewhere else
loop --model anthropic/claude-sonnet-4-6
loop --session <id>               # resume a specific session
```

loop is directory-scoped: sessions belong to the folder you started in, and the last model you used in a folder is remembered per project.

### One-shot mode

```
loop run "explain this repo"
echo "summarize the diff" | loop run -
loop run "fix the failing test" --max-steps 20
```

Prints the final response to stdout and exits. No UI, pipeable, safe in scripts. `--max-steps` caps how much work it will do.

## Sessions

| Command                | What                                              |
| ---------------------- | ------------------------------------------------- |
| `/new`                 | Fresh session (`/clear` also clears the screen)   |
| `/resume`, `/sessions` | Pick an earlier session in this directory         |
| `/session`             | What the current one is                           |
| `/name <text>`         | Name it, so it's findable later                   |
| `/export`, `/import`   | Transcript out, transcript in                     |
| `/share`               | Shareable transcript                              |
| `/compact [focus]`     | Summarize the conversation to reclaim context     |
| `/context`             | What's currently loaded and how much room is left |
| `/shells`              | Background shells: run, read, kill                |

From the shell, `loop sessions` lists sessions in the current directory with ids, models, and timestamps.

Messages and slash commands typed while the agent is generating **queue up** and run when the turn ends. `Esc` interrupts.

## Sessions are trees

This is the part that isn't like other agents. Every entry has a parent, so a session is a tree rather than a flat transcript — you can go back to any earlier message and take a different path without losing the first one.

- **`/tree`** — navigate the whole session as an ASCII tree. Fold branches, filter (no-tools / user-only / labeled / all), type to search, bookmark entries with `shift+l`. Selecting an earlier point branches there, and loop offers to **summarize the abandoned branch** — optionally with your own prompt — so its context survives the switch.
- **`/fork`** — pick a previous user message; the path up to it is copied into a **new session**, and the message text comes back to your editor for editing.
- **`/clone`** — duplicate the current conversation into a new session.

The practical use: try an approach, watch it not work out, branch back to before you suggested it, and try the other one — with the agent still knowing what went wrong the first time.

## Models

| Command          | What                                                |
| ---------------- | --------------------------------------------------- |
| `/model`         | Searchable picker across every provider you can use |
| `/provider`      | Switch the active provider                          |
| `Ctrl+P`         | Cycle recent models without a picker                |
| `/thinking`      | `off · minimal · low · medium · high · xhigh`       |
| `/scoped-models` | Pin a model per agent                               |

Thinking level maps to whatever each provider calls it — Anthropic budget tokens, OpenAI/xAI/OpenRouter reasoning effort, Google `thinkingConfig` — so one setting works everywhere.

`/scoped-models` is how you stop paying frontier prices for grunt work: pin a cheap fast model to subagents and keep the expensive one for the main loop.

## Agents

Tab on an empty prompt cycles the built-ins:

- **`default`** — the full toolset
- **`plan`** — read-only investigator. Its bash runs in a kernel-enforced read-only, network-denied sandbox, and is refused outright if that can't be enforced. It treats a plan as a **deliverable**: when the plan is final it calls the `plan` tool, which ends the turn and renders the plan as markdown for you to hand off or keep refining.
- **`data-analyst`** — SQL-first work against a `/datasource`

`/agents` builds your own: custom system prompt, tool allowlist, optional pinned model. It registers as `/<name>` for one-shot use — `/reviewer look at the auth changes`.

**Subagents**: the `task` tool forks the current agent into a fresh context window. Activity streams live in the task box while it runs, but **only the final report enters your context** — that's the point, a subagent can read fifty files and cost you one paragraph.

## Tools

`read` · `bash` · `edit` · `write` · `grep` · `find` · `ls` · `sql` · `shells` · `task`

Colored diffs, syntax-highlighted output, file previews. `read` also fetches `http(s)://` URLs as readable text, and takes `offset`/`limit` for large files. `edit` and `write` enforce read-before-modify within a session, so the agent can't overwrite a file it hasn't looked at.

**Background shells**: `bash` takes `run_in_background` for a command that isn't supposed to finish — a dev server, a watcher, a tail. It returns straight away and the process keeps running while the agent works; the `shells` tool reads what it has printed since the last look, and the agent is told when it exits rather than polling for it. A foreground command that outruns its timeout is **moved** to the background instead of being killed, so a long build never dies at the two-minute mark.

Running shells are pinned above the prompt, and `/shells` is your side of the same registry — `/shells run <cmd>` to start one yourself, `/shells <id>` to read it, `/shells kill <id>|all` to stop it. They belong to the session, not the turn: pressing esc ends the turn and leaves your server running. They do not survive loop itself — everything still running is stopped on exit.

Opt-in, via `/settings`:

- **`websearch`** — DuckDuckGo, no API key
- **`ask`** — lets the agent pause and ask you a multiple-choice question instead of guessing

## Images

Paste with `Ctrl+V`, `/attach <path>`, or `Ctrl+I` for a file picker. Screenshot a broken UI or a stack trace and ask about it directly.

> On macOS, `Cmd+V` cannot paste an image into a terminal: the terminal handles that keystroke and only knows how to type text. `Ctrl+V` is the one that works — it pastes an image when the clipboard holds one, and the clipboard's text when it doesn't.

## Workspace context

- `AGENTS.md` / `CLAUDE.md` in the repo load automatically as workspace context. `/init` writes one for you by reading the codebase.
- `*.md` under `~/.loop/agent/skills/` or `.loop/skills/` register as `/skill:<name>`, and the model can invoke them itself via the `skill` tool when a task matches the skill's description.
- `*.md` under `~/.loop/agent/prompts/` become slash commands.
- `/memory` keeps durable facts per project.

## Cost

The footer shows live cost, usage, and context per step, subagents included. `/cost` breaks it down by session, directory, today, last 7 days, month, and lifetime per provider. Anthropic prompt caching is handled automatically, with cache breakpoints moved across multi-step turns.

`loop cost audit` reconciles the ledger against the transcripts if you want to check the numbers.

## Every slash command

| Group      | Commands                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Sessions   | `/new` `/clear` `/resume` `/sessions` `/session` `/name` `/export` `/import` `/share` `/compact` `/context`                       |
| Tree       | `/tree` `/fork` `/clone`                                                                                                          |
| Models     | `/model` `/provider` `/thinking` `/scoped-models`                                                                                 |
| Agents     | `/agents` `/<agent> <message>`                                                                                                    |
| Automation | `/background` `/goal` `/daemon` `/reminder` `/timer` `/recap`                                                                     |
| Setup      | `/login` `/logout` `/settings` `/mcp` `/extensions` `/hooks` `/bashdeny` `/permissions` `/gateways` `/doctor` `/reload` `/update` |
| Misc       | `/help` `/cost` `/steak` `/memory` `/init` `/attach` `/paste` `/copy` `/cd` `/hotkeys` `/changelog` `/alias` `/quit`              |

`/hotkeys` lists key bindings. `/alias` makes your own shortcuts.

## Other surfaces

```
loop serve                # web UI + WebSocket RPC (opt-in via /settings, token-locked)
loop rpc                  # JSON-RPC over stdio
loop rpc --socket         # …over a Unix socket
loop man                  # the manual (--install writes it to the manpath)
loop completion zsh       # tab completion for bash, zsh, or fish
```

Next: [automate it](automation.html) or [drive it from your phone](telegram.html).
