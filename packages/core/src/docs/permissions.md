# Permissions and plan mode

How {{name}} decides whether a tool call runs: permission rules
(allow/ask/deny), the bash guardrails, per-project grants, and plan mode.
These are guardrails for honest agents, not a security boundary — the OS
sandbox (`"sandbox"` in settings) is the jail.

## Permission rules

Rules live under the `permissions` key in `~/{{dir}}/settings.json`
(global) and, for trusted projects, in `<dir>/{{dir}}/settings.json` at every
level from the working directory up to the git root. All sources merge into
one set.

```json
{
    "permissions": {
        "deny": ["Bash(rm -rf *)", "Read(secrets/**)", "Edit(**/*.pem)"],
        "ask": ["Bash(git push*)", "Edit(infra/**)"],
        "allow": ["Bash(git *)", "Bash(npm run build)"]
    }
}
```

A rule is `Tool(pattern)`, a bare tool name (`Read` — every call of that
tool), or `*` (every tool). Recognized tools: `Bash`, `Read` (also covers
`ls`; `NotebookRead` accepted), `Edit` (also covers `write`; `Write`/
`NotebookEdit` accepted), `Grep` (also covers `find`; `Glob` accepted),
`WebSearch`, `MCPTool`. Unrecognized names are skipped, not fatal.

### How a rule matches

**Severity decides, never order or source**: any matching `deny` refuses,
else any matching `ask` prompts, else any matching `allow` approves, else the
call falls through to the guardrails below. A global `deny` cannot be
overridden by a project `allow`.

**Bash patterns** match as a literal prefix (`Bash(git)` also matches
`gitleaks` — add a trailing space + `*` for a word boundary), or as a glob
over the whole command when the pattern contains glob characters (`*` crosses
spaces and slashes: `Bash(git * main)` matches `git checkout main`). A
trailing `:*` is stripped to a plain prefix.

Chained commands are split on `&&`, `||`, `;`, `|` and newlines — with
`$(...)`, backticks and `sh -c "…"` bodies flattened in:

- `deny` and `ask` rules are checked against **every segment** and the whole
  string. One denied segment refuses the entire command, and env-assignment /
  wrapper prefixes (`sudo`, `env`, `timeout`, …) are peeled first, so
  `FOO=1 timeout 5 git push` still hits a `Bash(git push*)` rule.
- `allow` rules must cover **every segment** — each executed command has to
  match some allow rule, so `Bash(git *)` approves `git status && git log`
  but not `git status && rm -rf /`. Pair narrow allows with denies for the
  patterns you never want.

**Path patterns** (Read/Edit/Grep) are globs where `*` and `?` do not cross
`/` and `**` does; `**/` also matches zero directories (`**/.env` matches a
top-level `.env`). A pattern without glob characters matches only that exact
string. Paths are matched in both the form the tool was called with and the
cwd-relative / absolute counterpart, so a relative rule can't be dodged with
an absolute path. `Read` deny/ask rules also govern `grep`/`find` (what you
may not read, you may not search).

### The ask tier

An `ask` rule forces an interactive approval prompt **even when
`bashApprove` is off**. In non-interactive runs (print mode, RPC) an ask rule
fails closed: the call is refused with a message telling the model to
continue without it. A remembered "always allow" grant satisfies an ask rule
without re-prompting — unless the command is on the dangerous list.

## Evaluation order for bash

1. **`bashDeny` denylist** — refused outright (defaults: `git commit`,
   `git push`; managed via `/bashdeny`).
2. **`deny` rules** — refused outright.
3. **`ask` rules** — prompt (or fail closed headless). Remembered grants
   satisfy, dangerous commands never do.
4. **`allow` rules** — run without prompting.
5. **`bashApprove`** (default off) — when on, anything not remembered
   prompts: deny / allow once / always allow (this project) / never allow.

"**Always allow**" persists to the current project only (stored in
{{name}}'s database, not the repo) — a grant made in one project never
applies in another. The legacy global `bashAllow` settings list still
matches. "**Never allow**" adds the same patterns to `bashDeny`.

**Dangerous commands** (`rm`, `chmod`, `chown`, `chgrp`, `chattr`, `pkill`,
`kill`, `killall`, `git push`) always re-prompt instead of riding a
remembered grant. An explicit `allow` **rule** in configuration does approve
them — that's a deliberate written decision.

## Plan mode

Plan mode is a read-only phase enforced at the tool layer, independent of
which agent or settings are active:

- `edit`/`write` are rejected with a plan-mode message.
- `bash` runs inside the fail-closed, kernel-enforced read-only sandbox — if
  the sandbox can't start, the command is refused rather than run.
- Subagents inherit the gate; delegation cannot widen write access.

Enter it with **`/plan`** (toggle) or **`/plan <task>`** (enter and start
planning in one step). The agent may also request it via the
`enter_plan_mode` tool when a task is genuinely ambiguous — that requires
your approval. The status line shows `plan mode (read-only)` while active.

### Leaving plan mode

Every exit is yours to approve — the agent can ask, never decide. Which
prompt you get depends on who is planning:

- **A normal agent** (it entered plan mode itself, or you ran `/plan`)
  delivers the plan through the `exit_plan_mode` tool. The plan renders in
  full, and you choose _implement it_ (plan mode off — that same agent starts
  building immediately, in the same turn, with everything it just learned) or
  _keep planning_ (the gate stays shut; tell it what to change and it calls
  again).
- **The `plan` agent** (and any read-only agent) delivers through the `plan`
  tool instead — lifting the gate buys it nothing, since it has no `edit`/
  `write` tools. Delivery ends the turn and you choose _implement it_, which
  hands the plan to an agent you pick, or _talk about it_, which keeps plan
  mode on so you can iterate.

`/plan` toggles the mode off at any time. Non-interactive runs (print mode,
RPC) have nobody to ask, so they always use the `plan` tool and never exit on
their own.
