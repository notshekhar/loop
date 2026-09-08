/**
 * Fitting a one-line row to the terminal.
 *
 * Shared because both renderers need the same rule and disagreed about it: an
 * overflowing line trips the TUI's crash guard and takes the whole UI with it,
 * while the default mode's box wrapped instead — turning one tool call into a
 * two-line title once summaries were allowed their real length.
 */
import { truncateToWidth, visibleWidth } from "@notshekhar/loop-tui";

/** One-line rows must never exceed the terminal width — an overflowing line
 * trips the TUI's crash guard and kills the whole UI (a long bash command in
 * a tool header did exactly that). Truncate with an ellipsis, grok-style. */
export function fitRow(line: string, width: number): string {
    // `truncateToWidth` appends an ellipsis of its own ("..." by default), so
    // it has to be told not to — otherwise every clipped row ends "...…", one
    // ellipsis from each of us.
    return visibleWidth(line) > width ? truncateToWidth(line, Math.max(0, width - 1), "") + "…" : line;
}

/**
 * Fit `head + middle + tail` into `width` by shrinking the MIDDLE.
 *
 * `fitRow` cuts a row's end, which is right when the row is all one thing and
 * wrong when its last columns are the part you most need — a running call's
 * `· running`, a folded member's `2121 bytes`. Those are the verdict on the
 * row; the command or the path is the part there is always more of. Cutting
 * the end put an ellipsis exactly where the status had been, so a row that was
 * still running read as one that had simply stopped mid-word.
 *
 * The content gives way instead, and the tail is kept whole.
 */
export function fitAroundTail(head: string, middle: string, tail: string, width: number): string {
    if (!tail) return fitRow(head + middle, width);
    const fixed = visibleWidth(head) + visibleWidth(tail);
    if (fixed + visibleWidth(middle) <= width) return head + middle + tail;
    const room = width - fixed;
    // Not even head and tail fit. Nothing here can save the row, so fall back
    // to the plain rule rather than emit something wider than the terminal.
    if (room < 2) return fitRow(head + tail, width);
    // truncateToWidth counts the ellipsis itself and closes any open colour,
    // so the tail that follows keeps its own.
    return head + truncateToWidth(middle, room, "…") + tail;
}
