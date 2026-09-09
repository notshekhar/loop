import { visibleWidth, wrapTextWithAnsi } from "../utils";
import { Canvas } from "./canvas";

/** Minimum cells between two lifelines. */
const MIN_GAP = 4;
/** Cells a frame is inset per nesting level. */
const FRAME_INSET = 2;

export type ArrowHead = "arrow" | "open" | "cross" | "async";

export interface SequenceMessage {
    kind: "message";
    from: string;
    to: string;
    text: string;
    dashed: boolean;
    head: ArrowHead;
}

export interface SequenceNote {
    kind: "note";
    /** Lifelines the note covers; one entry for `left of` / `right of`. */
    over: string[];
    side: "over" | "left" | "right";
    text: string;
}

export interface SequenceFrame {
    kind: "frame";
    /** `else` continues the frame it sits in rather than opening a new one. */
    tag: "loop" | "alt" | "opt" | "par" | "critical" | "break" | "else" | "end";
    text: string;
}

export type SequenceEvent = SequenceMessage | SequenceNote | SequenceFrame;

export interface ParsedSequence {
    participants: Array<{ id: string; label: string }>;
    events: SequenceEvent[];
}

const HEADS: Array<[token: string, dashed: boolean, head: ArrowHead]> = [
    ["-->>", true, "arrow"],
    ["--\\)", true, "async"],
    ["--x", true, "cross"],
    ["-->", true, "open"],
    ["->>", false, "arrow"],
    ["-\\)", false, "async"],
    ["-x", false, "cross"],
    ["->", false, "open"],
];

const MESSAGE_PATTERN = new RegExp(
    `^([A-Za-z0-9_]+)\\s*(${HEADS.map(([token]) => token).join("|")})\\s*([A-Za-z0-9_]+)\\s*:\\s*(.*)$`,
);

const FRAME_TAGS = ["loop", "alt", "opt", "par", "critical", "break", "else"] as const;

export function parseSequence(source: string): ParsedSequence | undefined {
    const participants: Array<{ id: string; label: string }> = [];
    const events: SequenceEvent[] = [];
    const seen = new Set<string>();
    let seenHeader = false;

    const declare = (id: string, label?: string) => {
        if (seen.has(id)) {
            if (label) {
                const existing = participants.find((entry) => entry.id === id);
                if (existing) existing.label = label;
            }
            return;
        }
        seen.add(id);
        participants.push({ id, label: label ?? id });
    };

    for (const raw of source.split("\n")) {
        const line = raw.replace(/%%.*$/, "").trim();
        if (!line) continue;
        if (!seenHeader) {
            if (!/^sequenceDiagram\b/.test(line)) return undefined;
            seenHeader = true;
            continue;
        }

        const participant = /^(?:participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/.exec(line);
        if (participant) {
            declare(participant[1]!, participant[2]?.trim());
            continue;
        }

        const note = /^Note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(line);
        if (note) {
            const targets = note[2]!
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean);
            targets.forEach((id) => declare(id));
            const side = note[1]!.toLowerCase().startsWith("left")
                ? "left"
                : note[1]!.toLowerCase().startsWith("right")
                  ? "right"
                  : "over";
            events.push({ kind: "note", over: targets, side, text: note[3]!.trim() });
            continue;
        }

        if (line === "end") {
            events.push({ kind: "frame", tag: "end", text: "" });
            continue;
        }
        const frame = new RegExp(`^(${FRAME_TAGS.join("|")})\\b\\s*(.*)$`).exec(line);
        if (frame) {
            events.push({ kind: "frame", tag: frame[1]! as SequenceFrame["tag"], text: frame[2]!.trim() });
            continue;
        }

        const message = MESSAGE_PATTERN.exec(line);
        if (message) {
            const token = message[2]!;
            const spec = HEADS.find(([candidate]) => candidate.replace(/\\/g, "") === token);
            declare(message[1]!);
            declare(message[3]!);
            events.push({
                kind: "message",
                from: message[1]!,
                to: message[3]!,
                text: message[4]!.trim(),
                dashed: spec?.[1] ?? false,
                head: spec?.[2] ?? "arrow",
            });
            continue;
        }
        // autonumber, activate/deactivate, rect, links: known, and nothing a
        // cell grid gains from drawing.
    }

    if (participants.length === 0) return undefined;
    return { participants, events };
}

interface Row {
    event: SequenceEvent;
    top: number;
    height: number;
    depth: number;
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
    const { participants, events } = parsed;
    const index = new Map(participants.map((entry, position) => [entry.id, position]));
    const count = participants.length;

    const names = participants.map((entry) => wrap(entry.label, nameCap));
    const headerHeight = Math.max(...names.map((lines) => lines.length)) + 2;

    // Frame nesting decides the inset, and it does not depend on any sizing.
    let maxDepth = 0;
    let probe = 0;
    for (const event of events) {
        if (event.kind !== "frame") continue;
        if (event.tag === "end") probe = Math.max(0, probe - 1);
        else if (event.tag !== "else") maxDepth = Math.max(maxDepth, ++probe);
    }

    const boxWidth = names.map((lines) => Math.max(...lines.map(visibleWidth)) + 4);
    const inset = maxDepth * FRAME_INSET;
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

    // Widen gaps until every label fits — but only up to the cap. Past it the
    // label wraps onto more rows rather than dragging the columns apart.
    for (let pass = 0; pass < 6; pass++) {
        const centre = centres();
        let grew = false;
        const require = (left: number, right: number, need: number) => {
            if (left === right) return;
            const have = centre[right]! - centre[left]!;
            if (have >= need) return;
            const deficit = need - have;
            const share = Math.ceil(deficit / (right - left));
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
                const columns = event.over
                    .map((id) => index.get(id))
                    .filter((value): value is number => value !== undefined);
                if (columns.length === 0) continue;
                require(Math.min(...columns), Math.max(...columns), Math.min(visibleWidth(event.text), textCap) + 4);
            }
        }
        if (!grew) break;
    }

    const centre = centres();

    // Rows last: how tall a message is depends on how far its label had to wrap,
    // which is only known once the columns have settled.
    const rows: Row[] = [];
    const wrapped = new Map<SequenceEvent, string[]>();
    let depth = 0;
    let flow = headerHeight;
    for (const event of events) {
        if (event.kind === "frame") {
            if (event.tag === "end") {
                depth = Math.max(0, depth - 1);
                rows.push({ event, top: flow, height: 1, depth });
                flow += 1;
                continue;
            }
            if (event.tag === "else") {
                rows.push({ event, top: flow, height: 1, depth: Math.max(0, depth - 1) });
                flow += 1;
                continue;
            }
            rows.push({ event, top: flow, height: 1, depth });
            depth += 1;
            maxDepth = Math.max(maxDepth, depth);
            flow += 1;
            continue;
        }
        if (event.kind === "note") {
            const columns = event.over.map((id) => index.get(id)).filter((v): v is number => v !== undefined);
            const span = columns.length ? centre[Math.max(...columns)]! - centre[Math.min(...columns)]! : 0;
            const lines = wrap(event.text, Math.max(8, Math.min(textCap, span + 2)));
            wrapped.set(event, lines);
            rows.push({ event, top: flow, height: lines.length + 2, depth });
            flow += lines.length + 2;
            continue;
        }
        const from = index.get(event.from);
        const to = index.get(event.to);
        const room =
            from === undefined || to === undefined
                ? textCap
                : from === to
                  ? Math.max(8, centre[Math.min(from + 1, count - 1)]! - centre[from]! - 5)
                  : Math.max(8, Math.abs(centre[to]! - centre[from]!) - 1);
        const lines = event.text ? wrap(event.text, Math.max(8, Math.min(textCap, room))) : [];
        wrapped.set(event, lines);
        const height = event.from === event.to ? lines.length + 2 : lines.length + 1;
        rows.push({ event, top: flow, height, depth });
        flow += height;
    }
    const height = flow + 1;

    // A self call turns to the right of its own lifeline, so the last column
    // needs room beyond its box — otherwise a one-participant diagram has
    // nowhere to draw the call it makes on itself.
    let overhang = 0;
    for (const row of rows) {
        const event = row.event;
        if (event.kind !== "message" || event.from !== event.to) continue;
        const column = index.get(event.from);
        if (column === undefined) continue;
        const label = wrapped.get(event) ?? [];
        overhang = Math.max(overhang, centre[column]! + 6 + Math.max(0, ...label.map(visibleWidth)));
    }
    const width = Math.max(
        (centre[count - 1] ?? 0) + Math.ceil((boxWidth[count - 1] ?? 0) / 2) + inset,
        overhang + inset,
    );
    if (width > maxWidth || width <= 0) return undefined;

    const canvas = new Canvas(width, height);

    participants.forEach((_entry, column) => {
        const left = centre[column]! - Math.floor(boxWidth[column]! / 2);
        canvas.box(left, 0, boxWidth[column]!, headerHeight, "border");
        names[column]!.forEach((line, row) => {
            const offset = Math.max(0, Math.floor((boxWidth[column]! - 2 - visibleWidth(line)) / 2));
            canvas.text(left + 1 + offset, 1 + row, line, "accent");
        });
        canvas.vline(centre[column]!, headerHeight, height - headerHeight, "muted");
    });

    const open: Row[] = [];
    for (const row of rows) {
        const event = row.event;
        if (event.kind === "frame") {
            if (event.tag === "end") {
                const start = open.pop();
                if (start) drawFrame(canvas, start, row, width);
                continue;
            }
            if (event.tag === "else") {
                const left = row.depth * FRAME_INSET;
                canvas.clear(left, row.top, width - left * 2, 1);
                canvas.hline(left, row.top, width - left * 2, "border");
                if (event.text) canvas.text(left + 2, row.top, ` ${event.text} `, "muted");
                continue;
            }
            open.push(row);
            continue;
        }
        if (event.kind === "note") {
            drawNote(canvas, event, row, wrapped.get(event) ?? [event.text], centre, index, boxWidth, width);
            continue;
        }
        drawMessage(canvas, event, row, wrapped.get(event) ?? [], centre, index);
    }
    // A frame left open by a missing `end` still gets its box, closed at the foot.
    while (open.length > 0) {
        const start = open.pop()!;
        drawFrame(canvas, start, { event: start.event, top: height - 1, height: 1, depth: start.depth }, width);
    }

    return canvas;
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
