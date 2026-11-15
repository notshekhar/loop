/** Laying out and painting a parsed sequence diagram onto a cell canvas. */
import { visibleWidth, wrapTextWithAnsi } from "../utils";
import { Canvas } from "./canvas";
import type { ParsedSequence, SequenceEvent, SequenceFrame, SequenceMessage, SequenceNote } from "./sequence-parse";

export {
    parseSequence,
    type ArrowHead,
    type ParsedSequence,
    type SequenceEvent,
    type SequenceFrame,
    type SequenceMessage,
    type SequenceNote,
} from "./sequence-parse";

/** Minimum cells between two lifelines. */
const MIN_GAP = 4;
/** Cells a frame is inset per nesting level. */
const FRAME_INSET = 2;
/** Passes of gap-widening; each settles the labels the previous one pushed apart. */
const GAP_PASSES = 6;

interface Row {
    event: SequenceEvent;
    top: number;
    height: number;
    depth: number;
}

/** Where each participant's column sits, once the gaps have settled. */
interface Columns {
    index: Map<string, number>;
    count: number;
    boxWidth: number[];
    centre: number[];
}

const wrap = (text: string, limit: number): string[] =>
    visibleWidth(text) <= limit ? [text] : wrapTextWithAnsi(text, limit);

/** Name and message caps to try, widest first. */
const CAPS: Array<[name: number, text: number]> = [
    [20, 32],
    [18, 24],
    [14, 18],
    [11, 14],
    [8, 10],
];

/**
 * Widening the gaps is what makes a long message label expensive: every label
 * between two lifelines pushes those columns apart, and eight participants
 * multiply that. So try progressively tighter caps and let the labels spend
 * rows instead of columns — a terminal has rows to spare.
 */
export function drawSequence(parsed: ParsedSequence, maxWidth: number): Canvas | undefined {
    for (const [nameCap, textCap] of CAPS) {
        const canvas = paintSequence(parsed, maxWidth, nameCap, textCap);
        if (canvas) return canvas;
    }
    return undefined;
}

function paintSequence(parsed: ParsedSequence, maxWidth: number, nameCap: number, textCap: number): Canvas | undefined {
    const names = parsed.participants.map((entry) => wrap(entry.label, nameCap));
    const headerHeight = Math.max(...names.map((lines) => lines.length)) + 2;
    const inset = maxFrameDepth(parsed.events) * FRAME_INSET;
    const columns = settleColumns(parsed, names, inset, textCap);
    const { rows, wrapped, height } = layoutRows(parsed.events, columns, headerHeight, textCap);
    const width = diagramWidth(rows, wrapped, columns, inset);
    if (width > maxWidth || width <= 0) return undefined;

    const canvas = new Canvas(width, height);
    drawParticipants(canvas, names, columns, headerHeight, height);
    drawRows(canvas, rows, wrapped, columns, width, height);
    return canvas;
}

/** Frame nesting decides the inset, and it does not depend on any sizing. */
function maxFrameDepth(events: readonly SequenceEvent[]): number {
    let maxDepth = 0;
    let depth = 0;
    for (const event of events) {
        if (event.kind !== "frame") continue;
        if (event.tag === "end") depth = Math.max(0, depth - 1);
        else if (event.tag !== "else") maxDepth = Math.max(maxDepth, ++depth);
    }
    return maxDepth;
}

/**
 * Widen gaps until every label fits — but only up to the cap. Past it the
 * label wraps onto more rows rather than dragging the columns apart.
 */
function settleColumns(parsed: ParsedSequence, names: string[][], inset: number, textCap: number): Columns {
    const count = parsed.participants.length;
    const index = new Map(parsed.participants.map((entry, position) => [entry.id, position]));
    const boxWidth = names.map((lines) => Math.max(...lines.map(visibleWidth)) + 4);
    const gaps = new Array<number>(Math.max(0, count - 1)).fill(MIN_GAP);
    const centres = () => {
        const result: number[] = [];
        let cursor = inset;
        for (let column = 0; column < count; column++) {
            result.push(cursor + Math.floor(boxWidth[column]! / 2));
            cursor += boxWidth[column]! + (gaps[column] ?? 0);
        }
        return result;
    };
    for (let pass = 0; pass < GAP_PASSES; pass++) {
        if (!widenGaps(parsed.events, { index, count, boxWidth, centre: centres() }, gaps, textCap)) break;
    }
    return { index, count, boxWidth, centre: centres() };
}

/** One widening pass; returns whether any gap grew. */
function widenGaps(events: readonly SequenceEvent[], columns: Columns, gaps: number[], textCap: number): boolean {
    const { index, count, centre } = columns;
    let grew = false;
    const require = (left: number, right: number, need: number) => {
        if (left === right) return;
        const have = centre[right]! - centre[left]!;
        if (have >= need) return;
        const share = Math.ceil((need - have) / (right - left));
        for (let gap = left; gap < right; gap++) gaps[gap] = (gaps[gap] ?? 0) + share;
        grew = true;
    };
    for (const event of events) {
        if (event.kind === "message") {
            const from = index.get(event.from);
            const to = index.get(event.to);
            if (from === undefined || to === undefined) continue;
            const want = Math.min(visibleWidth(event.text), textCap);
            if (from === to) {
                if (from < count - 1) require(from, from + 1, want + 6);
                continue;
            }
            require(Math.min(from, to), Math.max(from, to), want + 3);
        } else if (event.kind === "note") {
            const noteColumns = columnsOf(event, index);
            if (noteColumns.length === 0) continue;
            require(Math.min(...noteColumns), Math.max(...noteColumns), Math.min(visibleWidth(event.text), textCap) +
                4);
        }
    }
    return grew;
}

function columnsOf(note: SequenceNote, index: Map<string, number>): number[] {
    return note.over.map((id) => index.get(id)).filter((value): value is number => value !== undefined);
}

/**
 * Rows last: how tall a message is depends on how far its label had to wrap,
 * which is only known once the columns have settled.
 */
function layoutRows(events: readonly SequenceEvent[], columns: Columns, headerHeight: number, textCap: number) {
    const rows: Row[] = [];
    const wrapped = new Map<SequenceEvent, string[]>();
    let depth = 0;
    let flow = headerHeight;
    const push = (event: SequenceEvent, height: number, rowDepth: number) => {
        rows.push({ event, top: flow, height, depth: rowDepth });
        flow += height;
    };
    for (const event of events) {
        if (event.kind === "frame") {
            if (event.tag === "end") depth = Math.max(0, depth - 1);
            push(event, 1, event.tag === "else" ? Math.max(0, depth - 1) : depth);
            if (event.tag !== "end" && event.tag !== "else") depth += 1;
            continue;
        }
        const lines = wrapEventLabel(event, columns, textCap);
        wrapped.set(event, lines);
        const selfCall = event.kind === "message" && event.from === event.to;
        push(event, event.kind === "note" || selfCall ? lines.length + 2 : lines.length + 1, depth);
    }
    return { rows, wrapped, height: flow + 1 };
}

/** A note or message label, wrapped to the room its columns give it. */
function wrapEventLabel(event: SequenceMessage | SequenceNote, columns: Columns, textCap: number): string[] {
    const { index, count, centre } = columns;
    if (event.kind === "note") {
        const noteColumns = columnsOf(event, index);
        const span = noteColumns.length ? centre[Math.max(...noteColumns)]! - centre[Math.min(...noteColumns)]! : 0;
        return wrap(event.text, Math.max(8, Math.min(textCap, span + 2)));
    }
    const from = index.get(event.from);
    const to = index.get(event.to);
    const room =
        from === undefined || to === undefined
            ? textCap
            : from === to
              ? Math.max(8, centre[Math.min(from + 1, count - 1)]! - centre[from]! - 5)
              : Math.max(8, Math.abs(centre[to]! - centre[from]!) - 1);
    return event.text ? wrap(event.text, Math.max(8, Math.min(textCap, room))) : [];
}

/**
 * A self call turns to the right of its own lifeline, so the last column
 * needs room beyond its box — otherwise a one-participant diagram has
 * nowhere to draw the call it makes on itself.
 */
function diagramWidth(rows: Row[], wrapped: Map<SequenceEvent, string[]>, columns: Columns, inset: number): number {
    const { index, count, boxWidth, centre } = columns;
    let overhang = 0;
    for (const row of rows) {
        const event = row.event;
        if (event.kind !== "message" || event.from !== event.to) continue;
        const column = index.get(event.from);
        if (column === undefined) continue;
        const label = wrapped.get(event) ?? [];
        overhang = Math.max(overhang, centre[column]! + 6 + Math.max(0, ...label.map(visibleWidth)));
    }
    return Math.max((centre[count - 1] ?? 0) + Math.ceil((boxWidth[count - 1] ?? 0) / 2) + inset, overhang + inset);
}

/** A box with the name at the top of each column, and its lifeline running down. */
function drawParticipants(
    canvas: Canvas,
    names: string[][],
    columns: Columns,
    headerHeight: number,
    height: number,
): void {
    const { boxWidth, centre } = columns;
    names.forEach((lines, column) => {
        const left = centre[column]! - Math.floor(boxWidth[column]! / 2);
        canvas.box(left, 0, boxWidth[column]!, headerHeight, "border");
        lines.forEach((line, row) => {
            const offset = Math.max(0, Math.floor((boxWidth[column]! - 2 - visibleWidth(line)) / 2));
            canvas.text(left + 1 + offset, 1 + row, line, "accent");
        });
        canvas.vline(centre[column]!, headerHeight, height - headerHeight, "muted");
    });
}

function drawRows(
    canvas: Canvas,
    rows: Row[],
    wrapped: Map<SequenceEvent, string[]>,
    columns: Columns,
    width: number,
    height: number,
): void {
    const { index, boxWidth, centre } = columns;
    const open: Row[] = [];
    for (const row of rows) {
        const event = row.event;
        if (event.kind === "note") {
            drawNote(canvas, event, row, wrapped.get(event) ?? [event.text], centre, index, boxWidth, width);
        } else if (event.kind === "message") {
            drawMessage(canvas, event, row, wrapped.get(event) ?? [], centre, index);
        } else if (event.tag === "end") {
            const start = open.pop();
            if (start) drawFrame(canvas, start, row, width);
        } else if (event.tag === "else") {
            drawElse(canvas, event, row, width);
        } else {
            open.push(row);
        }
    }
    // A frame left open by a missing `end` still gets its box, closed at the foot.
    while (open.length > 0) {
        const start = open.pop()!;
        drawFrame(canvas, start, { event: start.event, top: height - 1, height: 1, depth: start.depth }, width);
    }
}

/** A dividing rule across the enclosing frame, labelled with the branch. */
function drawElse(canvas: Canvas, event: SequenceFrame, row: Row, width: number): void {
    const left = row.depth * FRAME_INSET;
    canvas.clear(left, row.top, width - left * 2, 1);
    canvas.hline(left, row.top, width - left * 2, "border");
    if (event.text) canvas.text(left + 2, row.top, ` ${event.text} `, "muted");
}

function drawMessage(
    canvas: Canvas,
    event: SequenceMessage,
    row: Row,
    label: string[],
    centre: number[],
    index: Map<string, number>,
): void {
    const from = index.get(event.from);
    const to = index.get(event.to);
    if (from === undefined || to === undefined) return;
    const dash = event.dashed ? "-" : "\u2500";
    const head = event.head === "cross" ? "x" : ">";
    // The label stacks above the arrow, so the arrow is always the last row.
    const arrowRow = row.top + label.length;

    if (from === to) {
        // Out to the right, down, and back: the shape everyone draws for a call
        // a participant makes on itself.
        const stem = centre[from]!;
        const turn = stem + 3;
        label.forEach((line, offset) => canvas.text(turn + 2, row.top + offset, line, "label"));
        canvas.hline(stem, arrowRow - 1, turn - stem + 1, "edge");
        canvas.vline(turn, arrowRow - 1, 3, "edge");
        canvas.hline(stem + 1, arrowRow + 1, turn - stem, "edge");
        canvas.glyph(stem + 1, arrowRow + 1, head === "x" ? "x" : "<", "edge");
        return;
    }

    const left = Math.min(centre[from]!, centre[to]!);
    const right = Math.max(centre[from]!, centre[to]!);
    for (let x = left + 1; x < right; x++) {
        if (event.dashed && (x - left) % 2 === 0) continue;
        canvas.glyph(x, arrowRow, dash, "edge");
    }
    canvas.glyph(centre[to]!, arrowRow, to > from ? head : head === "x" ? "x" : "<", "edge");

    const span = right - left - 1;
    label.forEach((line, offset) => {
        const inset = Math.max(0, Math.floor((span - visibleWidth(line)) / 2));
        canvas.text(left + 1 + inset, row.top + offset, line, "label");
    });
}

function drawNote(
    canvas: Canvas,
    event: SequenceNote,
    row: Row,
    label: string[],
    centre: number[],
    index: Map<string, number>,
    boxWidth: number[],
    width: number,
): void {
    const columns = event.over.map((id) => index.get(id)).filter((value): value is number => value !== undefined);
    if (columns.length === 0) return;
    const low = Math.min(...columns);
    const high = Math.max(...columns);
    const needed = Math.max(...label.map(visibleWidth)) + 4;

    let left: number;
    let boxSpan: number;
    if (event.side === "left") {
        boxSpan = Math.min(needed, centre[low]!);
        left = Math.max(0, centre[low]! - boxSpan);
    } else if (event.side === "right") {
        left = centre[high]!;
        boxSpan = Math.min(needed, width - left);
    } else {
        const outerLeft = centre[low]! - Math.floor(boxWidth[low]! / 2);
        const outerRight = centre[high]! + Math.floor(boxWidth[high]! / 2);
        boxSpan = Math.max(needed, outerRight - outerLeft + 1);
        left = Math.max(0, Math.min(outerLeft, width - boxSpan));
    }
    if (boxSpan < 4) return;

    const boxHeight = label.length + 2;
    // The lifelines were drawn first and run underneath: wipe the whole
    // footprint so the note sits on top of them rather than merging into them.
    canvas.clear(left, row.top, boxSpan, boxHeight);
    canvas.box(left, row.top, boxSpan, boxHeight, "border");
    label.forEach((line, offset) => {
        const inset = Math.max(0, Math.floor((boxSpan - 2 - visibleWidth(line)) / 2));
        canvas.text(left + 1 + inset, row.top + 1 + offset, line, "muted");
    });
}

function drawFrame(canvas: Canvas, start: Row, end: Row, width: number): void {
    const left = start.depth * FRAME_INSET;
    const right = width - left - 1;
    const span = right - left + 1;
    if (span < 6) return;
    const event = start.event as SequenceFrame;
    // Only the two horizontal borders cross the lifelines; the sides run down
    // the margin, and the enclosed rows must keep the lifelines they drew.
    canvas.clear(left, start.top, span, 1);
    canvas.clear(left, end.top, span, 1);
    canvas.box(left, start.top, span, end.top - start.top + 1, "border");
    const tag = event.text ? `${event.tag} ${event.text}` : event.tag;
    const label = ` ${tag} `;
    if (visibleWidth(label) <= span - 4) canvas.text(left + 2, start.top, label, "accent");
}
