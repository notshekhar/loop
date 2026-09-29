/**
 * Relay — context windows without summaries.
 *
 * At the threshold, loop normally spends a full model call summarizing the
 * conversation, at the moment context is fullest. Relay starts a fresh window
 * instead and carries a mechanically-built recovery record across the
 * boundary: free, deterministic, cannot hallucinate, and works when no
 * summarizer model is reachable. The old conversation stays in the session and
 * is reachable with the `history` tool.
 *
 * Named for the relay station where a courier swapped to a fresh post-horse —
 * same journey, new legs. The design follows Codex's native `new_context` /
 * `get_context_remaining` model, which pi-posthorse ports onto a fork of Pi;
 * see docs/relay-context-windows.md.
 *
 * What Relay adds over that prior art is automatic capture: the record carries
 * the live todo list, the files this window touched, and the commands it ran,
 * all derived from the transcript. Posthorse leaves all of that to the model
 * remembering to write notes, which is the reason it degrades where Codex's
 * memory pipeline does not.
 */
import { z } from "zod";
import { tool } from "ai";
import type { ExtensionAPI } from "../../api";
import { getSetting } from "../../../settings";
import { buildRolloverHandoff, MAX_HANDOFF_CHARS, MIN_USABLE_TOKENS } from "../../../agent/rollover";
import { compactionBodyText } from "../../../agent/compact";
import type { Entry } from "../../../types";

/** Remind inside the last 10% of usable context, never more than this. */
const REMINDER_BAND_TOKENS = 32_000;
const MIN_PAGE_CHARS = 1_000;
const PAGE_MARGIN_TOKENS = 1_000;

interface RelaySettings {
    mode: "auto" | "rollover" | "off";
    reminder: boolean;
    carryCommands: boolean;
}

export default {
    activate(api: ExtensionAPI) {
        const cfg = (): RelaySettings => ({
            mode: api.settings.getOwn("mode", "auto") as RelaySettings["mode"],
            reminder: api.settings.getOwn("reminder", true) as boolean,
            carryCommands: api.settings.getOwn("carryCommands", true) as boolean,
        });

        api.extension.setStatus(() => {
            const b = api.context.read();
            const mode = cfg().mode;
            if (mode === "off") return "off";
            if (!b) return mode;
            return b.supported ? `${mode} · ${Math.max(0, b.rolloverAt - b.used).toLocaleString("en-US")} left` : "unsupported window";
        });

        /** Characters a page may safely add without re-tripping the threshold. */
        const pageLimit = (offset: number): number => {
            const b = api.context.read();
            if (!b) return MIN_PAGE_CHARS * 4;
            const room = Math.max(0, b.rolloverAt - b.used - PAGE_MARGIN_TOKENS) * 4;
            const chars = Math.min(MAX_HANDOFF_CHARS, room);
            if (chars < MIN_PAGE_CHARS) {
                throw new Error(
                    `Too little context remains to read this safely. Call new_context first, then retry with offset ${offset}.`,
                );
            }
            return chars;
        };

        // ---- the policy -----------------------------------------------------
        api.context.registerPolicy({
            name: "relay",
            decide(input) {
                if (cfg().mode === "off") return { kind: "summarize" };
                // Rollover has no natural floor: cutAt advances every turn, so a
                // window that cannot fit a handoff would roll over on EVERY
                // turn, discarding each one as it completes. Summarization
                // no-ops in this case; rollover has to be told to.
                const usable = input.thresholdTokens - input.overheadTokens;
                if (usable < MIN_USABLE_TOKENS) return { kind: "summarize" };

                const branch = input.session.getBranch() as Entry[];
                const handoff = buildRolloverHandoff(branch, {
                    limit: Math.floor((usable * 4) / 2),
                    carryCommands: cfg().carryCommands,
                });
                // Nothing safe to carry — leave the turn to the summarizer
                // rather than drop a window for nothing. Codex ships the same
                // fallback (auto_compact_fallback_prompt).
                if (!handoff) return { kind: "summarize" };

                // Before the first step, the user's message for THIS turn is
                // already appended and cutting at messages.length would throw
                // away the request they just typed. Between steps, or after the
                // provider refused a request for its size, the whole window
                // rolls: the handoff carries the finished tool results and the
                // user's requests with them.
                const messageCount = input.session.messages().length;
                const cutAt = input.reason === "threshold" ? Math.max(0, messageCount - 1) : messageCount;
                return { kind: "rollover", handoff, cutAt };
            },
        });

        // ---- guidance + the one reminder ------------------------------------
        api.turn.use({
            onSystemPrompt(prompt) {
                if (cfg().mode === "off") return;
                // Static on purpose: a live meter here would churn the prompt
                // prefix every turn and cost more cache than it saves.
                return `${prompt}

## Context windows (Relay)

This session rolls over to a fresh context window instead of summarizing. When it does, this conversation leaves your active context without a summary. It stays in the session and you can reach it with the history tool.

Durable state must live outside the conversation. Keep the todo list current, and write anything larger to .loop/notes/ with your write tool — a rollover carries your inputs, todos, files touched and commands run, but nothing you only reasoned about.

Call new_context when you finish a phase of work and the next phase does not need this conversation. Call get_context_remaining only when the budget actually matters.

At most one checkpoint reminder arrives before the automatic rollover line. It is best-effort: a single large turn can reach the line without one.`;
            },

            onAdditionalContext(ctx) {
                if (!cfg().reminder || cfg().mode === "off") return;
                const b = api.context.read();
                if (!b?.supported || ctx.contextUsed === undefined) return;
                const usable = b.rolloverAt;
                const band = Math.min(REMINDER_BAND_TOKENS, Math.floor(usable * 0.1));
                if (ctx.contextUsed < b.rolloverAt - band || ctx.contextUsed >= b.rolloverAt) return;
                // Fingerprinted on the window AND the budget: switching models
                // changes contextWindow, which should earn a fresh reminder
                // rather than reuse one computed for a different size.
                const fp = `${ctx.sessionId}:${b.window}:${b.rolloverAt}`;
                if (remindedFor === fp) return;
                remindedFor = fp;
                return `[relay] Checkpoint now: about ${(b.rolloverAt - ctx.contextUsed).toLocaleString("en-US")} tokens remain before this context window rolls over. Save goal, progress, decisions and next steps — update the todo list, and write anything larger to .loop/notes/ — then continue. This reminder is best-effort and will not repeat for this window.`;
            },
        });
        let remindedFor: string | undefined;

        // ---- tools ----------------------------------------------------------
        api.tools.add(
            "new_context",
            tool({
                description:
                    "Start a genuinely fresh context window. The current conversation leaves your active context without a summary and stays recoverable through the history tool. Takes effect after this turn completes, not mid-reply. Pass concise continuation state in handoff, or save richer state to .loop/notes/ first.",
                inputSchema: z.object({
                    handoff: z
                        .string()
                        .max(MAX_HANDOFF_CHARS)
                        .optional()
                        .describe("Concise state the fresh window needs to continue correctly"),
                }),
                async execute({ handoff }) {
                    api.context.requestBoundary(handoff);
                    return (
                        "A fresh context window will start when this turn finishes. " +
                        (handoff
                            ? "Your handoff will open it."
                            : "A recovery record will be built from this window's inputs, todos, files and commands.") +
                        " Earlier conversation stays in the session; reach it with history."
                    );
                },
            }),
        );

        api.tools.add(
            "get_context_remaining",
            tool({
                description:
                    "Tokens remaining before this context window rolls over, and before the model's hard limit. Estimated until the provider reports usage.",
                inputSchema: z.object({}),
                async execute() {
                    const b = api.context.read();
                    if (!b) return "Context usage is not known yet — it is measured once this turn's request is assembled.";
                    const n = (v: number) => Math.max(0, v).toLocaleString("en-US");
                    if (!b.supported) {
                        return `Unsupported window: ${n(b.window)} tokens minus overhead leaves less than ${n(MIN_USABLE_TOKENS)} usable, so Relay leaves compaction to loop. ≈${n(b.window - b.used)} tokens until the hard limit.`;
                    }
                    return `≈${n(b.rolloverAt - b.used)} tokens until this window rolls over (line at ${n(b.rolloverAt)}); ≈${n(b.window - b.used)} until the hard limit (${n(b.used)}/${n(b.window)} used). Estimates.`;
                },
            }),
        );

        api.tools.add(
            "history",
            tool({
                description:
                    "Search or read earlier conversation, including windows that have rolled out of context. Search first, then read the entry id it returns. Results are paged against the remaining budget.",
                inputSchema: z.object({
                    op: z.enum(["search", "read"]),
                    query: z.string().optional().describe("Case-insensitive text to find (search)"),
                    id: z.string().optional().describe("Entry id from a search result (read)"),
                    limit: z.number().int().min(1).max(50).optional(),
                    offset: z.number().int().min(0).optional().describe("Character offset (read)"),
                }),
                async execute(params) {
                    const branch = api.context.branch();
                    if (!branch.length) return "History is unavailable outside a running turn.";
                    const flat = branch.map((e) => ({ id: e.id ?? "", text: flatten(e), entry: e })).filter((r) => r.text && r.id);

                    if (params.op === "search") {
                        const q = (params.query ?? "").toLowerCase();
                        if (!q) return 'A "query" is required for op "search".';
                        const limit = params.limit ?? 10;
                        // Two buckets, originals first: without this the tool
                        // drowns in its own echoes — handoffs, summaries and
                        // previous history results all quote what you searched.
                        const buckets: string[][] = [[], []];
                        for (let i = flat.length - 1; i >= 0; i--) {
                            const r = flat[i];
                            const at = r.text.toLowerCase().indexOf(q);
                            if (at === -1) continue;
                            const recovery = r.entry.type === "compact" || r.entry.type === "branch-summary";
                            const b = buckets[recovery ? 1 : 0];
                            if (b.length >= limit) continue;
                            b.push(`[${r.id}] ${excerptAround(r.text, at, 100, 400)}`);
                        }
                        const hits = [...buckets[0], ...buckets[1]].slice(0, limit);
                        return hits.length ? hits.join("\n\n") : `No history matches "${params.query}".`;
                    }

                    const id = params.id;
                    if (!id) return 'An "id" is required for op "read".';
                    const row = flat.find((r) => r.id === id);
                    if (!row) return `No history entry with id "${id}".`;
                    const offset = params.offset ?? 0;
                    if (offset >= row.text.length) return `Offset ${offset} is past the end of entry "${id}".`;
                    const end = Math.min(row.text.length, offset + pageLimit(offset));
                    const more = end < row.text.length ? `\n\n[chars ${offset}-${end} of ${row.text.length}; continue with offset ${end}]` : "";
                    return `${row.text.slice(offset, end)}${more}`;
                },
            }),
        );

        // ---- /relay ---------------------------------------------------------
        api.commands.register({
            name: "relay",
            description: "Context rollover: /relay auto|rollover|off (no arg shows the budget)",
            handler: (ctx, args) => {
                const arg = args.trim().toLowerCase();
                if (!arg || arg === "status") {
                    const b = api.context.read();
                    const threshold = getSetting("autoCompactThreshold") ?? 0.8;
                    if (!b) {
                        ctx.emit("help", `relay: ${cfg().mode} — budget unknown until the next turn is assembled.`);
                        return;
                    }
                    const n = (v: number) => Math.max(0, v).toLocaleString("en-US");
                    ctx.emit(
                        "help",
                        `relay: ${cfg().mode}${b.supported ? "" : " (window too small — loop's compaction stays in charge)"}\n` +
                            `context ${n(b.used)}/${n(b.window)} · rolls over at ${n(b.rolloverAt)} (${Math.round(threshold * 100)}%) · ≈${n(b.rolloverAt - b.used)} left\n` +
                            `reminder ${cfg().reminder ? "on" : "off"} · commands in handoff ${cfg().carryCommands ? "on" : "off"}`,
                    );
                    return;
                }
                if (arg !== "auto" && arg !== "rollover" && arg !== "off") {
                    ctx.emit("error", `unknown relay mode "${arg}". options: auto | rollover | off`);
                    return;
                }
                api.settings.setOwn("mode", arg);
                ctx.emit(
                    "help",
                    arg === "off"
                        ? "relay off — loop summarizes at the threshold as usual."
                        : `relay ${arg} — fresh windows, no summaries.`,
                );
            },
        });
    },
};

function excerptAround(text: string, index: number, before: number, length: number): string {
    const start = Math.max(0, index - before);
    const end = Math.min(text.length, start + length);
    return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function flatten(e: Entry): string {
    if (e.type === "message") {
        const c = e.content;
        const text =
            typeof c === "string"
                ? c
                : Array.isArray(c)
                  ? c
                        .map((p) => {
                            const b = p as { type?: string; text?: string; toolName?: string; input?: unknown };
                            if (b.type === "text") return b.text ?? "";
                            if (b.type === "tool-call") return `${b.toolName ?? "tool"} ${JSON.stringify(b.input ?? {})}`;
                            if (b.type === "tool-result") return JSON.stringify(b.input ?? "");
                            return "";
                        })
                        .filter(Boolean)
                        .join("\n")
                  : "";
        return text ? `[${e.role}] ${text}` : "";
    }
    if (e.type === "compact") return `[${e.rollover ? "rollover" : "compaction"}] ${compactionBodyText(e)}`;
    if (e.type === "branch-summary") return `[branch summary] ${e.summary}`;
    if (e.type === "subagent") return `[subagent ${e.agent}] ${e.result}`;
    return "";
}
