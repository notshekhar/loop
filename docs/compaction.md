# Compaction — how it works today, how others do it, what we build

Status: plan. Nothing here is implemented yet. Loop first; pi-agent ports it
after (pi must mirror loop).

Problem that started this: compaction times out on big sessions.

---

## 1. Loop today

Entry point: `packages/core/src/agent/compact.ts` → `runCompact`. One
summarizer request lives in `agent/summarize.ts` → `requestSummary`.

### Triggers

| trigger                   | where                                              | when                                                                                          |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| manual `/compact [focus]` | `cli/src/interactive/handlers/session-handlers.ts` | user asks                                                                                     |
| auto, pre-turn            | `turn.ts` (~916)                                   | estimate > `autoCompactThreshold` (0.7) of window, **before the first step — the turn waits** |
| auto, mid-turn            | `turn.ts` (`compactionDue`)                        | after a tool step, next request would cross 0.8                                               |
| overflow                  | `turn.ts` attempt loop                             | provider says context too long → compact + retry once                                         |
| idle                      | `agent/idle-compact.ts`                            | anthropic/openai/xai, ≥70% full, 4m15s after the turn (cache TTL − 45s)                       |

`context-policy.ts` lets an extension choose `rollover` (no model call,
`agent/rollover.ts`) instead of summarizing. No extension → always summarize.

### What `runCompact` does

1. **Cut** — walk back from the end keeping `min(20k, 25% of window)` tokens
   (chars/4). Never start on a tool result.
2. **Serialize** everything before the cut to text: reasoning dropped, tool
   results ≤ 2,000 chars, media → `[image]`.
3. **Summarize** — one streamed request on the session's own model, same
   reasoning level, output cap ≤ 32k. pi's Goal / Constraints / Progress /
   Key Decisions / Next Steps / Critical Context prompt; UPDATE prompt folds in
   the previous summary.
    - history > `min(800k chars, 70% window)` → chunks, rolling summary,
      **sequential**
    - cut inside a turn → turn-prefix summary in parallel
    - overflow → halve the budget, ≤ 3 times; dropped stream / 5xx → retry ≤ 3
4. Append `<read-files>` / `<modified-files>` from the tool calls.
5. Append one entry `{type: "compact", summary, cutAt}`. Nothing is deleted.
6. Next request (`compactedContextEntries`): summary block → todo re-inject
   (if cut away) → kept messages.

### Why it times out (suspects)

1. **Idle path uses `generateText` (non-streaming)** — a silent socket for the
   whole summary. `summarize.ts`'s own comment names this failure.
2. **Reasoning on** for the summary: long think over ~200k tokens before any
   text.
3. **Retry on timeout re-sends the same huge request** (`ETIMEDOUT`,
   `UND_ERR_BODY_TIMEOUT` are retryable) — up to 4× the wait.
4. **Sequential chunks** — N full calls back to back.
5. **Pre-turn compaction blocks the turn**, no progress, no deadline.
6. Root cause behind all of them: the context is allowed to fill with old,
   bulky tool output, so every summary request is enormous.

---

## 2. pi-mono (`packages/coding-agent/src/core/compaction/compaction.ts`)

Loop copied it — prompts word for word. Same: keep 20k, serialize to
`<conversation>`, structured checkpoint, update prompt, split turn, file lists,
session model + thinking level, streamed (`completeSimple` = `streamSimple`),
stream-drop retry, overflow compact-and-retry once.

Differences:

|                   | pi-mono                                                   | loop                               |
| ----------------- | --------------------------------------------------------- | ---------------------------------- |
| when              | after the turn ends (`agent_end`) or before prompt submit | before first step **and** mid-turn |
| threshold         | `window − reserveTokens (16,384)` ≈ 92%                   | 80%                                |
| measure           | real `usage` of last response; estimate fallback          | chars/4 estimate                   |
| oversized history | one request                                               | chunked rolling summary            |
| split turn        | sequential                                                | parallel                           |
| cache             | `cacheRetention: "none"` on the summary                   | not set                            |
| idle compaction   | none                                                      | yes, non-streaming                 |

---

## 3. Claude Code (decodeclaude.com/compaction-deep-dive)

Three layers:

1. **Microcompaction** — large tool results (read, bash, grep, glob, web,
   edit, write) are written to disk; the context keeps a path reference. A
   small hot tail of recent results stays inline; older ones are re-readable.
2. **Auto-compaction with reserved headroom** — two reservations: output
   headroom and _compaction_ headroom (so the summary request itself still
   fits). Fires when free space drops below them. Tiny sessions skipped.
3. **Manual `/compact <focus>`**, plus a persistent "Compact Instructions"
   section from the project file appended to every compaction prompt.

Summary checklist: intent, decisions, files + why, errors + fixes, pending
tasks + exact state, next step matching the latest request.

**Rehydration after the boundary**, in order: boundary marker → summary →
**5 most recent files re-read from disk** → todo list → plan state → hook
output. Wrapped in "This session is being continued from a previous
conversation … continue without asking".

---

## 4. gemini-cli (`packages/core/src/context/`)

Default path: `chatCompressionService.ts`, called from `core/client.ts` before
each request (`tryCompressChat`), then `toolOutputMaskingService.ts`.

### Compression

- **Threshold 0.5** of the model's limit (`DEFAULT_COMPRESSION_TOKEN_THRESHOLD`),
  measured from the last prompt's real token count, estimate as fallback.
- **Keep the last 30%** of history by chars (`COMPRESSION_PRESERVE_THRESHOLD`);
  split only on a plain user message (never a tool response).
- **Before summarizing, `truncateHistoryToBudget`**: walk newest → oldest,
  tool responses get a 50k-token budget (`COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET`);
  past it, each response is saved to a temp file and replaced by its last ~30
  lines + the file path. Summarizer gets the original history if it fits the
  model, else the truncated one.
- **Summarizer model is mapped down**: `modelStringToModelConfigAlias` —
  flash-lite sessions compress with flash-lite, etc. (a dedicated
  "chat-compression-*" config).
- Sends the history **as real turns** (not serialized text) + an instruction;
  system prompt `getCompressionPrompt` (`prompts/snippets.ts`): prompt-injection
  guard, think in `<scratchpad>`, then an XML `<state_snapshot>`:
  `overall_goal, active_constraints, key_knowledge, artifact_trail,
file_system_state, recent_actions, task_state` (+ approved-plan section
  when one exists). A previous snapshot in history must be integrated.
- **Second "probe" call**: "critically evaluate the snapshot you just wrote,
  output a FINAL improved one or repeat it". Two model calls per compression.
- New history: `[user: snapshot] [model: "Got it. Thanks for the additional
context!"] ...kept`.
- Rejects the result if the new token count is **larger** than before
  (`COMPRESSION_FAILED_INFLATED_TOKEN_COUNT`).
- **After one failed summary, auto mode stops calling the model** and only
  truncates (`hasFailedCompressionAttempt` → `CONTENT_TRUNCATED`). No retry
  storm.
- Non-streaming `generateContent`; abort signal is a TODO in their code.

### Tool output masking (their microcompaction)

`ToolOutputMaskingService`, runs before every request:

- Newest **50k tokens** of tool output protected (and the whole latest turn).
- Older tool outputs are masked (written to `tool-outputs/`, replaced by a
  `<tool_output_masked>` stub) — **only once ≥ 30k tokens are prunable**, so it
  fires in batches, not every turn (cache-friendly).
- Exempt: activate_skill, ask_user, enter/exit plan mode.
- `collapseOlderFunctionResponses`: tool responses older than the last 3 tool
  turns collapse to a 2 KB preview — except retrieval tools (read_file, grep,
  glob, …), which keep full fidelity.

### Experimental (`contextManagement.enabled`, off by default)

Graph-based pipeline with processors: tool masking, node distillation
(tool output > 10k tokens truncated; > 20k → model writes an "intent summary"),
blob degradation, rolling summary, **async state snapshot** (built in the
background, not on the request path). History window 150k max / 40k retained.

---

## 5. fx (Vercel Labs, Zig — `fx/src/core/compactor/`)

The most different design. **The model does not write the summary; code
does.** The model only writes short notes, and code checks them.

One entry point `compactor.compact` for manual, auto and overflow. Files:
`window.zig` (what to compact), `summarize.zig` (build the compacted
conversation), `ledger.zig` (what the model is asked), `lint.zig` (verify it),
`model.zig` (which model), `records.zig` (saved records + search),
`checkpoint.zig` (saved format).

### Sizing (`window.zig`, `settings.zig`)

- `auto_compact_percent` default **80**, allowed **10–80**, of the model's
  _usable_ input (window − output reservation).
- Target after compaction: whole request ≤ **20% of usable input** and ≤ half
  the compaction point — it frees a lot, so it doesn't fire again soon.
- Kept turns: newest, **at most 4**, within **40%** of that room.
- `fixed_tokens` (system prompt + tool schemas) is measured and subtracted.
- **Estimate correction:** scales its chars estimate by the provider's real
  count from a recent request (`Correction{estimated, measured}`).
- On overflow: room bounded by the rejected request (summary request ≤ ¾ of it).

### What it keeps (`summarize.zig`, `checkpoint.zig`)

- **Every user message and every final assistant reply, word for word.** Only
  if the result won't fit are the longest clipped, each naming the record
  that holds it whole.
- What happened in between (tool calls, intermediate text) → a model-written
  note per turn (≤ 1,200 bytes) and a line per tool call (≤ 300 bytes; code
  writes the tool name/args part).
- Session **entries, append-only**: Rules (must quote the user verbatim),
  Facts, Decisions, Status — each with an ID and its source (`R2 (M3)`,
  `F4 (T8)`), "replaces D1" instead of rewriting.
- Skills and MCP tools used, listed by code from the tool calls.
- Saved as JSON in the checkpoint, rendered to text for the model.

### Records on disk (`records.zig`)

- Every compacted turn → `compacted-M12.txt`, every tool call with its full
  input/output → `compacted-T12.txt`, every folded earlier compaction →
  `compacted-L1.txt`, in the session's tool-results store.
- The agent **opens them with the read tool by handle** ("T12") or **searches**
  them (BM25, ≤ 3 phrases, 5 results). Nothing is lost; the summary points at
  the records.
- From the 2nd compaction on, the previous one is saved whole as L1, L2…
  and one model-written summary (≤ 2,400 bytes) stands in for all of them;
  rules/status still in force stay verbatim.

### The model call (`model.zig`, `ledger.zig`)

- Conversation's own model at its **lowest reasoning** (`none` if allowed).
- On failure/refusal/empty → once more with **another provider family**
  (gateway only).
- Option to send the notes request **right after the cached conversation**
  with the agent's own settings, so the provider reuses its cache.
- Notes only for this compaction's new turns; earlier notes never change.
- Code pre-extracts user sentences that may be rules, so the model files them
  instead of recalling.
- **If the model fails, code writes the turns out instead** — compaction
  still succeeds without a model.

### Verification (`lint.zig`, no model)

- Every turn/tool ID a note names exists; exact values (paths, `code`,
  versions, long numbers) appear in the source turns; a rule quotes the user;
  a note does not call a failed tool call a success.
- Failures stay, marked `[check: …]`, so the agent verifies before relying
  on it.

---

## 6. What we build (in order)

1. **Tool-output masking (microcompaction).** Biggest win: the context grows
   slowly, full compactions get rare and small.
    - Protect the newest ~50k tokens of tool output + the current turn.
    - Mask older outputs only in batches (≥ 30k prunable) so the prompt cache
      isn't busted every turn.
    - Masked output → file under the session dir, stub keeps tool name, a
      head/tail preview and the path (re-readable with `read`).
    - Exempt: todo, ask/question, plan tools. Decide whether `read` is exempt
      (gemini keeps reads; CC masks them and rehydrates instead).
    - Persist as a transcript entry (like `compact`), never rewrite history.
2. **Stream the idle path.** Replace `generateText` with the streamed request.
3. **Summary request: reasoning off/low + a deadline.** (Lowest reasoning: done — `lowestThinkingLevel` in `agent/thinking.ts`, used by `requestSummary`. Deadline still to do.) Don't retry a timeout
   with the same payload — on timeout/overflow shrink (mask/truncate) first.
4. **After a failed summary, truncate instead.** Done (loop + pi): when every
   summary attempt fails (not on abort, not for idle), `runCompact` / `Compact`
   cuts the same span and saves a mechanical record of it (`truncationRecord`:
   `TRUNCATION_PREAMBLE` + earlier summary whole + a rollover record of the
   dropped span), entry marked `truncated: "<error>"`. pi gained a port of
   `rollover.ts` (`agent/rollover.go`).
5. **Reserve compaction headroom** (CC) — trigger early enough that the
   summary request fits; consider real `usage` over chars/4 (pi, gemini).
6. **Rehydrate after the boundary** — re-read the N most recent modified files
   (CC: 5), plus todos (have) and plan state.
7. **From fx:** save compacted tool calls/turns as records on disk and let
   `read`/`history` open them by handle — the summary can be short because
   nothing is unrecoverable. Keep user messages verbatim. Summary call at the
   lowest reasoning. Aim for a large free-up (≤ 20% after) so it doesn't
   refire. Correct chars/4 by the provider's real count.
8. Bigger, later: fx's code-built summary (model writes only notes, lint
   checks them) — compaction then works even with no model reachable.
9. Maybe: reject an inflated result (gemini), cheaper summarizer model option,
   `cacheRetention: "none"` on one-off summaries (pi), persistent compact
   instructions from AGENTS.md (CC).

Open questions:

- Is `read` output masked or exempt?
- Where masked outputs live (session dir vs `~/.loop/tool-outputs`) and their
  lifetime.
- Run masking at turn start only, or also mid-turn between steps?
- Does the summary keep pi's markdown format or move to an XML snapshot?

---

## 7. Done since

- Summary at the model's lowest reasoning, falling back to the session's
  level only on a refused request (loop `lowestThinkingLevel`, pi
  `lowestThinkingLevel`).
- Truncate instead when every summary attempt fails (`truncationRecord`).
- The summarizer is sent the span's **real messages** (tool calls and
  results paired, instructions as the last user message) instead of one
  serialized `<conversation>` block — `agent/summary-messages.ts`, pi
  `agent/summarymessages.go`. Tools the span calls are declared as stubs
  with tool choice `none` (Anthropic refuses tool blocks without them).
- `autoCompactThreshold` defaults to **0.7** (one constant:
  `DEFAULT_AUTO_COMPACT_THRESHOLD`, pi `config.DefaultAutoCompactThreshold`).
  A settings.json that already stores 0.8 keeps it.
