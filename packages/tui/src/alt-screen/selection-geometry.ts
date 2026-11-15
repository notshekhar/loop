import type { ScrollView } from "../components/scroll-view";
import {
    extractAnsiCode,
    getGraphemeCellRange,
    getWordSegmenter,
    stripTerminalSequences,
    visibleWidth,
} from "../utils";

const wordSegmenter = getWordSegmenter();

// Regular mode delegates double-click selection to the terminal emulator. Fullscreen owns mouse selection,
// so mirror common terminal word-selection behavior by keeping paths and kebab-case tokens whole.
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-"]);

export interface SelectionPoint {
    row: number;
    col: number;
    scrollView?: ScrollView;
    /** Whether this point lies between terminal cells rather than on a cell. */
    boundary?: boolean;
}

export interface SelectionRange {
    start: SelectionPoint;
    end: SelectionPoint;
}

export function isBefore(a: SelectionPoint, b: SelectionPoint): boolean {
    return a.row < b.row || (a.row === b.row && a.col < b.col);
}

/** The anchor and focus in reading order; undefined for an empty or cross-view selection. */
export function orderedRange(anchor: SelectionPoint, focus: SelectionPoint): SelectionRange | undefined {
    if (anchor.scrollView !== focus.scrollView) return undefined;
    if (anchor.row === focus.row && anchor.col === focus.col) return undefined;
    return isBefore(anchor, focus) ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

interface WordSegment {
    start: number;
    end: number;
    selectable: boolean;
    joiner: boolean;
}

function wordSegments(line: string): WordSegment[] {
    const segments: WordSegment[] = [];
    let start = 0;
    for (const segment of wordSegmenter.segment(line)) {
        const end = start + visibleWidth(segment.segment);
        const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
        segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
        start = end;
    }
    return segments;
}

function canJoin(left: WordSegment, right: WordSegment): boolean {
    return left.selectable && right.selectable && (left.joiner || right.joiner);
}

/** The word (path, kebab-case token) under `point` on `sourceLine`; undefined past the end of the line. */
export function wordSelection(sourceLine: string, point: SelectionPoint): SelectionRange | undefined {
    const segments = wordSegments(stripTerminalSequences(sourceLine));
    const clicked = segments.findIndex((segment) => point.col >= segment.start && point.col < segment.end);
    if (clicked < 0) return undefined;
    let first = clicked;
    while (first > 0 && canJoin(segments[first - 1], segments[first])) first--;
    let last = clicked;
    while (last < segments.length - 1 && canJoin(segments[last], segments[last + 1])) last++;
    return {
        start: { ...point, col: segments[first].start },
        end: { ...point, col: segments[last].end, boundary: true },
    };
}

/** The whole line under `point`. */
export function lineSelection(sourceLine: string, point: SelectionPoint): SelectionRange {
    return {
        start: { ...point, col: 0 },
        end: { ...point, col: visibleWidth(sourceLine), boundary: true },
    };
}

/** The selected columns of one row, snapped to whole graphemes and kept within [minColumn, maxColumn). */
export function selectionColumns(
    line: string,
    row: number,
    selection: SelectionRange,
    minColumn = 0,
    maxColumn = visibleWidth(line),
): { start: number; end: number } {
    const lineWidth = visibleWidth(line);
    let start = Math.max(0, minColumn);
    let end = Math.min(lineWidth, maxColumn);
    if (row === selection.start.row) {
        start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
    }
    if (row === selection.end.row) {
        end = selection.end.boundary
            ? Math.min(selection.end.col, lineWidth)
            : (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
    }
    return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
}

/** Draw `text` in inverse video, re-asserting it after every style reset inside. */
export function highlightSelection(text: string): string {
    let result = "\x1b[7m";
    let index = 0;
    while (index < text.length) {
        const ansi = extractAnsiCode(text, index);
        if (!ansi) {
            result += text[index];
            index += 1;
            continue;
        }
        result += ansi.code;
        if (ansi.code.endsWith("m")) result += "\x1b[7m";
        index += ansi.length;
    }
    return `${result}\x1b[27m`;
}
