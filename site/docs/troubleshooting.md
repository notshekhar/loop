<!-- title: Troubleshooting -->
<!-- order: 10 -->
<!-- blurb: What to check first, and fixes for the problems people actually hit. -->

## Start here

Start loop and run `/doctor`. It checks install, PATH, credentials, catalog, daemons, and project trust in one pass, and most of what follows is faster to find that way.

`/doctor` is a TUI command — there is no `loop doctor` on the CLI. From the shell you get the pieces separately:

```
loop whoami        # which providers you're signed in to, which is active
loop models        # what the catalog currently knows
loop version
```

## Install

**`loop: command not found`** — the installer's directory isn't on your `PATH`. It prints the exact line to add for your shell; open a new terminal after adding it. On Windows the installer updates the current session too, so this usually means the install didn't finish.

**Alpine / musl: the binary won't start.** Install `gcompat`, or build from source with `LOOP_FROM_SOURCE=1`.

**Windows SmartScreen blocks the first run.** Click **More info** → **Run anyway**. The binary is unsigned; that's the whole warning.

**Windows on ARM** runs the x64 build under Windows 11's emulation. That's expected, not a fallback failure.

## Models and providers

**A model isn't in the picker.** The catalog refreshes from models.dev hourly. If it's brand new or private, add it yourself — see [Adding a model](configuration.html#adding-a-model).

**"no provider" at startup.** Nothing is signed in and nothing was detected. Run `loop login`, or start Ollama, or make sure your AWS credentials work (`aws sts get-caller-identity`) if you're expecting Bedrock.

**A key in an environment variable isn't being used.** The name must be the provider id uppercased plus `_API_KEY` — with one exception: Vercel AI Gateway reads `AI_GATEWAY_API_KEY`, not `VERCEL_API_KEY`. Also note a _stored_ credential wins over the environment; `loop logout <provider>` if you want the env var to take over.

**Requests fail through a gateway with an error naming a parameter loop didn't send.** Some gateways parse and re-serialize requests against their own model table, rewriting newer thinking parameters into retired shapes. loop detects a rejected thinking parameter, rewrites the request into the next form, retries once transparently, and remembers the shape that worked per provider and model in `~/.loop/model-shapes.json`. If it still fails, the original error is what surfaces — auth failures, rate limits, and bad `max_tokens` are passed through untouched.

**Ollama models don't show up.** The daemon has to be running before loop looks. Non-default host: set `LOOP_OLLAMA_BASE_URL`.

## Sessions

**A session vanished.** Sessions are scoped to the directory you started loop in. `cd` back to the project and run `/resume`, or `loop sessions` to list what's there.

**Context is full.** loop compacts on its own when the context crosses `autoCompactThreshold` (80% by default) — between steps as well as between turns — and keeps the last ~20k tokens word for word. `/compact` does it now; `/compact focus on the API changes` steers what the summary keeps. `/context` shows what's actually loaded — often it's a large file read early on, and `/tree` lets you branch back to before that happened.

**You want an earlier state back.** `/tree` navigates the whole session; selecting an earlier point branches there and offers to summarize the abandoned branch back into context.

## Tools and permissions

**The agent refuses a bash command.** It matched `bashDeny`. Defaults are `git commit` and `git push`. Change the list in `settings.json` or with `/bashdeny`.

**`[loop sandbox] … ran WITHOUT isolation`.** The sandbox couldn't be applied on this platform, so the command ran unsandboxed rather than silently failing. The `plan` agent is the exception — it refuses instead.

**Hooks or skills in a repo aren't running.** The project isn't trusted yet. loop asks on first open; if you declined, `/doctor` reports it.

**A `~/.claude` hook is misbehaving.** Claude Code hooks and plugins are imported automatically. Narrow what comes in with the `claudeHooksFilter` setting.

## Telegram

Covered in full on the [Telegram page](telegram.html#when-it-isn-t-working). The short version: `loop gateways status`, then read `~/.loop/agent/gateway-telegram.log`. A 409 in that log means two bridges are polling the same bot token.

## Background tasks

**Scheduled tasks never run.** The scheduler daemon isn't installed. `loop background daemon install`, then `loop background daemon status` to confirm. Without it, tasks only run when something calls `loop background tick`.

**A task ran but you can't see what it did.** `/background` → the task → reopen its last run as a session.

## Reporting a bug

`/doctor` output plus `loop version` is most of what's needed. Issues go to [github.com/notshekhar/loop](https://github.com/notshekhar/loop/issues).
