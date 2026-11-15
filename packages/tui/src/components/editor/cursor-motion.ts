import type { EditorBuffer } from "./buffer";
import { currentLine, isFirstLine, isLastLine, textBeforeCursor } from "./line-edits";
import { editorPageSize } from "./types";
import { buildVisualLines, findVisualLineAt, type VisualLine } from "./visual-lines";

/** Every way the cursor moves without changing the text. */
export class CursorMotion {
    /** Width the text was last wrapped at; rows are computed against it. */
    layoutWidth = 80;

    constructor(
        private readonly buffer: EditorBuffer,
        private readonly terminalRows: () => number,
    ) {}

    /** The visual rows of the text and the one holding the cursor. */
    currentRow(): { index: number; visualLines: VisualLine[] } {
        const { state } = this.buffer;
        const visualLines = buildVisualLines(state.lines, this.layoutWidth, (line) => this.buffer.graphemes(line));
        return { index: findVisualLineAt(visualLines, state.cursorLine, state.cursorCol), visualLines };
    }

    isOnFirstRow(): boolean {
        return this.currentRow().index === 0;
    }

    isOnLastRow(): boolean {
        const { index, visualLines } = this.currentRow();
        return index === visualLines.length - 1;
    }

    lineStart(): void {
        this.buffer.lastAction = null;
        this.buffer.setCursorCol(0);
    }

    lineEnd(): void {
        this.buffer.lastAction = null;
        this.buffer.setCursorCol(currentLine(this.buffer.state).length);
    }

    docStart(): void {
        this.buffer.lastAction = null;
        this.buffer.state.cursorLine = 0;
        this.buffer.setCursorCol(0);
    }

    docEnd(): void {
        const { state } = this.buffer;
        this.buffer.lastAction = null;
        state.cursorLine = Math.max(0, state.lines.length - 1);
        this.buffer.setCursorCol(currentLine(state).length);
    }

    /** One visual row up (-1) or down (1). */
    vertical(delta: -1 | 1): void {
        this.buffer.lastAction = null;
        const { index, visualLines } = this.currentRow();
        const target = index + delta;
        if (target >= 0 && target < visualLines.length) {
            this.buffer.navigator.moveTo(visualLines, index, target);
        }
    }

    /** One grapheme right, or onto the next line. */
    right(): void {
        const { buffer } = this;
        const { state } = buffer;
        buffer.lastAction = null;
        const line = currentLine(state);
        if (state.cursorCol < line.length) {
            const next = buffer.graphemes(line.slice(state.cursorCol))[0];
            buffer.setCursorCol(state.cursorCol + (next ? next.segment.length : 1));
        } else if (!isLastLine(state)) {
            state.cursorLine++;
            buffer.setCursorCol(0);
        } else {
            // At the very end: can't move, but remember the column for up/down.
            const { index, visualLines } = this.currentRow();
            const row = visualLines[index];
            if (row) buffer.navigator.preferredVisualCol = state.cursorCol - row.startCol;
        }
    }

    /** One grapheme left, or onto the end of the previous line. */
    left(): void {
        const { buffer } = this;
        const { state } = buffer;
        buffer.lastAction = null;
        if (state.cursorCol > 0) {
            const graphemes = buffer.graphemes(textBeforeCursor(state));
            const previous = graphemes[graphemes.length - 1];
            buffer.setCursorCol(state.cursorCol - (previous ? previous.segment.length : 1));
        } else if (!isFirstLine(state)) {
            state.cursorLine--;
            buffer.setCursorCol(currentLine(state).length);
        }
    }

    /** Move by a page (direction: -1 for up, 1 for down), staying in bounds. */
    page(direction: -1 | 1): void {
        this.buffer.lastAction = null;
        const pageSize = editorPageSize(this.terminalRows());
        const { index, visualLines } = this.currentRow();
        const target = Math.max(0, Math.min(visualLines.length - 1, index + direction * pageSize));
        this.buffer.navigator.moveTo(visualLines, index, target);
    }

    wordLeft(): void {
        const { buffer } = this;
        const { state } = buffer;
        buffer.lastAction = null;
        if (state.cursorCol > 0) {
            buffer.setCursorCol(buffer.wordStartBefore(state.cursorCol));
        } else if (!isFirstLine(state)) {
            state.cursorLine--;
            buffer.setCursorCol(currentLine(state).length);
        }
    }

    wordRight(): void {
        const { buffer } = this;
        const { state } = buffer;
        buffer.lastAction = null;
        if (state.cursorCol < currentLine(state).length) {
            buffer.setCursorCol(buffer.wordEndAfter(state.cursorCol));
        } else if (!isLastLine(state)) {
            state.cursorLine++;
            buffer.setCursorCol(0);
        }
    }

    /**
     * Jump to the first occurrence of a character in the specified direction.
     * Multi-line search. Case-sensitive. Skips the current cursor position.
     */
    jumpTo(char: string, direction: "forward" | "backward"): void {
        const { state } = this.buffer;
        this.buffer.lastAction = null;
        const isForward = direction === "forward";
        const end = isForward ? state.lines.length : -1;
        const step = isForward ? 1 : -1;
        for (let lineIdx = state.cursorLine; lineIdx !== end; lineIdx += step) {
            const line = state.lines[lineIdx] || "";
            // Current line: start after/before cursor; other lines: search full line
            const searchFrom = lineIdx === state.cursorLine ? state.cursorCol + step : undefined;
            const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);
            if (idx !== -1) {
                state.cursorLine = lineIdx;
                this.buffer.setCursorCol(idx);
                return;
            }
        }
    }
}
