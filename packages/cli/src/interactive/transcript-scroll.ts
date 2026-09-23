/**
 * Where the window onto the transcript has to sit for the selected entry to
 * be readable.
 *
 * Pure arithmetic over line numbers, kept apart from the frame that applies it
 * so the rule can be stated — and tested — without a terminal: scroll as
 * little as possible, and when the entry cannot fit, show its TOP.
 */

export interface LineRange {
    start: number;
    end: number;
}

export interface Window {
    /** First transcript line currently on screen. */
    top: number;
    /** How many rows of the transcript are visible. */
    height: number;
}

/**
 * The `top` the window should move to, or the one it already has when the
 * entry is fully visible.
 *
 * An entry TALLER than the window pins to its top. Trying to fit both ends of
 * one is what made the page ping-pong: each render chose the other end, and
 * the transcript juddered on every keystroke. Showing the top is also the
 * useful half — an entry starts with what it is (`◆ bash …`, `❯ your
 * question`) and continues into its output.
 */
export function scrollTopFor(range: LineRange, view: Window): number {
    if (view.height <= 0) return view.top;
    const tall = range.end - range.start + 1 > view.height;
    if (tall || range.start < view.top) return Math.max(0, range.start);
    if (range.end > view.top + view.height - 1) return Math.max(0, range.end - view.height + 1);
    return view.top;
}
