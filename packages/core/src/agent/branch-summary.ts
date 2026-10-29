/**
 * Branch summaries for /tree navigation.
 * core/compaction/branch-summarization. When the user navigates away from a
 * branch, its entries can be summarized into a branch-summary entry that
 * joins the model context at the navigation target.
 */
import { getCatalog, modelInfoIn } from "../catalog";
import type { Session } from "../sessions";
import type { Entry, UsageBlock } from "../types";
import { isAbortError } from "./abort";
import { collectFileLists, formatFileLists } from "./compact";
import type { CostTracker } from "./cost";
import { requestSummary, serializeConversation, serializeMessage, SummaryAbortedError } from "./summarize";
import type { ThinkingLevel } from "./thinking";

export const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Collect the entries abandoned by navigating from oldLeafId to targetId:
 * everything from the old leaf back to (excluding) the deepest common
 * ancestor, in chronological order.
 */
export function collectEntriesForBranchSummary(
    session: Session,
    oldLeafId: string | null,
    targetId: string,
): { entries: Entry[]; commonAncestorId: string | null } {
    if (!oldLeafId) return { entries: [], commonAncestorId: null };

    const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
    const targetPath = session.getBranch(targetId);

    let commonAncestorId: string | null = null;
    for (let i = targetPath.length - 1; i >= 0; i--) {
        if (oldPath.has(targetPath[i].id)) {
            commonAncestorId = targetPath[i].id!;
            break;
        }
    }

    const entries: Entry[] = [];
    let current: string | null = oldLeafId;
    while (current && current !== commonAncestorId) {
        const entry = session.getEntry(current);
        if (!entry) break;
        entries.push(entry);
        current = entry.parentId ?? null;
    }
    entries.reverse();
    return { entries, commonAncestorId };
}

/** pi's reserve: room for the prompt and the summary in the summarizer's window. */
const BRANCH_RESERVE_TOKENS = 16_384;

/**
 * An entry as the summarizer reads it. Tool results are left out (pi's
 * choice for branches): the calls say what was done, and the outputs are
 * what makes a long branch too big to send.
 */
function branchEntryMessage(e: Entry): { role: string; content: unknown } | null {
    switch (e.type) {
        case "message":
            return e.role === "tool" ? null : { role: e.role, content: e.content };
        case "subagent":
            return { role: "user", content: `[subagent ${e.agent} report] ${e.result}` };
        case "compact":
            // A rollover has no summary; its handoff is the record of the window.
            return {
                role: "user",
                content:
                    e.rollover || e.handoff
                        ? `[context rollover] ${e.handoff ?? ""}`
                        : `[compaction summary] ${e.summary}`,
            };
        case "branch-summary":
            return { role: "user", content: `[branch summary] ${e.summary}` };
        default:
            return null;
    }
}

export class BranchSummaryAbortedError extends Error {
    constructor() {
        super("branch summary aborted");
        this.name = "BranchSummaryAbortedError";
    }
}

/**
 * Summarize an abandoned branch's entries for a branch-summary entry, on the
 * session's own model (see summarize.ts). Newest entries win when the branch
 * is bigger than the window. When a tracker is passed the summarization call
 * is billed (source "branch-summary"); the returned usage should be stamped
 * onto the entry the caller appends.
 */
export async function runBranchSummary(opts: {
    entries: Entry[];
    modelId: string;
    abortSignal?: AbortSignal;
    customInstructions?: string;
    tracker?: CostTracker;
    sessionPub?: string;
    cwd?: string;
    thinkingLevel?: ThinkingLevel;
}): Promise<{ text: string; usage?: UsageBlock }> {
    const contextWindow = modelInfoIn(await getCatalog(), opts.modelId)?.contextWindow ?? 128_000;
    const budget = Math.max(contextWindow - BRANCH_RESERVE_TOKENS, 4_000);
    const kept: Array<{ role: string; content: unknown }> = [];
    let tokens = 0;
    for (let i = opts.entries.length - 1; i >= 0; i--) {
        const message = branchEntryMessage(opts.entries[i]);
        if (!message) continue;
        const size = Math.ceil(serializeMessage(message).length / 4);
        if (tokens + size > budget) break;
        kept.unshift(message);
        tokens += size;
    }
    const files = collectFileLists(kept);
    if (kept.length === 0) return { text: "No content to summarize" };

    const instructions = opts.customInstructions
        ? `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${opts.customInstructions}`
        : BRANCH_SUMMARY_PROMPT;
    try {
        const result = await requestSummary({
            modelId: opts.modelId,
            messages: [
                {
                    role: "user",
                    content: `<conversation>\n${serializeConversation(kept)}\n</conversation>\n\n${instructions}`,
                },
            ],
            abortSignal: opts.abortSignal,
            ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
            onUsage: (usage) =>
                opts.tracker?.add(opts.modelId, usage, {
                    cwd: opts.cwd,
                    sessionPub: opts.sessionPub,
                    source: "branch-summary",
                }),
        });
        return { text: result.text + formatFileLists(files), ...(result.usage ? { usage: result.usage } : {}) };
    } catch (err) {
        if (err instanceof SummaryAbortedError || isAbortError(err) || opts.abortSignal?.aborted) {
            throw new BranchSummaryAbortedError();
        }
        throw err;
    }
}
