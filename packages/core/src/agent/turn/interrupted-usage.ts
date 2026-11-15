import { estimateContextTokens } from "../model-messages";
import type { Session } from "../../sessions";
import type { UsageBlock } from "../../types";

/** Most recent provider-reported (non-estimated) usage in the transcript — the
 * input/cache profile to anchor an interrupted-step estimate to when the
 * current turn has no finished step yet (an interrupt on the very first step). */
export function lastUsageInSession(session: Session): UsageBlock | undefined {
    const all = session.entries();
    for (let i = all.length - 1; i >= 0; i--) {
        const e = all[i];
        if (e.type === "message" && e.role === "assistant" && e.usage && !e.usage.estimated) return e.usage;
        if (e.type === "subagent" && e.usage && !e.usage.estimated) return e.usage;
    }
    return undefined;
}

/**
 * Estimate usage for the in-flight request of an interrupted turn. The AI SDK
 * records a step only on its `finish-step` chunk and reports no usage on abort
 * (vercel/ai#7805), so the cut-off round-trip has no provider numbers — yet the
 * provider billed it (input + the output streamed before the cut).
 *
 * Output is the only estimated part: the partial text + reasoning at chars/4
 * (loop's house heuristic; small, since an interrupt lands early). Input — the
 * expensive, cache-split-sensitive part — is NOT guessed: it's taken from the
 * adjacent real step (`basis`), since the interrupted request resent
 * essentially the same context, so its input count and cache-read/write split
 * match within a few hundred tokens. Marked `estimated` → session total only,
 * rendered with a leading `~`.
 */
export function estimateInterruptedUsage(
    tailText: string,
    tailReasoning: string,
    basis: UsageBlock | undefined,
    session: Session,
    overheadTokens: number,
): UsageBlock | undefined {
    const textTokens = Math.ceil(tailText.length / 4);
    const reasoningTokens = Math.ceil(tailReasoning.length / 4);
    const outputTokens = textTokens + reasoningTokens;
    // No output streamed and no real basis to anchor to → fabricate nothing.
    if (outputTokens === 0 && !basis) return undefined;
    const inputTokens = basis?.inputTokens ?? estimateContextTokens(session, overheadTokens);
    const inputTokenDetails = basis?.inputTokenDetails ? { ...basis.inputTokenDetails } : undefined;
    const cachedInputTokens = basis?.inputTokenDetails?.cacheReadTokens ?? basis?.cachedInputTokens;
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens,
        inputTokenDetails,
        outputTokenDetails: { textTokens, reasoningTokens },
        estimated: true,
    };
}
