import { UndoStack } from "../../undo-stack";
import { getGraphemeSegmenter, isWhitespaceChar } from "../../utils";
import { findWordBackward, findWordForward } from "../../word-navigation";

const segmenter = getGraphemeSegmenter();

interface InputState {
    value: string;
    cursor: number;
}

/** What the last edit was; decides undo coalescing, kill accumulation and yank-pop. */
export type InputLastAction = "kill" | "yank" | "type-word" | null;

/**
 * The single-line input's text, cursor and undo history, with every edit and
 * cursor move that isn't a kill or yank.
 */
export class InputBuffer {
    value: string = "";
    cursor: number = 0; // Cursor position in the value
    lastAction: InputLastAction = null;
    private undoStack = new UndoStack<InputState>();

    setValue(value: string): void {
        this.value = value;
        this.cursor = Math.min(this.cursor, value.length);
    }

    pushUndo(): void {
        this.undoStack.push({ value: this.value, cursor: this.cursor });
    }

    undo(): void {
        const snapshot = this.undoStack.pop();
        if (!snapshot) return;
        this.value = snapshot.value;
        this.cursor = snapshot.cursor;
        this.lastAction = null;
    }

    /** Insert text at the cursor and move past it (no undo bookkeeping). */
    insertAtCursor(text: string): void {
        this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
        this.cursor += text.length;
    }

    /** Remove [from, to) of the value; the cursor is left for the caller to place. */
    deleteRange(from: number, to: number): void {
        this.value = this.value.slice(0, from) + this.value.slice(to);
    }

    insertCharacter(char: string): void {
        // Undo coalescing: consecutive word chars coalesce into one undo unit
        if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
            this.pushUndo();
        }
        this.lastAction = "type-word";
        this.insertAtCursor(char);
    }

    paste(pastedText: string): void {
        this.lastAction = null;
        this.pushUndo();

        // Clean the pasted text - remove newlines and carriage returns
        const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "    ");
        this.insertAtCursor(cleanText);
    }

    backspace(): void {
        this.lastAction = null;
        if (this.cursor > 0) {
            this.pushUndo();
            const graphemeLength = this.graphemeLengthBefore();
            this.deleteRange(this.cursor - graphemeLength, this.cursor);
            this.cursor -= graphemeLength;
        }
    }

    forwardDelete(): void {
        this.lastAction = null;
        if (this.cursor < this.value.length) {
            this.pushUndo();
            this.deleteRange(this.cursor, this.cursor + this.graphemeLengthAfter());
        }
    }

    cursorLeft(): void {
        this.lastAction = null;
        if (this.cursor > 0) {
            this.cursor -= this.graphemeLengthBefore();
        }
    }

    cursorRight(): void {
        this.lastAction = null;
        if (this.cursor < this.value.length) {
            this.cursor += this.graphemeLengthAfter();
        }
    }

    lineStart(): void {
        this.lastAction = null;
        this.cursor = 0;
    }

    lineEnd(): void {
        this.lastAction = null;
        this.cursor = this.value.length;
    }

    wordLeft(): void {
        if (this.cursor === 0) return;
        this.lastAction = null;
        this.cursor = findWordBackward(this.value, this.cursor);
    }

    wordRight(): void {
        if (this.cursor >= this.value.length) return;
        this.lastAction = null;
        this.cursor = findWordForward(this.value, this.cursor);
    }

    /** Length of the grapheme just before the cursor (1 if none can be found). */
    private graphemeLengthBefore(): number {
        const graphemes = [...segmenter.segment(this.value.slice(0, this.cursor))];
        const lastGrapheme = graphemes[graphemes.length - 1];
        return lastGrapheme ? lastGrapheme.segment.length : 1;
    }

    /** Length of the grapheme at the cursor (1 if none can be found). */
    private graphemeLengthAfter(): number {
        const firstGrapheme = [...segmenter.segment(this.value.slice(this.cursor))][0];
        return firstGrapheme ? firstGrapheme.segment.length : 1;
    }
}
