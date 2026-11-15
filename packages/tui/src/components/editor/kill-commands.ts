import { KillRing } from "../../kill-ring";
import type { EditorBuffer } from "./buffer";
import {
    currentLine,
    deleteInLine,
    insertAtCursor,
    isLastLine,
    joinWithNextLine,
    joinWithPreviousLine,
    textBeforeCursor,
} from "./line-edits";

/**
 * Emacs-style kill and yank: deletions that save what they removed to a kill
 * ring (consecutive kills join into one entry), yank to paste it back, and
 * yank-pop to cycle through older entries.
 */
export class KillCommands {
    private killRing = new KillRing();

    constructor(private readonly buffer: EditorBuffer) {}

    deleteToLineStart(): void {
        const { buffer } = this;
        const { state } = buffer;
        this.buffer.beginEdit();
        if (state.cursorCol > 0) {
            buffer.pushUndoSnapshot();
            this.kill(textBeforeCursor(state), "backward");
            deleteInLine(state, 0, state.cursorCol);
            buffer.setCursorCol(0);
        } else if (state.cursorLine > 0) {
            this.killNewlineBackward();
        }
        buffer.notifyChange();
    }

    deleteToLineEnd(): void {
        const { buffer } = this;
        const { state } = buffer;
        this.buffer.beginEdit();
        const line = currentLine(state);
        if (state.cursorCol < line.length) {
            buffer.pushUndoSnapshot();
            this.kill(line.slice(state.cursorCol), "forward");
            deleteInLine(state, state.cursorCol, line.length);
        } else if (!isLastLine(state)) {
            this.killNewlineForward();
        }
        buffer.notifyChange();
    }

    deleteWordBackward(): void {
        const { buffer } = this;
        const { state } = buffer;
        this.buffer.beginEdit();
        if (state.cursorCol > 0) {
            buffer.pushUndoSnapshot();
            const end = state.cursorCol;
            const start = buffer.wordStartBefore(end);
            this.kill(currentLine(state).slice(start, end), "backward");
            deleteInLine(state, start, end);
            buffer.setCursorCol(start);
        } else if (state.cursorLine > 0) {
            this.killNewlineBackward();
        }
        buffer.notifyChange();
    }

    deleteWordForward(): void {
        const { buffer } = this;
        const { state } = buffer;
        this.buffer.beginEdit();
        const line = currentLine(state);
        if (state.cursorCol < line.length) {
            buffer.pushUndoSnapshot();
            const start = state.cursorCol;
            const end = buffer.wordEndAfter(start);
            this.kill(line.slice(start, end), "forward");
            deleteInLine(state, start, end);
            buffer.setCursorCol(start);
        } else if (!isLastLine(state)) {
            this.killNewlineForward();
        }
        buffer.notifyChange();
    }

    /** Yank (paste) the most recent kill ring entry at cursor position. */
    yank(): void {
        if (this.killRing.length === 0) return;
        this.buffer.pushUndoSnapshot();
        this.insertYanked(this.killRing.peek()!);
        this.buffer.lastAction = "yank";
    }

    /**
     * Cycle through kill ring (only works immediately after yank or yank-pop).
     * Replaces the last yanked text with the previous entry in the ring.
     */
    yankPop(): void {
        if (this.buffer.lastAction !== "yank" || this.killRing.length <= 1) return;
        this.buffer.pushUndoSnapshot();
        // Delete the previously yanked text (still at end of ring before rotation)
        this.deleteYanked();
        this.killRing.rotate();
        this.insertYanked(this.killRing.peek()!);
        this.buffer.lastAction = "yank";
    }

    /** Save deleted text; a kill straight after another kill joins its entry. */
    private kill(text: string, direction: "backward" | "forward"): void {
        this.killRing.push(text, { prepend: direction === "backward", accumulate: this.buffer.lastAction === "kill" });
        this.buffer.lastAction = "kill";
    }

    /** At the start of a line: join it onto the previous one, killing the newline. */
    private killNewlineBackward(): void {
        this.buffer.pushUndoSnapshot();
        this.kill("\n", "backward");
        this.buffer.setCursorCol(joinWithPreviousLine(this.buffer.state));
    }

    /** At the end of a line: join the next one on, killing the newline. */
    private killNewlineForward(): void {
        this.buffer.pushUndoSnapshot();
        this.kill("\n", "forward");
        joinWithNextLine(this.buffer.state);
    }

    private insertYanked(text: string): void {
        this.buffer.beginEdit();
        this.buffer.setCursorCol(insertAtCursor(this.buffer.state, text));
        this.buffer.notifyChange();
    }

    /**
     * Delete the previously yanked text (used by yank-pop). The cursor sits at
     * the end of it, and it is still the newest kill ring entry.
     */
    private deleteYanked(): void {
        const yankedText = this.killRing.peek();
        if (!yankedText) return;
        const { state } = this.buffer;
        const yankLines = yankedText.split("\n");
        if (yankLines.length === 1) {
            const start = state.cursorCol - yankedText.length;
            deleteInLine(state, start, state.cursorCol);
            this.buffer.setCursorCol(start);
        } else {
            const startLine = state.cursorLine - (yankLines.length - 1);
            const startCol = (state.lines[startLine] || "").length - (yankLines[0] || "").length;
            const afterCursor = currentLine(state).slice(state.cursorCol);
            const beforeYank = (state.lines[startLine] || "").slice(0, startCol);
            state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);
            state.cursorLine = startLine;
            this.buffer.setCursorCol(startCol);
        }
        this.buffer.notifyChange();
    }
}
