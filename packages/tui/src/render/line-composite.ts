import { CURSOR_MARKER } from "../component";
import { isImageLine } from "../terminal-image";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "../utils";

/** Closes any SGR style and OSC 8 link so nothing bleeds past a segment. */
export const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
    baseLine: string,
    overlayLine: string,
    startCol: number,
    overlayWidth: number,
    totalWidth: number,
): string {
    if (isImageLine(baseLine)) return baseLine;

    const afterStart = startCol + overlayWidth;
    const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
    const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
    const beforePad = Math.max(0, startCol - base.beforeWidth);
    const overlayPad = Math.max(0, overlayWidth - overlay.width);
    const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
    const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
    const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
    const afterPad = Math.max(0, afterTarget - base.afterWidth);
    const result =
        base.before +
        " ".repeat(beforePad) +
        SEGMENT_RESET +
        overlay.text +
        " ".repeat(overlayPad) +
        SEGMENT_RESET +
        base.after +
        " ".repeat(afterPad);

    return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

/** End every text line with a reset so one line's style never leaks into the next. */
export function applyLineResets(lines: string[]): string[] {
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!isImageLine(line)) {
            lines[i] = normalizeTerminalOutput(line) + SEGMENT_RESET;
        }
    }
    return lines;
}

/**
 * Find and extract cursor position from rendered lines.
 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
 * Only scans the bottom terminal height lines (visible viewport).
 * @param lines - Rendered lines to search
 * @param height - Terminal height (visible viewport size)
 * @returns Cursor position { row, col } or null if no marker found
 */
export function extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
    const viewportTop = Math.max(0, lines.length - height);
    for (let row = lines.length - 1; row >= viewportTop; row--) {
        const line = lines[row];
        const markerIndex = line.indexOf(CURSOR_MARKER);
        if (markerIndex !== -1) {
            const col = visibleWidth(line.slice(0, markerIndex));
            lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
            return { row, col };
        }
    }
    return null;
}
