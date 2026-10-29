import { getCatalog, modelInfoIn } from "../catalog";
import { attachLedgerEntry, type Session } from "../sessions";
import { formatTodoList, hasActiveTodos, isTodosPayload, type TodoItem } from "../tools/todo";
import { isAbortError } from "./abort";
import { BRANCH_SUMMARY_PREAMBLE } from "./branch-summary";
import { stampUsageCost, sumUsage, type CostTracker } from "./cost";
import { isContextOverflowError } from "./retry";
import type { ModelMessage } from "ai";
import { requestSummary, SummaryAbortedError } from "./summarize";
import { chunkMessages, toSummaryMessages } from "./summary-messages";
import type { ThinkingLevel } from "./thinking";
import { buildRolloverHandoff, MAX_HANDOFF_CHARS } from "./rollover";
import type { Entry, UsageBlock } from "../types";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/**
 * Opens a rollover's replacement block. A rollover starts a fresh window with
 * no summary at all, so the model is told three things it cannot infer: the
 * earlier conversation is recoverable rather than lost, the record below is
 * inputs and not progress, and live state must be re-checked before acting on
 * it. Kept next to the summary constants because both are read by
 * compactedContextEntries and measured by estimateContextTokens.
 */
export const ROLLOVER_PREAMBLE = `A fresh context window starts here. The conversation before this point left your active context WITHOUT a summary. It is intact in this session and recoverable with the history tool.

What follows is a recovery record of inputs and state — NOT a record of progress. The previous window may already have finished some or all of its work. Restore the todo list, read the notes it names, and verify live state before continuing any stateful or external work.

<handoff>`;
export const ROLLOVER_SUFFIX = `
</handoff>`;

/** The replacement block a compaction or rollover puts at the head of the window. */
export function compactionBlockText(entry: { summary: string; handoff?: string }): string {
    return entry.handoff
        ? `${ROLLOVER_PREAMBLE}\n${entry.handoff}${ROLLOVER_SUFFIX}`
        : `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`;
}

/** Body text for display surfaces — the handoff on a rollover, else the summary. */
export function compactionBodyText(entry: { summary: string; handoff?: string }): string {
    return entry.handoff ?? entry.summary;
}

/**
 * pi's checkpoint prompts (core/compaction/compaction.ts), word for word. The
 * conversation reaches the summarizer as text inside <conversation>, not as
 * turns, so it reads it rather than continuing it.
 */
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * When the kept window opens inside a request, the start of that request is
 * summarized on its own (pi's split turn), so the summary says what was asked
 * even though the kept steps never show the user's message.
 */
const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

/**
 * How much recent conversation a compaction keeps word for word. The summary
 * replaces everything before it. Capped to a quarter of a small window, where
 * 20k would leave the summary little to free.
 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const KEEP_RECENT_WINDOW_SHARE = 0.25;

const READ_TOOLS = new Set(["read"]);
const MODIFY_TOOLS = new Set(["edit", "write"]);

export interface CompactionFileLists {
    readFiles: string[];
    modifiedFiles: string[];
}

/**
 * Files the summarized messages read and changed, taken from the tool calls
 * themselves rather than trusted to the model's memory, and carried across
 * compactions so the list covers the whole session.
 */
export function collectFileLists(
    messages: ReadonlyArray<{ role: string; content: unknown }>,
    previous?: CompactionFileLists,
): CompactionFileLists {
    const read = new Set(previous?.readFiles ?? []);
    const modified = new Set(previous?.modifiedFiles ?? []);
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const part of message.content as Array<{ type?: string; toolName?: string; input?: { path?: unknown } }>) {
            if (part.type !== "tool-call" || typeof part.input?.path !== "string") continue;
            const path = part.input.path;
            if (MODIFY_TOOLS.has(part.toolName ?? "")) modified.add(path);
            // A URL or loop:// read is not a file anyone will edit.
            else if (READ_TOOLS.has(part.toolName ?? "") && !path.includes("://")) read.add(path);
        }
    }
    return { readFiles: [...read].filter((f) => !modified.has(f)).sort(), modifiedFiles: [...modified].sort() };
}

export function formatFileLists(files: CompactionFileLists): string {
    let out = "";
    if (files.readFiles.length > 0) out += `\n\n<read-files>\n${files.readFiles.join("\n")}\n</read-files>`;
    if (files.modifiedFiles.length > 0)
        out += `\n\n<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`;
    return out;
}

/** The previous summary without its file lists — those are rebuilt, not re-summarized. */
function withoutFileLists(summary: string): string {
    return summary.replace(/\n*<(read|modified)-files>[\s\S]*?<\/\1-files>/g, "").trimEnd();
}

/**
 * Opens the record a compaction saves when its summary could not be written.
 * It sits inside the usual summary block, so it says plainly that it is not
 * one: what follows is the user's own words and the work's externalized
 * state, taken from the transcript, and nothing in it claims progress.
 */
export const TRUNCATION_PREAMBLE = `The summary of the conversation before this point could not be written, so the conversation was truncated instead. What follows is a record built from the transcript — inputs and state, NOT a record of progress. Check live state (files on disk, the todo list) before continuing any work it mentions.`;

/**
 * The fallback when every summary attempt failed: drop the same span a
 * summary would have replaced, keep a mechanical record of it. No model call,
 * so it cannot fail the way the summary just did — a session too big to
 * summarize still gets smaller instead of failing at every turn until it no
 * longer fits at all.
 *
 * The record is a rollover's (agent/rollover.ts) over the dropped span alone:
 * every user message, the files touched, the commands run. An earlier
 * summary is carried whole — it is already the only memory of what came
 * before it. The todo list is re-injected on its own (compactedContextEntries).
 */
function truncationRecord(
    dropped: ReadonlyArray<{ role: "user" | "assistant" | "tool"; content: unknown }>,
    previousBody: string,
): string {
    const entries = dropped.map((m) => ({ type: "message", role: m.role, content: m.content, ts: 0 }) as Entry);
    const record = buildRolloverHandoff(entries, { limit: MAX_HANDOFF_CHARS });
    let text = TRUNCATION_PREAMBLE;
    if (previousBody) text += `\n\n## Summary from an earlier compaction\n${previousBody}`;
    text += `\n\n${record ?? "(nothing in the truncated part could be carried over)"}`;
    return text;
}

export interface CompactResult {
    summary: string;
    cutAt: number;
    tokensBefore: number;
    tokensAfter: number;
    /** The summary failed with this error, so the span was truncated instead
     * (truncationRecord) — `summary` is that record. */
    truncated?: string;
}

/** A message's weight in context, on the same chars/4 scale as the context estimate. */
function messageTokens(message: { content: unknown }): number {
    return estimateTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
}

function estimateTokens(text: string): number {
    // crude 4 chars/token
    return Math.ceil(text.length / 4);
}

/**
 * How much conversation one summarizer request may carry. A share of the
 * model's window (grok-build's "always fits" lossy budget is the same 70%),
 * leaving room for the prompt and the summary itself — and a ceiling on top,
 * because gateways cap request BODIES long before a 1M-token window is full.
 */
const SUMMARY_INPUT_WINDOW_SHARE = 0.7;
const SUMMARY_INPUT_MAX_CHARS = 800_000;
/** Floor for a model with no catalog entry, or a window too small to share. */
const SUMMARY_INPUT_MIN_CHARS = 16_000;
/** Halvings of the chunk budget after the provider says the request is too big. */
const MAX_OVERFLOW_RETRIES = 3;

export function summaryInputBudgetChars(contextWindow: number | undefined): number {
    if (!contextWindow) return SUMMARY_INPUT_MIN_CHARS;
    const share = Math.floor(contextWindow * SUMMARY_INPUT_WINDOW_SHARE) * 4;
    return Math.max(SUMMARY_INPUT_MIN_CHARS, Math.min(SUMMARY_INPUT_MAX_CHARS, share));
}

export function latestCompactEntry(session: Session) {
    return latestCompact(session);
}

function latestCompact(session: Session) {
    // Path-based: a compaction on an abandoned branch must not apply after
    // /tree navigation moved the leaf elsewhere.
    let latest:
        | {
              summary: string;
              cutAt: number;
              ts: number;
              tokensBefore: number;
              tokensAfter: number;
              handoff?: string;
              rollover?: true;
              details?: CompactionFileLists;
          }
        | undefined;
    for (const entry of session.getBranch()) {
        if (entry.type === "compact") latest = entry;
    }
    return latest;
}

function messageToText(message: { role: "user" | "assistant" | "tool"; content: unknown }): string {
    return `[${message.role}] ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`;
}

export type ContextEntry =
    | { kind: "message"; role: "user" | "assistant" | "tool"; content: unknown; interrupted?: boolean }
    | { kind: "subagent"; agent: string; result: string };

/**
 * The model's view of the session: the latest compaction's summary, then
 * what it kept, with subagent entries interleaved in chronological order so
 * resumed sessions retain subagent reports in the model context. The compact cutAt counts only message entries — subagent
 * entries ride along with the messages that survive the cut.
 *
 * Walks the current branch path (leaf → root), not the whole file, so
 * abandoned branches stay out of the context after /tree navigation.
 * Branch-summary entries on the path join the context as user messages.
 */
export function compactedContextEntries(session: Session): ContextEntry[] {
    const compact = latestCompact(session);
    const out: ContextEntry[] = [];
    let messageIndex = 0;
    // Todo survival: a checklist whose last write fell into the summarized
    // region would otherwise vanish from the model's context (the panel keeps
    // showing it, but the model no longer knows it exists). Track the latest
    // pre-cut list; a post-cut write supersedes it (its tool call/result
    // survives in the kept messages, so no re-injection needed).
    let preCutTodos: TodoItem[] | null = null;
    for (const e of session.getBranch()) {
        if (e.type === "message") {
            const idx = messageIndex++;
            if (compact && idx < compact.cutAt) continue;
            out.push({ kind: "message", role: e.role, content: e.content, interrupted: e.interrupted });
        } else if (e.type === "subagent") {
            if (compact && messageIndex < compact.cutAt) continue;
            out.push({ kind: "subagent", agent: e.agent, result: e.result });
        } else if (e.type === "branch-summary" && e.summary) {
            if (compact && messageIndex < compact.cutAt) continue;
            out.push({ kind: "message", role: "user", content: `${BRANCH_SUMMARY_PREAMBLE}${e.summary}` });
        } else if (e.type === "custom" && compact && isTodosPayload(e.payload)) {
            preCutTodos = messageIndex < compact.cutAt ? e.payload.items : null;
        }
    }
    if (compact) {
        if (preCutTodos && hasActiveTodos(preCutTodos)) {
            // Load-bearing under a rollover: with no summary to carry state, the
            // checklist is the main thing that survives the boundary.
            const where = compact.handoff ? "the context rollover above" : "the compaction above";
            out.unshift({
                kind: "message",
                role: "user",
                content:
                    `Your todo checklist was active before ${where}. Current list:\n` +
                    `${formatTodoList(preCutTodos)}\n` +
                    "Keep maintaining it with the todo tool — resend the full list, updated, as you make progress.",
            });
        }
        out.unshift({ kind: "message", role: "user", content: compactionBlockText(compact) });
    }
    return out;
}

/**
 * One summarizer request: an opening user message (carrying the summary so
 * far, when there is one), the span's own messages, the instructions, and —
 * when the user gave any with `/compact <instructions>` — theirs, as one more
 * user message. The opening message also means the request never starts on
 * an assistant turn, which some providers refuse.
 */
function summaryRequest(
    span: ModelMessage[],
    instructions: string,
    { previousSummary = "", focus = "" }: { previousSummary?: string; focus?: string } = {},
): ModelMessage[] {
    const opening = previousSummary
        ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\nThe conversation to fold into it follows.`
        : "The conversation to summarize follows.";
    const messages: ModelMessage[] = [
        { role: "user", content: opening },
        ...span,
        { role: "user", content: instructions },
    ];
    if (focus) messages.push({ role: "user", content: `Additional instructions for this summary: ${focus}` });
    return messages;
}

export class CompactAbortedError extends Error {
    constructor() {
        super("compact aborted");
        this.name = "CompactAbortedError";
    }
}

/**
 * Where the kept window starts: walk back from the end until
 * `keepRecentTokens` of conversation is kept. The window may open on a user
 * or an assistant message but never on a tool result, whose tool call would
 * be summarized away (Anthropic 400s on the orphan) — so a cut that lands on
 * one walks back to the assistant message carrying the calls, keeping a
 * little more rather than breaking the pair.
 */
export function findCutPoint(
    messages: ReadonlyArray<{ role: string; content: unknown }>,
    previousCut: number,
    keepRecentTokens: number,
): number {
    let cut = messages.length;
    let kept = 0;
    while (cut > previousCut && kept < keepRecentTokens) {
        cut--;
        kept += messageTokens(messages[cut]);
    }
    while (cut > previousCut && messages[cut]?.role === "tool") cut--;
    return cut;
}

export async function runCompact(opts: {
    session: Session;
    modelId: string;
    /** Recent conversation kept word for word; see DEFAULT_KEEP_RECENT_TOKENS. */
    keepRecentTokens?: number;
    /**
     * An explicit /compact: when the kept window would swallow everything
     * there is, summarize everything rather than report there is nothing to do.
     */
    manual?: boolean;
    /**
     * The user's own instructions for this summary (`/compact <instructions>`),
     * sent as their own user message after the standing instructions — the
     * way they were written, not folded into the prompt.
     */
    focus?: string;
    abortSignal?: AbortSignal;
    /** Bills the summarization call (source "compact") — real API spend that
     * historically went unrecorded. */
    tracker?: CostTracker;
    cwd?: string;
    /** Sizes the summarizer's requests; looked up in the catalog when omitted. */
    contextWindow?: number;
    /** The session's reasoning level. The summary runs at the model's lowest
     * (lowestThinkingLevel); this is only its fallback when that is refused. */
    thinkingLevel?: ThinkingLevel;
    /**
     * Write the summary another way: idle compaction's single request over
     * the conversation exactly as the provider has it cached (agent/
     * idle-compact.ts). Replaces the text summarizer; where the cut falls,
     * the file lists and the saved entry are the same either way.
     */
    summarize?: () => Promise<{ text: string; usage?: UsageBlock; finishReason?: string }>;
    /** Recorded on the entry: what started this compaction. */
    trigger?: "idle";
}): Promise<CompactResult> {
    const messages = opts.session.messages();
    const previousCompact = latestCompact(opts.session);
    const previousCut = previousCompact?.cutAt ?? 0;
    const contextWindow = opts.contextWindow ?? modelInfoIn(await getCatalog(), opts.modelId)?.contextWindow;
    const keep =
        opts.keepRecentTokens ??
        (contextWindow
            ? Math.min(DEFAULT_KEEP_RECENT_TOKENS, Math.floor(contextWindow * KEEP_RECENT_WINDOW_SHARE))
            : DEFAULT_KEEP_RECENT_TOKENS);
    let cut = findCutPoint(messages, previousCut, keep);
    if (cut <= previousCut && opts.manual) cut = findCutPoint(messages, previousCut, 0);
    if (cut <= previousCut) {
        return { summary: "", cutAt: 0, tokensBefore: 0, tokensAfter: 0 };
    }

    if (opts.abortSignal?.aborted) throw new CompactAbortedError();

    const head = messages.slice(previousCut, cut);
    const previousBody = previousCompact ? withoutFileLists(compactionBodyText(previousCompact)) : "";
    const previousSummary = previousBody
        ? `${COMPACTION_SUMMARY_PREFIX}${previousBody}${COMPACTION_SUMMARY_SUFFIX}\n`
        : "";
    const fullContextText = previousSummary + messages.slice(previousCut).map(messageToText).join("\n");
    const tokensBefore = estimateTokens(fullContextText);

    // pi's split turn: a kept window that opens inside a request (on an
    // assistant step) would leave the summary without the user's message. The
    // start of that request is summarized on its own, beside the history.
    let turnStart = -1;
    if (cut < messages.length && messages[cut]?.role !== "user") {
        for (let i = cut - 1; i >= previousCut; i--) {
            if (messages[i].role === "user") {
                turnStart = i;
                break;
            }
        }
    }
    const history = turnStart >= 0 ? messages.slice(previousCut, turnStart) : head;
    const turnPrefix = turnStart >= 0 ? messages.slice(turnStart, cut) : [];

    let usage: UsageBlock | undefined;
    const bill = (u: UsageBlock) => {
        usage = sumUsage(usage, u);
        opts.tracker?.add(opts.modelId, u, {
            cwd: opts.cwd ?? opts.session.info.cwd,
            sessionPub: opts.session.info.id,
            source: "compact",
        });
    };
    const focus = opts.focus?.trim() ?? "";
    const request = async (messages: ModelMessage[]) =>
        (
            await requestSummary({
                modelId: opts.modelId,
                messages,
                abortSignal: opts.abortSignal,
                ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
                onUsage: bill,
            })
        ).text;

    /**
     * The history, folded into the previous summary. Nearly always one
     * request; a history bigger than one request is summarized as a rolling
     * summary, each chunk folded into the summary so far.
     */
    const summarizeHistory = async (budget: number): Promise<string> => {
        let running = previousBody;
        const messages = toSummaryMessages(history);
        if (messages.length === 0) return running || "No prior history.";
        for (const chunk of chunkMessages(messages, Math.max(SUMMARY_INPUT_MIN_CHARS / 2, budget - running.length))) {
            const instructions = running ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
            running = await request(summaryRequest(chunk, instructions, { previousSummary: running, focus }));
        }
        return running;
    };
    const summarizeTurnPrefix = async (budget: number): Promise<string> => {
        const [chunk] = chunkMessages(toSummaryMessages(turnPrefix), budget);
        return request(summaryRequest(chunk ?? [], TURN_PREFIX_SUMMARIZATION_PROMPT, { focus }));
    };

    let text = "";
    let truncated: string | undefined;
    try {
        if (opts.summarize) {
            const result = await opts.summarize();
            if (result.usage) bill(result.usage);
            if (result.finishReason === "length")
                throw new Error("the summary hit the output limit before it finished");
            if (!result.text.trim()) throw new Error("the model returned an empty summary");
            text = result.text.trim();
        } else {
            let budget = summaryInputBudgetChars(contextWindow);
            for (let retry = 0; ; retry++) {
                try {
                    // Independent requests: run side by side, so a split turn
                    // costs no more wall time than one summary.
                    const [historyText, prefixText] = await Promise.all([
                        summarizeHistory(budget),
                        turnPrefix.length > 0 ? summarizeTurnPrefix(budget) : Promise.resolve(""),
                    ]);
                    text = prefixText
                        ? `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixText}`
                        : historyText;
                    break;
                } catch (err) {
                    // Our window numbers are estimates and a gateway's body limit is
                    // invisible until it refuses: step the chunk size down instead of
                    // leaving the session stuck too big to compact.
                    if (err instanceof SummaryAbortedError || !isContextOverflowError(err)) throw err;
                    if (retry >= MAX_OVERFLOW_RETRIES) throw err;
                    budget = Math.floor(budget / 2);
                }
            }
        }
    } catch (err) {
        if (err instanceof SummaryAbortedError || isAbortError(err) || opts.abortSignal?.aborted) {
            throw new CompactAbortedError();
        }
        // Idle compaction has nobody waiting on it, and the next turn compacts
        // properly if it must: a failure there is reported, never truncated.
        if (opts.summarize) throw err;
        truncated = err instanceof Error ? err.message : String(err);
        text = truncationRecord(head, previousBody);
    }

    if (opts.abortSignal?.aborted) throw new CompactAbortedError();
    const files = collectFileLists(head, previousCompact?.details);
    text += formatFileLists(files);
    // What the next request carries: the summary plus the window it kept.
    const tokensAfter = estimateTokens(text) + messages.slice(cut).reduce((sum, m) => sum + messageTokens(m), 0);
    const entry = {
        type: "compact" as const,
        ts: Date.now(),
        summary: text,
        cutAt: cut,
        tokensBefore,
        tokensAfter,
        details: files,
        ...(opts.trigger ? { trigger: opts.trigger } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
        ...(usage ? { usage: stampUsageCost(opts.modelId, usage), model: opts.modelId } : {}),
    };
    await opts.session.append(entry);
    const rowId = opts.tracker?.takeLastLedgerRowId();
    const entryId = (entry as { id?: string }).id;
    if (rowId !== undefined && entryId) attachLedgerEntry(rowId, entryId);
    return { summary: text, cutAt: cut, tokensBefore, tokensAfter, ...(truncated !== undefined ? { truncated } : {}) };
}
