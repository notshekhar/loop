/** Begin / end synchronized output: the terminal shows the frame only once it is complete. */
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
/** Clear the whole current row. */
export const CLEAR_LINE = "\x1b[2K";

/** Move the cursor `delta` rows down (positive) or up (negative); nothing for 0. */
export function moveRows(delta: number): string {
    if (delta > 0) return `\x1b[${delta}B`;
    if (delta < 0) return `\x1b[${-delta}A`;
    return "";
}
