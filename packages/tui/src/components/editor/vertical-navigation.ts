import type { EditorState } from "./types";
import { computeVerticalMoveColumn, findVisualLineAt, maxVisualCol, type VisualLine } from "./visual-lines";

/**
 * Moves the cursor between visual rows while keeping its column "sticky":
 * passing through a short row and back lands where you started. Also keeps
 * the cursor from landing inside an atomic segment such as a paste marker.
 */
export class VerticalNavigator {
    /** Preferred visual column for vertical cursor movement (sticky column). */
    preferredVisualCol: number | null = null;

    /**
     * When the cursor is snapped to the start of an atomic segment, e.g. a
     * paste marker, cursorCol no longer reflects where the cursor would have
     * landed. This holds the pre-snap cursorCol so the next vertical move can
     * resolve it to a visual column on whatever row it belongs to.
     */
    private snappedFromCursorCol: number | null = null;

    constructor(
        private readonly state: () => EditorState,
        private readonly graphemes: (line: string) => Intl.SegmentData[],
    ) {}

    /** Any non-vertical move forgets the sticky column. */
    reset(): void {
        this.preferredVisualCol = null;
        this.snappedFromCursorCol = null;
    }

    /** Move the cursor from row `from` to row `to`, applying the sticky-column rules. */
    moveTo(visualLines: readonly VisualLine[], from: number, to: number): void {
        const source = visualLines[from];
        const target = visualLines[to];
        if (!(source && target)) return;

        const decision = computeVerticalMoveColumn(
            this.preferredVisualCol,
            this.currentVisualCol(visualLines, source),
            maxVisualCol(visualLines, from),
            maxVisualCol(visualLines, to),
        );
        this.preferredVisualCol = decision.preferred;

        const state = this.state();
        const logicalLine = state.lines[target.logicalLine] || "";
        state.cursorLine = target.logicalLine;
        state.cursorCol = Math.min(target.startCol + decision.column, logicalLine.length);
        this.snapToSegmentStart(visualLines, from, to, logicalLine);
    }

    /**
     * When the cursor was snapped to a segment start, resolve the pre-snap
     * position against the row it belongs to. This gives the correct visual
     * column even after a resize reshuffles rows.
     */
    private currentVisualCol(visualLines: readonly VisualLine[], source: VisualLine): number {
        if (this.snappedFromCursorCol === null) return this.state().cursorCol - source.startCol;
        const row = findVisualLineAt(visualLines, source.logicalLine, this.snappedFromCursorCol);
        return this.snappedFromCursorCol - visualLines[row]!.startCol;
    }

    /**
     * Never leave the cursor in the middle of a multi-grapheme unit such as a
     * paste marker: snap to its start so it gets highlighted. Moving down
     * into the continuation rows of a marker already passed skips past them.
     */
    private snapToSegmentStart(visualLines: readonly VisualLine[], from: number, to: number, line: string): void {
        const state = this.state();
        const target = visualLines[to]!;
        for (const seg of this.graphemes(line)) {
            if (seg.index > state.cursorCol) break;
            if (seg.segment.length <= 1) continue;
            if (state.cursorCol >= seg.index + seg.segment.length) continue;

            const isContinuation = seg.index < target.startCol;
            if (isContinuation && to > from) {
                const next = firstRowPast(visualLines, to, seg.index + seg.segment.length);
                if (next < visualLines.length) {
                    this.moveTo(visualLines, from, next);
                    return;
                }
            }
            this.snappedFromCursorCol = state.cursorCol;
            state.cursorCol = seg.index;
            return;
        }
        // No snap occurred – we moved out of the atomic segment.
        this.snappedFromCursorCol = null;
    }
}

/** The first row after `row` on the same logical line that starts at or past `end`. */
function firstRowPast(visualLines: readonly VisualLine[], row: number, end: number): number {
    const logicalLine = visualLines[row]!.logicalLine;
    let next = row + 1;
    while (
        next < visualLines.length &&
        visualLines[next]!.logicalLine === logicalLine &&
        visualLines[next]!.startCol < end
    ) {
        next++;
    }
    return next;
}
