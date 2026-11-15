import { UndoStack } from "../../undo-stack";
import { getGraphemeSegmenter, getWordSegmenter, isWhitespaceChar } from "../../utils";
import { findWordBackward, findWordForward } from "../../word-navigation";
import {
    deleteInLine,
    insertAtCursor,
    isLastLine,
    joinWithNextLine,
    joinWithPreviousLine,
    splitLineAtCursor,
    textBeforeCursor,
    currentLine,
} from "./line-edits";
import {
    cleanPastedText,
    expandPasteMarkers,
    isPasteMarker,
    largePasteMarker,
    normalizeText,
    PASTE_MARKER_SINGLE,
    removePaste,
    segmentWithMarkers,
} from "./paste-markers";
import type { EditorSnapshot, EditorState } from "./types";
import { VerticalNavigator } from "./vertical-navigation";

const graphemeSegmenter = getGraphemeSegmenter();
const wordSegmenter = getWordSegmenter();

export type LastAction = "kill" | "yank" | "type-word" | null;

export interface BufferHooks {
    /** The text changed. */
    onChange(text: string): void;
    /** A user edit is about to happen (the editor leaves history browsing). */
    onEdit(): void;
}

/**
 * The editor's text model: lines and cursor, the paste-marker registry, undo,
 * and the basic insert and delete operations. Knows nothing about keys or
 * drawing.
 */
export class EditorBuffer {
    state: EditorState = { lines: [""], cursorLine: 0, cursorCol: 0 };
    /** What the previous edit was, for undo coalescing and kill accumulation. */
    lastAction: LastAction = null;
    readonly navigator = new VerticalNavigator(
        () => this.state,
        (line) => this.graphemes(line),
    );
    private pastes: Map<number, string> = new Map();
    private pasteCounter = 0;
    private undoStack = new UndoStack<EditorSnapshot>();

    constructor(private readonly hooks: BufferHooks) {}

    getText(): string {
        return this.state.lines.join("\n");
    }

    /** The text with paste markers expanded to what was pasted. */
    getExpandedText(): string {
        return expandPasteMarkers(this.getText(), this.pastes);
    }

    /** A user edit is starting (the editor leaves history browsing). */
    beginEdit(): void {
        this.hooks.onEdit();
    }

    notifyChange(): void {
        this.hooks.onChange(this.getText());
    }

    // ---- segmentation ----

    /** Segment text with paste-marker awareness, only merging markers with valid IDs. */
    segment(text: string, mode: "word" | "grapheme"): Iterable<Intl.SegmentData> {
        const base = mode === "word" ? wordSegmenter : graphemeSegmenter;
        return segmentWithMarkers(text, base, new Set(this.pastes.keys()));
    }

    graphemes(text: string): Intl.SegmentData[] {
        return [...this.segment(text, "grapheme")];
    }

    wordStartBefore(col: number): number {
        return findWordBackward(currentLine(this.state), col, {
            segment: (text) => this.segment(text, "word"),
            isAtomicSegment: isPasteMarker,
        });
    }

    wordEndAfter(col: number): number {
        return findWordForward(currentLine(this.state), col, {
            segment: (text) => this.segment(text, "word"),
            isAtomicSegment: isPasteMarker,
        });
    }

    // ---- cursor and whole-text changes ----

    /** Set the cursor column; any non-vertical move forgets the sticky column. */
    setCursorCol(col: number): void {
        this.state.cursorCol = col;
        this.navigator.reset();
    }

    /** Replace the text, cursor at its start or end. Neither undoable nor an edit by itself. */
    load(text: string, cursorPlacement: "start" | "end" = "end"): void {
        const lines = text.split("\n");
        this.state.lines = lines.length === 0 ? [""] : lines;
        this.state.cursorLine = cursorPlacement === "start" ? 0 : this.state.lines.length - 1;
        this.setCursorCol(cursorPlacement === "start" ? 0 : this.state.lines[this.state.cursorLine]?.length || 0);
        this.notifyChange();
    }

    /** Put back a whole earlier state (a history draft). */
    restore(state: EditorState): void {
        this.state = state;
        this.navigator.reset();
        this.notifyChange();
    }

    /** Programmatic setText: undoable if it changes anything; forgets pastes. */
    setText(text: string): void {
        this.lastAction = null;
        this.beginEdit();
        const normalized = normalizeText(text);
        if (this.getText() !== normalized) this.pushUndoSnapshot();
        this.pastes.clear();
        this.pasteCounter = 0;
        this.load(normalized);
    }

    /** Empty everything after a submit: text, pastes and undo history. */
    clear(): void {
        this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
        this.pastes.clear();
        this.pasteCounter = 0;
        this.undoStack.clear();
        this.lastAction = null;
    }

    /** Write a completion's result into the text (undoable). */
    applyCompletion(result: EditorState): void {
        this.pushUndoSnapshot();
        this.lastAction = null;
        this.state.lines = result.lines;
        this.state.cursorLine = result.cursorLine;
        this.setCursorCol(result.cursorCol);
    }

    // ---- undo ----

    pushUndoSnapshot(): void {
        this.undoStack.push({ state: this.state, pastes: this.pastes, pasteCounter: this.pasteCounter });
    }

    undo(): void {
        this.beginEdit();
        const snapshot = this.undoStack.pop();
        if (!snapshot) return;
        Object.assign(this.state, snapshot.state);
        this.pastes = snapshot.pastes;
        this.pasteCounter = snapshot.pasteCounter;
        this.lastAction = null;
        this.navigator.preferredVisualCol = null;
        this.notifyChange();
    }

    // ---- inserting ----

    /**
     * Insert text at the cursor. Does not push an undo snapshot or trigger
     * autocomplete — the caller decides both.
     */
    insertText(text: string): void {
        if (!text) return;
        this.setCursorCol(insertAtCursor(this.state, normalizeText(text)));
        this.notifyChange();
    }

    /** Insert text as one undo step (programmatic insertion, e.g. clipboard image markers). */
    insertTextAsOneStep(text: string): void {
        if (!text) return;
        this.pushUndoSnapshot();
        this.lastAction = null;
        this.beginEdit();
        this.insertText(text);
    }

    /** Insert a typed character, with fish-style undo coalescing. */
    insertCharacter(char: string): void {
        this.beginEdit();
        // Consecutive word chars coalesce into one undo unit; a space captures
        // the state before itself, so undo removes space+following word together.
        if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
            this.pushUndoSnapshot();
        }
        this.lastAction = "type-word";
        this.setCursorCol(insertAtCursor(this.state, char));
        this.notifyChange();
    }

    /** Insert a paste as one undo step; a large one is stored and shown as a marker. */
    paste(raw: string): void {
        this.beginEdit();
        this.lastAction = null;
        this.pushUndoSnapshot();

        let text = cleanPastedText(raw);
        // A pasted file path right after a word char gets a separating space, for readability.
        if (/^[/~.]/.test(text)) {
            const charBeforeCursor = this.state.cursorCol > 0 ? currentLine(this.state)[this.state.cursorCol - 1] : "";
            if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
                text = ` ${text}`;
            }
        }
        const marker = largePasteMarker(this.pasteCounter + 1, text);
        if (marker) {
            this.pasteCounter++;
            this.pastes.set(this.pasteCounter, text);
        }
        this.insertText(marker ?? text);
    }

    newLine(): void {
        this.beginEdit();
        this.lastAction = null;
        this.pushUndoSnapshot();
        this.setCursorCol(splitLineAtCursor(this.state));
        this.notifyChange();
    }

    // ---- deleting ----

    /** Delete the grapheme before the cursor, or join with the previous line. */
    backspace(): void {
        this.beginEdit();
        this.lastAction = null;
        if (this.state.cursorCol > 0) {
            this.pushUndoSnapshot();
            this.deleteGraphemeBeforeCursor();
        } else if (this.state.cursorLine > 0) {
            this.pushUndoSnapshot();
            this.setCursorCol(joinWithPreviousLine(this.state));
        }
        this.notifyChange();
    }

    /** Delete the grapheme at the cursor, or join the next line on. */
    forwardDelete(): void {
        this.beginEdit();
        this.lastAction = null;
        const line = currentLine(this.state);
        if (this.state.cursorCol < line.length) {
            this.pushUndoSnapshot();
            const first = this.graphemes(line.slice(this.state.cursorCol))[0];
            deleteInLine(this.state, this.state.cursorCol, this.state.cursorCol + (first ? first.segment.length : 1));
        } else if (!isLastLine(this.state)) {
            this.pushUndoSnapshot();
            joinWithNextLine(this.state);
        }
        this.notifyChange();
    }

    charBeforeCursorIsBackslash(): boolean {
        return this.state.cursorCol > 0 && currentLine(this.state)[this.state.cursorCol - 1] === "\\";
    }

    /** Handles emoji and combining marks; a whole paste marker goes at once and its paste is forgotten. */
    private deleteGraphemeBeforeCursor(): void {
        const graphemes = this.graphemes(textBeforeCursor(this.state));
        const lastGrapheme = graphemes[graphemes.length - 1];
        const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
        const marker = PASTE_MARKER_SINGLE.exec(lastGrapheme.segment);
        if (marker) {
            // marker[1] is the id, e.g. 4 from [paste #4 +123 lines]
            this.state.lines = removePaste(this.state.lines, this.pastes, Number(marker[1]));
            this.pasteCounter--;
        }
        deleteInLine(this.state, this.state.cursorCol - graphemeLength, this.state.cursorCol);
        this.setCursorCol(this.state.cursorCol - graphemeLength);
    }
}
