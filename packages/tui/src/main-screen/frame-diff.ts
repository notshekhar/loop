/** The rows that differ between two frames. */
export interface ChangedRange {
    firstChanged: number;
    lastChanged: number;
}

/**
 * Compare two frames line by line. Undefined when they are identical. A
 * frame that only grew counts as changed from the old end to the new end.
 */
export function findChangedRange(previousLines: string[], newLines: string[]): ChangedRange | undefined {
    let firstChanged = -1;
    let lastChanged = -1;
    const maxLines = Math.max(newLines.length, previousLines.length);
    for (let i = 0; i < maxLines; i++) {
        const oldLine = i < previousLines.length ? previousLines[i] : "";
        const newLine = i < newLines.length ? newLines[i] : "";
        if (oldLine !== newLine) {
            if (firstChanged === -1) firstChanged = i;
            lastChanged = i;
        }
    }
    if (newLines.length > previousLines.length) {
        if (firstChanged === -1) firstChanged = previousLines.length;
        lastChanged = newLines.length - 1;
    }
    return firstChanged === -1 ? undefined : { firstChanged, lastChanged };
}

/**
 * The frame grew or shrank above the visible window, and what the terminal
 * is actually showing is unchanged — only the line indices moved. Returns
 * that shift, or null when the window's content really did change.
 *
 * This is the common shape of a late startup notice (an MCP summary, a
 * hooks list) landing under the banner while the conversation below it is
 * long enough to have pushed the banner off the top of the screen: every
 * visible row still holds exactly what it held before.
 *
 * Only claimed when BOTH frames fill the screen. A frame shorter than the
 * terminal leaves rows loop never painted — whatever the shell left there —
 * and comparing those against blanks would call a window unchanged that
 * loop cannot actually vouch for.
 */
export function unchangedWindowShift(
    previousLines: string[],
    newLines: string[],
    height: number,
    prevViewportTop: number,
): number | null {
    if (newLines.length < height || previousLines.length < height) return null;
    const newTop = newLines.length - height;
    const shift = newTop - prevViewportTop;
    if (shift === 0) return null;
    for (let i = 0; i < height; i++) {
        if (newLines[newTop + i] !== previousLines[prevViewportTop + i]) return null;
    }
    return shift;
}
