import { CURSOR_MARKER } from "../../component";
import { sliceByColumn, visibleWidth } from "../../utils";
import type { EditorState } from "./types";
import { wordWrapLine } from "./word-wrap";

/** One rendered row of editor text, and where the cursor sits in it (if it does). */
export interface LayoutLine {
    text: string;
    hasCursor: boolean;
    cursorPos?: number;
}

/** Horizontal space for the editor at a given width. */
export interface EditorBox {
    paddingX: number;
    contentWidth: number;
}

/** Padding never takes more than half the width; content keeps at least one column. */
export function editorBox(width: number, paddingX: number): EditorBox {
    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    const padding = Math.min(paddingX, maxPadding);
    return { paddingX: padding, contentWidth: Math.max(1, width - padding * 2) };
}

/** Wrap the editor's lines to `contentWidth` rows, marking the row that holds the cursor. */
export function layoutText(
    state: EditorState,
    contentWidth: number,
    graphemes: (line: string) => Intl.SegmentData[],
): LayoutLine[] {
    if (state.lines.length === 0 || (state.lines.length === 1 && state.lines[0] === "")) {
        return [{ text: "", hasCursor: true, cursorPos: 0 }];
    }
    const layoutLines: LayoutLine[] = [];
    for (let i = 0; i < state.lines.length; i++) {
        const line = state.lines[i] || "";
        const cursorCol = i === state.cursorLine ? state.cursorCol : undefined;
        if (visibleWidth(line) <= contentWidth) {
            layoutLines.push(withCursor(line, cursorCol));
        } else {
            layoutLines.push(...layoutWrappedLine(line, contentWidth, graphemes(line), cursorCol));
        }
    }
    return layoutLines;
}

function withCursor(text: string, cursorPos: number | undefined): LayoutLine {
    return cursorPos === undefined ? { text, hasCursor: false } : { text, hasCursor: true, cursorPos };
}

/**
 * A wrapped line: the cursor belongs to the chunk whose range holds it — the
 * last chunk takes anything from its start on, and a cursor in whitespace
 * trimmed off a chunk's end is clamped to the chunk's text.
 */
function layoutWrappedLine(
    line: string,
    contentWidth: number,
    segments: Intl.SegmentData[],
    cursorCol: number | undefined,
): LayoutLine[] {
    const chunks = wordWrapLine(line, contentWidth, segments);
    return chunks.map((chunk, index) => {
        if (cursorCol === undefined || cursorCol < chunk.startIndex) return withCursor(chunk.text, undefined);
        const isLastChunk = index === chunks.length - 1;
        if (isLastChunk) return withCursor(chunk.text, cursorCol - chunk.startIndex);
        if (cursorCol >= chunk.endIndex) return withCursor(chunk.text, undefined);
        return withCursor(chunk.text, Math.min(cursorCol - chunk.startIndex, chunk.text.length));
    });
}

/** The editor's top or bottom rule, saying how many rows are scrolled out of sight. */
export function createScrollBorder(direction: "↑" | "↓", hiddenLineCount: number, width: number): string {
    const availableWidth = Math.max(0, width);
    const indicator = `─── ${direction} ${hiddenLineCount} more `;
    const remaining = availableWidth - visibleWidth(indicator);
    if (remaining >= 0) return indicator + "─".repeat(remaining);

    const ellipsis = "...".slice(0, availableWidth);
    const indicatorWidth = availableWidth - visibleWidth(ellipsis);
    return sliceByColumn(indicator, 0, indicatorWidth, true) + ellipsis;
}

/** Tints part of a row; `offset` is where in the logical line the part starts. */
export type Tint = (text: string, offset: number) => string;

/**
 * Slash-command highlight: when the buffer starts with "/", tint the command
 * token (first word) as the user types — on the first text row only. Token
 * length is in plain chars; tinting is applied piecewise around the cursor so
 * ANSI never lands inside cursorPos-based slicing.
 */
export function slashCommandTint(firstLine: string, color: (s: string) => string, isFirstTextRow: boolean): Tint {
    const slashLen = /^\/\S+/.exec(firstLine)?.[0].length ?? 0;
    return (s, offset) => {
        if (!s || slashLen <= 0 || !isFirstTextRow) return s;
        const end = slashLen - offset;
        if (end <= 0) return s;
        if (end >= s.length) return color(s);
        return color(s.slice(0, end)) + s.slice(end);
    };
}

export interface RowStyle {
    box: EditorBox;
    tint: Tint;
    /** Emit the hardware cursor marker (for IME placement) before the drawn cursor. */
    showCursorMarker: boolean;
    firstGrapheme: (text: string) => string;
}

/** Render one layout row: text, an inverse-video cursor, and padding out to the full width. */
export function renderRow(row: LayoutLine, style: RowStyle): string {
    const { box, tint } = style;
    let text = tint(row.text, 0);
    let width = visibleWidth(row.text);
    let cursorInPadding = false;

    if (row.hasCursor && row.cursorPos !== undefined) {
        const before = row.text.slice(0, row.cursorPos);
        const after = row.text.slice(row.cursorPos);
        const marker = style.showCursorMarker ? CURSOR_MARKER : "";
        if (after.length > 0) {
            // Cursor is on a grapheme: draw that grapheme inverted (width unchanged).
            const under = style.firstGrapheme(after);
            const rest = tint(after.slice(under.length), row.cursorPos + under.length);
            text = tint(before, 0) + marker + `\x1b[7m${under}\x1b[0m` + rest;
        } else {
            // Cursor at the end: an inverted space, which may spill into the padding.
            text = tint(before, 0) + marker + "\x1b[7m \x1b[0m";
            width += 1;
            cursorInPadding = width > box.contentWidth && box.paddingX > 0;
        }
    }

    const side = " ".repeat(box.paddingX);
    const fill = " ".repeat(Math.max(0, box.contentWidth - width));
    return `${side}${text}${fill}${cursorInPadding ? side.slice(1) : side}`;
}

/** Row style for text with no cursor and no tint, e.g. the completion list. */
export function plainRowStyle(box: EditorBox): RowStyle {
    return { box, tint: (text) => text, showCursorMarker: false, firstGrapheme: () => "" };
}
