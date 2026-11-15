import type { EditorState } from "./types";

/**
 * Plain line edits on editor state. Each one changes `lines` and, where the
 * cursor changes line, `cursorLine`; the new cursor COLUMN is returned for the
 * caller to set, since setting it also resets sticky-column bookkeeping.
 */

export function currentLine(state: EditorState): string {
    return state.lines[state.cursorLine] || "";
}

export function textBeforeCursor(state: EditorState): string {
    return currentLine(state).slice(0, state.cursorCol);
}

/** Insert (possibly multi-line) text at the cursor. Returns the column after it. */
export function insertAtCursor(state: EditorState, text: string): number {
    const inserted = text.split("\n");
    const line = currentLine(state);
    const before = line.slice(0, state.cursorCol);
    const after = line.slice(state.cursorCol);
    if (inserted.length === 1) {
        state.lines[state.cursorLine] = before + text + after;
        return state.cursorCol + text.length;
    }
    const last = inserted[inserted.length - 1] || "";
    state.lines = [
        ...state.lines.slice(0, state.cursorLine),
        before + inserted[0],
        ...inserted.slice(1, -1),
        last + after,
        ...state.lines.slice(state.cursorLine + 1),
    ];
    state.cursorLine += inserted.length - 1;
    return last.length;
}

/** Split the line at the cursor; the cursor goes to the start of the new line. */
export function splitLineAtCursor(state: EditorState): number {
    const line = currentLine(state);
    state.lines[state.cursorLine] = line.slice(0, state.cursorCol);
    state.lines.splice(state.cursorLine + 1, 0, line.slice(state.cursorCol));
    state.cursorLine++;
    return 0;
}

/** Join the cursor's line onto the previous one. Returns the column at the join. */
export function joinWithPreviousLine(state: EditorState): number {
    const previous = state.lines[state.cursorLine - 1] || "";
    state.lines[state.cursorLine - 1] = previous + currentLine(state);
    state.lines.splice(state.cursorLine, 1);
    state.cursorLine--;
    return previous.length;
}

/** Join the next line onto the cursor's line; the cursor stays put. */
export function joinWithNextLine(state: EditorState): void {
    const next = state.lines[state.cursorLine + 1] || "";
    state.lines[state.cursorLine] = currentLine(state) + next;
    state.lines.splice(state.cursorLine + 1, 1);
}

/** Remove columns [from, to) of the cursor's line. */
export function deleteInLine(state: EditorState, from: number, to: number): void {
    const line = currentLine(state);
    state.lines[state.cursorLine] = line.slice(0, from) + line.slice(to);
}

export function isFirstLine(state: EditorState): boolean {
    return state.cursorLine === 0;
}

export function isLastLine(state: EditorState): boolean {
    return state.cursorLine >= state.lines.length - 1;
}
