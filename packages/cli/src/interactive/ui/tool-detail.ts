/**
 * How much of a finished tool call the transcript shows — the `d` cycle and
 * the `toolDetail` setting.
 *
 * This is the one thing about the transcript's look that is the USER's rather
 * than the design's, which is why it survived the UI-mode teardown while every
 * other knob became straight-line code. It is deliberately SUBTRACTIVE:
 * `compact` takes the receipt and the peek away, and the other two leave the
 * rows exactly as they are drawn. A density that could ADD something would be
 * inventing a second look for a transcript that has one.
 *
 * (`full` is not additive either — expanding every call is the `e` flag the
 * transcript already owns, applied by the caller.)
 */

export type ToolDetail = "compact" | "normal" | "full";

const DETAILS: readonly ToolDetail[] = ["compact", "normal", "full"] as const;

/** Lines of real output a FOLDED call shows under its receipt. */
const PEEK_LINES = 3;

let toolDetail: ToolDetail = "normal";

/** Set the density. Returns whether it CHANGED, so a caller can skip a repaint. */
export function setToolDetail(detail: ToolDetail): boolean {
    if (toolDetail === detail) return false;
    toolDetail = detail;
    return true;
}

export function getToolDetail(): ToolDetail {
    return toolDetail;
}

/** The next density in the cycle — what `d` moves to. */
export function nextToolDetail(): ToolDetail {
    return DETAILS[(DETAILS.indexOf(toolDetail) + 1) % DETAILS.length];
}

/** A hand-edited settings file may say anything; only the three values are a
 * density. Everything else resolves to the default rather than to a look
 * nobody defined. */
export function parseToolDetail(value: unknown): ToolDetail {
    return value === "compact" || value === "full" ? value : "normal";
}

/**
 * Does a finished row carry its one-line receipt (`580 lines`, `exit 1`)?
 * Only `compact` says no.
 */
export function showsReceipt(): boolean {
    return toolDetail !== "compact";
}

/** How many lines of real output a folded row previews (0 in `compact`). */
export function peekLines(): number {
    return toolDetail === "compact" ? 0 : PEEK_LINES;
}
