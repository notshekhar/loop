/**
 * Idle compaction: compact a big conversation just before its prompt cache
 * expires, while nobody is using it.
 *
 * Why the timing matters. Once a provider's prompt cache lapses (five minutes
 * for Anthropic's default, about as long for OpenAI's and xAI's automatic
 * caching), the next message re-reads the WHOLE conversation at full price.
 * Summarizing it while the cache is still warm reads it at the cached price
 * instead — a tenth of the input rate on Anthropic — and the message you come
 * back with starts from the summary plus the recent turns.
 *
 * What "idle" means here: the turn has ended, nothing runs in the session, and
 * no message arrives for almost the whole cache lifetime. Any new turn in the
 * session — typed in the TUI, sent from the desktop or the phone, mail from a
 * teammate — cancels it, through the same seam as the recap (runTurn calls
 * cancelIdleCompact at its top). A summary already being written when that
 * happens is thrown away rather than saved after the new message.
 *
 * Only for a conversation that is genuinely big: at least
 * `idleCompactMinPercent` of the context window (70 by default). Compacting a
 * small chat costs a model call and saves nearly nothing.
 */

/** How long before the cache lapses to start: room for the summary call to land. */
const CACHE_MARGIN_MS = 45_000;

/** Anthropic's default cache lifetime, and roughly OpenAI's and xAI's automatic one. */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/** Providers whose prompt caching is automatic, with no breakpoints of our own. */
const AUTO_CACHING_PROVIDERS = new Set(["openai", "xai"]);

let delayForTests: number | null = null;

/** Tests only: fire after `ms` instead of the cache lifetime (null restores it). */
export function setIdleCompactDelayForTests(ms: number | null): void {
    delayForTests = ms;
}

/** The idle delay for a turn's provider, or null when it has no prompt cache to beat. */
export function idleCompactDelayMs(input: { provider: string; anthropicCaching: boolean }): number | null {
    if (!input.anthropicCaching && !AUTO_CACHING_PROVIDERS.has(input.provider)) return null;
    return delayForTests ?? DEFAULT_CACHE_TTL_MS - CACHE_MARGIN_MS;
}

/** The share of the window a conversation must fill before idle compaction bothers. */
export const DEFAULT_IDLE_COMPACT_MIN_PERCENT = 70;

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; abort: AbortController }>();

/** Drop this session's idle compaction, waiting or already writing. */
export function cancelIdleCompact(sessionId: string): void {
    const entry = pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.abort.abort();
    pending.delete(sessionId);
}

/**
 * Run `run` for this session once `delayMs` passes with no new turn. `run`
 * gets the signal cancelIdleCompact aborts and must check it before saving.
 */
export function scheduleIdleCompact(
    sessionId: string,
    delayMs: number,
    run: (signal: AbortSignal) => Promise<void>,
): void {
    cancelIdleCompact(sessionId);
    const abort = new AbortController();
    const timer = setTimeout(() => {
        void run(abort.signal)
            .catch(() => {})
            .finally(() => {
                if (pending.get(sessionId)?.abort === abort) pending.delete(sessionId);
            });
    }, delayMs);
    // Never the reason a process stays alive.
    (timer as { unref?: () => void }).unref?.();
    pending.set(sessionId, { timer, abort });
}

/** Whether one is waiting or writing (tests, diagnostics). */
export function hasPendingIdleCompact(sessionId: string): boolean {
    return pending.has(sessionId);
}

/** What the summary request appends to the cached conversation. */
export const IDLE_SUMMARY_INSTRUCTIONS = `This conversation has gone idle, and it is being compacted before its prompt cache expires. Do not continue the conversation and do not call any tool.

Write a summary of the conversation above that lets you pick it up later with nothing else: the user's goal and constraints, what has been done and decided (with exact file paths, names, commands and results), the current state, and what is left. If an earlier summary appears above, fold it in rather than repeating it. The most recent messages will also be kept word for word after your summary, so focus on everything that came before them.

Use these sections, in markdown:
## Goal
## Done so far
## Key details
## Current state
## Next steps`;
