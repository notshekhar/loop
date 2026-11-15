import { visibleWidth } from "../../utils";
import { wordWrapLine } from "./word-wrap";

/** One screen row of a (possibly wrapped) logical line. */
export interface VisualLine {
    logicalLine: number;
    startCol: number;
    length: number;
}

/**
 * Build a mapping from visual lines to logical positions: each element is a
 * visual line with the logical line it belongs to, its starting column, and
 * the length of that segment.
 */
export function buildVisualLines(
    lines: readonly string[],
    width: number,
    graphemes: (line: string) => Intl.SegmentData[],
): VisualLine[] {
    const visualLines: VisualLine[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] || "";
        if (line.length === 0) {
            visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
        } else if (visibleWidth(line) <= width) {
            visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
        } else {
            for (const chunk of wordWrapLine(line, width, graphemes(line))) {
                visualLines.push({
                    logicalLine: i,
                    startCol: chunk.startIndex,
                    length: chunk.endIndex - chunk.startIndex,
                });
            }
        }
    }
    return visualLines;
}

/** Is visual line `index` the last row of its logical line? */
export function isLastRowOfLine(visualLines: readonly VisualLine[], index: number): boolean {
    return index === visualLines.length - 1 || visualLines[index + 1]?.logicalLine !== visualLines[index]?.logicalLine;
}

/**
 * The furthest column the cursor can sit at on a row. Only the last row of a
 * logical line allows the end position; earlier rows clamp to length-1 so the
 * cursor stays within them.
 */
export function maxVisualCol(visualLines: readonly VisualLine[], index: number): number {
    const vl = visualLines[index]!;
    return isLastRowOfLine(visualLines, index) ? vl.length : Math.max(0, vl.length - 1);
}

/** Find the visual line index that contains the given logical position. */
export function findVisualLineAt(visualLines: readonly VisualLine[], line: number, col: number): number {
    for (let i = 0; i < visualLines.length; i++) {
        const vl = visualLines[i];
        if (!vl || vl.logicalLine !== line) continue;
        const offset = col - vl.startCol;
        if (offset >= 0 && (offset < vl.length || (isLastRowOfLine(visualLines, i) && offset === vl.length))) {
            return i;
        }
    }
    return visualLines.length - 1;
}

/**
 * Compute the target visual column for vertical cursor movement.
 * Implements the sticky column decision table:
 *
 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
 *
 * Where:
 * - P = preferred col is set
 * - S = cursor in middle of source line (not clamped to end)
 * - T = target line shorter than current visual col
 * - U = target line shorter than preferred col
 */
export function computeVerticalMoveColumn(
    preferred: number | null,
    currentVisualCol: number,
    sourceMaxVisualCol: number,
    targetMaxVisualCol: number,
): { column: number; preferred: number | null } {
    const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
    const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

    if (preferred === null || cursorInMiddle) {
        // Cases 2 and 7, then 1 and 6
        return targetTooShort
            ? { column: targetMaxVisualCol, preferred: currentVisualCol }
            : { column: currentVisualCol, preferred: null };
    }
    if (targetTooShort || targetMaxVisualCol < preferred) {
        // Cases 4 and 5
        return { column: targetMaxVisualCol, preferred };
    }
    // Case 3
    return { column: preferred, preferred: null };
}
