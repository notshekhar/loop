import type { SelectListTheme } from "../select-list";

export interface EditorState {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
}

/** Undo snapshot: editor text state plus the paste registry. */
export interface EditorSnapshot {
    state: EditorState;
    pastes: Map<number, string>;
    pasteCounter: number;
}

export interface EditorTheme {
    borderColor: (str: string) => string;
    selectList: SelectListTheme;
    /** Tint applied to a leading `/command` token as it is typed. Defaults to
     * plain cyan so an embedder that does not theme the composer still gets
     * the highlight. */
    commandColor?: (str: string) => string;
}

export interface EditorOptions {
    paddingX?: number;
    autocompleteMaxVisible?: number;
}

/** Splits text into graphemes or words, treating paste markers as one unit. */
export type Segmenter = (text: string, mode: "word" | "grapheme") => Iterable<Intl.SegmentData>;

/** The editor's visible height: 30% of the terminal, never under 5 rows. Also one page for PageUp/PageDown. */
export function editorPageSize(terminalRows: number): number {
    return Math.max(5, Math.floor(terminalRows * 0.3));
}
