import type { AutocompleteItem, AutocompleteProvider } from "../autocomplete";
import type { Component, Focusable } from "../component";
import { getKeybindings, type KeybindingsManager } from "../keybindings";
import { decodePrintableKey, matchesKey } from "../keys";
import type { TUI } from "../tui";
import { clampMaxVisible, EditorAutocomplete } from "./editor/autocomplete";
import { EditorBuffer } from "./editor/buffer";
import { CursorMotion } from "./editor/cursor-motion";
import { PromptHistory } from "./editor/history";
import { type KeyHandler, isNewLineKey, onKey } from "./editor/key-handlers";
import { KillCommands } from "./editor/kill-commands";
import {
    createScrollBorder,
    editorBox,
    type LayoutLine,
    layoutText,
    plainRowStyle,
    renderRow,
    slashCommandTint,
} from "./editor/layout";
import { textBeforeCursor } from "./editor/line-edits";
import { editorPageSize, type EditorOptions, type EditorTheme } from "./editor/types";

export type { EditorOptions, EditorTheme } from "./editor/types";
export { type TextChunk, wordWrapLine } from "./editor/word-wrap";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const DEFAULT_COMMAND_COLOR = (str: string) => `\x1b[36m${str}\x1b[39m`;

/**
 * The prompt editor component: draws the text box, turns keys into editing
 * commands, and hosts prompt history and the completion list. The text
 * itself lives in an EditorBuffer.
 */
export class Editor implements Component, Focusable {
    /** Focusable interface - set by TUI when focus changes */
    focused: boolean = false;

    protected tui: TUI;
    // Border color (can be changed dynamically)
    public borderColor: (str: string) => string;
    public onSubmit?: (text: string) => void;
    public onChange?: (text: string) => void;
    public disableSubmit: boolean = false;

    private paddingX: number = 0;
    private scrollOffset: number = 0;
    private commandColor: (str: string) => string;
    /** Someone else draws the completion list; see setPopupHosted. */
    private popupHosted = false;
    // Bracketed paste mode buffering
    private pasteBuffer: string = "";
    private isInPaste: boolean = false;
    // Character jump mode
    private jumpMode: "forward" | "backward" | null = null;

    private readonly history = new PromptHistory();
    private readonly buffer = new EditorBuffer({
        onChange: (text) => this.onChange?.(text),
        onEdit: () => this.history.exit(),
    });
    private readonly kills = new KillCommands(this.buffer);
    private readonly motion = new CursorMotion(this.buffer, () => this.tui.terminal.rows);
    private readonly autocomplete: EditorAutocomplete;

    /** Ordered: the first handler whose key matches runs. */
    private readonly keyHandlers: KeyHandler[] = [
        onKey("tui.editor.deleteToLineEnd", () => this.kills.deleteToLineEnd()),
        onKey("tui.editor.deleteToLineStart", () => this.kills.deleteToLineStart()),
        onKey("tui.editor.deleteWordBackward", () => this.kills.deleteWordBackward()),
        onKey("tui.editor.deleteWordForward", () => this.kills.deleteWordForward()),
        onKey("tui.editor.deleteCharBackward", () => this.backspace(), "shift+backspace"),
        onKey("tui.editor.deleteCharForward", () => this.forwardDelete(), "shift+delete"),
        onKey("tui.editor.yank", () => this.kills.yank()),
        onKey("tui.editor.yankPop", () => this.kills.yankPop()),
        // Dedicated history actions always browse entries instead of moving the cursor.
        onKey("tui.editor.historyPrevious", () => this.browseHistory(-1)),
        onKey("tui.editor.historyNext", () => this.browseHistory(1)),
        onKey("tui.editor.cursorLineStart", () => this.motion.lineStart()),
        onKey("tui.editor.cursorLineEnd", () => this.motion.lineEnd()),
        onKey("tui.editor.cursorWordLeft", () => this.motion.wordLeft()),
        onKey("tui.editor.cursorWordRight", () => this.motion.wordRight()),
        { matches: isNewLineKey, run: (data) => this.handleNewLineKey(data) },
        onKey("tui.input.submit", () => this.handleSubmitKey()),
        onKey("tui.editor.cursorUp", () => this.handleCursorUp()),
        onKey("tui.editor.cursorDown", () => this.handleCursorDown()),
        onKey("tui.editor.cursorRight", () => this.moveAndRefresh(() => this.motion.right())),
        onKey("tui.editor.cursorLeft", () => this.moveAndRefresh(() => this.motion.left())),
        // Cmd+Up / Cmd+Down (mac): start / end of the whole input.
        onKey("tui.editor.cursorDocStart", () => this.motion.docStart()),
        onKey("tui.editor.cursorDocEnd", () => this.motion.docEnd()),
        onKey("tui.editor.pageUp", () => this.motion.page(-1)),
        onKey("tui.editor.pageDown", () => this.motion.page(1)),
        onKey("tui.editor.jumpForward", () => (this.jumpMode = "forward")),
        onKey("tui.editor.jumpBackward", () => (this.jumpMode = "backward")),
        // Shift+Space - insert regular space
        { matches: (data) => matchesKey(data, "shift+space"), run: () => this.insertCharacter(" ") },
    ];

    constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
        this.tui = tui;
        this.borderColor = theme.borderColor;
        this.commandColor = theme.commandColor ?? DEFAULT_COMMAND_COLOR;
        this.paddingX = clampPadding(options.paddingX ?? 0);
        const buffer = this.buffer;
        this.autocomplete = new EditorAutocomplete(
            {
                // A getter: the state object is replaced wholesale on submit and history restore.
                get state() {
                    return buffer.state;
                },
                getText: () => buffer.getText(),
                applyCompletion: (item, prefix) => this.applyCompletion(item, prefix),
                notifyChange: () => buffer.notifyChange(),
                requestRender: () => this.tui.requestRender(),
            },
            theme.selectList,
            clampMaxVisible(options.autocompleteMaxVisible ?? 5),
        );
    }

    // ---- public API ----

    getPaddingX(): number {
        return this.paddingX;
    }

    setPaddingX(padding: number): void {
        const newPadding = clampPadding(padding);
        if (this.paddingX !== newPadding) {
            this.paddingX = newPadding;
            this.tui.requestRender();
        }
    }

    getAutocompleteMaxVisible(): number {
        return this.autocomplete.maxVisible;
    }

    setAutocompleteMaxVisible(maxVisible: number): void {
        const newMaxVisible = clampMaxVisible(maxVisible);
        if (this.autocomplete.maxVisible !== newMaxVisible) {
            this.autocomplete.maxVisible = newMaxVisible;
            this.tui.requestRender();
        }
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        this.autocomplete.setProvider(provider);
    }

    public isShowingAutocomplete(): boolean {
        return this.autocomplete.isShowing();
    }

    /**
     * Add a prompt to history for up/down arrow navigation.
     * Called after successful submission.
     */
    addToHistory(text: string): void {
        this.history.add(text);
    }

    invalidate(): void {
        // No cached state to invalidate currently
    }

    getText(): string {
        return this.buffer.getText();
    }

    /**
     * Get text with paste markers expanded to their actual content.
     * Use this when you need the full content (e.g., for external editor).
     */
    getExpandedText(): string {
        return this.buffer.getExpandedText();
    }

    getLines(): string[] {
        return [...this.buffer.state.lines];
    }

    getCursor(): { line: number; col: number } {
        return { line: this.buffer.state.cursorLine, col: this.buffer.state.cursorCol };
    }

    setText(text: string): void {
        this.autocomplete.cancel();
        // Reset scroll - render() will adjust to show cursor
        this.scrollOffset = 0;
        this.buffer.setText(text);
    }

    /**
     * Insert text at the current cursor position.
     * Used for programmatic insertion (e.g., clipboard image markers).
     * This is atomic for undo - single undo restores entire pre-insert state.
     */
    insertTextAtCursor(text: string): void {
        if (!text) return;
        this.autocomplete.cancel();
        this.buffer.insertTextAsOneStep(text);
    }

    /**
     * Hand the completion list to a host that will draw it (see
     * renderAutocompletePopup). The editor stops appending it to its own
     * output; everything else about it — the keys, the filtering, applying a
     * completion — is unchanged.
     */
    setPopupHosted(hosted: boolean): void {
        this.popupHosted = hosted;
    }

    // ---- rendering ----

    render(width: number): string[] {
        const box = editorBox(width, this.paddingX);
        // Layout width: with padding the cursor can overflow into it,
        // without padding we reserve 1 column for the cursor.
        this.motion.layoutWidth = Math.max(1, box.contentWidth - (box.paddingX ? 0 : 1));

        const layoutLines = layoutText(this.buffer.state, this.motion.layoutWidth, (line) =>
            this.buffer.graphemes(line),
        );
        const visibleLines = this.scrollToCursor(layoutLines);
        const firstLine = this.buffer.state.lines[0] ?? "";
        const rows = visibleLines.map((row, index) =>
            renderRow(row, {
                box,
                tint: slashCommandTint(firstLine, this.commandColor, this.scrollOffset + index === 0),
                // Emit the hardware cursor marker when focused so the TUI can
                // place the IME candidate window, even while a menu is open.
                showCursorMarker: this.focused,
                firstGrapheme: (text) => this.buffer.graphemes(text)[0]?.segment || "",
            }),
        );
        const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
        // Add autocomplete list if active — unless someone else is drawing it.
        const popup = this.popupHosted ? [] : this.renderAutocompletePopup(width);
        return [this.border("↑", this.scrollOffset, width), ...rows, this.border("↓", linesBelow, width), ...popup];
    }

    /** A plain rule, or one saying how many rows are scrolled out of sight that way. */
    private border(direction: "↑" | "↓", hidden: number, width: number): string {
        return hidden > 0
            ? this.borderColor(createScrollBorder(direction, hidden, width))
            : this.borderColor("─").repeat(width);
    }

    /** Adjust the scroll offset so the cursor's row is visible, and return the rows on screen. */
    private scrollToCursor(layoutLines: LayoutLine[]): LayoutLine[] {
        const maxVisibleLines = editorPageSize(this.tui.terminal.rows);
        const cursorLineIndex = Math.max(
            0,
            layoutLines.findIndex((line) => line.hasCursor),
        );
        if (cursorLineIndex < this.scrollOffset) {
            this.scrollOffset = cursorLineIndex;
        } else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
            this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
        }
        const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
        this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));
        return layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
    }

    /**
     * The completion list's rows, for a host that draws them itself.
     *
     * Appended to the editor's own output, the list makes the editor — and so
     * the whole frame — taller for as long as it is open, and a frame that
     * fills the screen pays for that by scrolling: the rows at the top go into
     * the scrollback, where they are committed and cannot be taken back. One
     * `/` typed and deleted is enough to leave a blank band behind. A host
     * that paints these rows OVER the frame costs it no height at all.
     *
     * Empty when the list is not up, so a host can keep asking every frame.
     */
    renderAutocompletePopup(width: number): string[] {
        const list = this.autocomplete.openList;
        if (!list) return [];
        const box = editorBox(width, this.paddingX);
        // A rule across the top, in the editor's own border style — but only
        // when a host is drawing these rows. Appended below the editor the
        // list needs none: the editor's bottom border is already the line
        // between them, and a second rule under it just doubles it up. A host
        // paints the list ABOVE the editor, straight onto the conversation,
        // where it has no edge of its own.
        const rule = this.popupHosted ? [this.borderColor("─".repeat(width))] : [];
        const rows = list
            .render(box.contentWidth)
            .map((line) => renderRow({ text: line, hasCursor: false }, plainRowStyle(box)));
        return [...rule, ...rows];
    }

    // ---- input ----

    handleInput(data: string): void {
        const kb = getKeybindings();
        if (this.jumpMode !== null && this.handleJumpKey(data, kb)) return;

        const input = this.takeBracketedPaste(data);
        if (input === undefined) return;

        // Ctrl+C - let parent handle (exit/clear)
        if (kb.matches(input, "tui.input.copy")) return;
        if (kb.matches(input, "tui.editor.undo")) {
            this.buffer.undo();
            return;
        }
        if (this.autocomplete.openList && this.handleAutocompleteKey(input, kb)) return;
        if (kb.matches(input, "tui.input.tab") && !this.autocomplete.isShowing()) {
            this.autocomplete.handleTab(textBeforeCursor(this.buffer.state));
            return;
        }
        const handler = this.keyHandlers.find((h) => h.matches(input, kb));
        if (handler) {
            handler.run(input);
            return;
        }
        this.insertTypedText(input);
    }

    /** Waiting for the character to jump to. True when the key was used up. */
    private handleJumpKey(data: string, kb: KeybindingsManager): boolean {
        const direction = this.jumpMode!;
        this.jumpMode = null;
        // Pressing the hotkey again cancels.
        if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) return true;
        const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
        if (printable === undefined) return false; // a control key cancels and is handled normally
        this.motion.jumpTo(printable, direction);
        return true;
    }

    /**
     * Buffer bracketed-paste input until the end marker arrives, then paste it
     * in one go. Returns the input left to handle as keys, or undefined.
     */
    private takeBracketedPaste(data: string): string | undefined {
        let input = data;
        if (input.includes(BRACKETED_PASTE_START)) {
            this.isInPaste = true;
            this.pasteBuffer = "";
            input = input.replace(BRACKETED_PASTE_START, "");
        }
        if (!this.isInPaste) return input;

        this.pasteBuffer += input;
        const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
        if (endIndex === -1) return undefined;
        const pasteContent = this.pasteBuffer.substring(0, endIndex);
        if (pasteContent.length > 0) {
            this.autocomplete.cancel();
            this.buffer.paste(pasteContent);
        }
        this.isInPaste = false;
        const remaining = this.pasteBuffer.substring(endIndex + BRACKETED_PASTE_END.length);
        this.pasteBuffer = "";
        if (remaining.length > 0) this.handleInput(remaining);
        return undefined;
    }

    /** Keys that drive an open completion list. True when the key was used up. */
    private handleAutocompleteKey(data: string, kb: KeybindingsManager): boolean {
        const list = this.autocomplete.openList!;
        if (kb.matches(data, "tui.select.cancel")) {
            this.autocomplete.cancel();
            return true;
        }
        if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
            list.handleInput(data);
            return true;
        }
        const isTab = kb.matches(data, "tui.input.tab");
        if (!isTab && !kb.matches(data, "tui.select.confirm")) return false;

        const selected = list.getSelectedItem();
        if (!selected || !this.autocomplete.currentProvider) return isTab;
        const prefix = this.autocomplete.prefix;
        this.applyCompletion(selected, prefix);
        this.autocomplete.cancel();
        // Enter on a slash command completes it AND submits it.
        if (!isTab && prefix.startsWith("/")) return false;
        this.buffer.notifyChange();
        return true;
    }

    private applyCompletion(item: AutocompleteItem, prefix: string): void {
        const { lines, cursorLine, cursorCol } = this.buffer.state;
        const provider = this.autocomplete.currentProvider!;
        this.buffer.applyCompletion(provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix));
    }

    private insertTypedText(data: string): void {
        const printable = decodePrintableKey(data);
        if (printable !== undefined) {
            this.insertCharacter(printable);
        } else if (data.charCodeAt(0) >= 32) {
            this.insertCharacter(data);
        }
    }

    private insertCharacter(char: string): void {
        this.buffer.insertCharacter(char);
        this.autocomplete.onCharacterTyped(char, textBeforeCursor(this.buffer.state));
    }

    private backspace(): void {
        this.buffer.backspace();
        this.autocomplete.onTextDeleted(textBeforeCursor(this.buffer.state));
    }

    private forwardDelete(): void {
        this.buffer.forwardDelete();
        this.autocomplete.onTextDeleted(textBeforeCursor(this.buffer.state));
    }

    private addNewLine(): void {
        this.autocomplete.cancel();
        this.buffer.newLine();
    }

    private handleNewLineKey(data: string): void {
        if (this.shouldSubmitOnBackslashEnter(data, getKeybindings())) {
            this.backspace();
            this.submitValue();
            return;
        }
        this.addNewLine();
    }

    private handleSubmitKey(): void {
        if (this.disableSubmit) return;
        // Workaround for terminals without Shift+Enter support:
        // If char before cursor is \, delete it and insert newline instead of submitting.
        if (this.buffer.charBeforeCursorIsBackslash()) {
            this.backspace();
            this.addNewLine();
            return;
        }
        this.submitValue();
    }

    private shouldSubmitOnBackslashEnter(data: string, kb: KeybindingsManager): boolean {
        if (this.disableSubmit) return false;
        if (!matchesKey(data, "enter")) return false;
        const submitKeys = kb.getKeys("tui.input.submit");
        const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
        return hasShiftEnter && this.buffer.charBeforeCursorIsBackslash();
    }

    private submitValue(): void {
        this.autocomplete.cancel();
        const result = this.buffer.getExpandedText().trim();
        this.buffer.clear();
        this.history.exit();
        this.scrollOffset = 0;
        if (this.onChange) this.onChange("");
        if (this.onSubmit) this.onSubmit(result);
    }

    // ---- cursor and history ----

    /**
     * Keep an open autocomplete picker in sync with the new cursor position:
     * a picker computed for the old position is stale. Re-querying refreshes
     * it — or closes it when the new position yields no suggestions. Without
     * this, arrowing left from `/cmd ` back into the command name leaves the
     * argument picker showing against a `/cmd` prefix (and a Tab there would
     * concatenate the stale suggestion onto the partial command name).
     */
    private moveAndRefresh(move: () => void): void {
        move();
        this.autocomplete.update();
    }

    /**
     * Readline/zsh behavior: Up on the FIRST visual line always steps into
     * prompt history, wherever the column is — line-start is one Cmd/Home
     * away instead.
     */
    private handleCursorUp(): void {
        if (this.motion.isOnFirstRow()) this.navigateHistory(-1);
        else this.moveAndRefresh(() => this.motion.vertical(-1));
    }

    private handleCursorDown(): void {
        const onLastRow = this.motion.isOnLastRow();
        if (this.history.isBrowsing && onLastRow) this.navigateHistory(1);
        else if (onLastRow)
            this.motion.lineEnd(); // already at bottom - jump to end of line
        else this.moveAndRefresh(() => this.motion.vertical(1));
    }

    private browseHistory(direction: 1 | -1): void {
        this.autocomplete.cancel();
        this.navigateHistory(direction);
    }

    private navigateHistory(direction: 1 | -1): void {
        this.buffer.lastAction = null;
        const step = this.history.step(direction, this.buffer.state);
        if (!step) return;
        this.scrollOffset = 0;
        if (step.kind === "entry") {
            if (step.entered) this.buffer.pushUndoSnapshot();
            this.buffer.load(step.text, direction === -1 ? "start" : "end");
        } else if (step.draft) {
            this.buffer.restore(step.draft);
        } else {
            this.buffer.load("");
        }
    }
}

function clampPadding(padding: number): number {
    return Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
}
