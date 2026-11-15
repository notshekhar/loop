import { getKeybindings } from "../keybindings";
import { decodeKittyPrintable } from "../keys";
import type { Component, Focusable } from "../tui";
import { type KeyHandler, onKey } from "./editor/key-handlers";
import { BracketedPaste } from "./input/bracketed-paste";
import { InputBuffer } from "./input/buffer";
import { InputKillCommands } from "./input/kill-commands";
import { renderInputLine } from "./input/render";

export interface InputOptions {
    prompt?: string;
    placeholder?: string;
    placeholderStyle?: (text: string) => string;
}

/** C0 (0x00-0x1F), DEL (0x7F) or C1 (0x80-0x9F): never typed as text. */
function hasControlChars(data: string): boolean {
    return [...data].some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    });
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
    private readonly buffer = new InputBuffer();
    private readonly kills = new InputKillCommands(this.buffer);
    private readonly bracketedPaste = new BracketedPaste();
    private readonly prompt: string;
    private readonly placeholder: string;
    private readonly placeholderStyle: (text: string) => string;
    public onSubmit?: (value: string) => void;
    public onEscape?: () => void;

    /** Focusable interface - set by TUI when focus changes */
    focused: boolean = false;

    /** Tried in order; the first match handles the key. */
    private readonly keyHandlers: KeyHandler[] = [
        onKey("tui.select.cancel", () => this.onEscape?.()),
        onKey("tui.editor.undo", () => this.buffer.undo()),
        {
            matches: (data, kb) => kb.matches(data, "tui.input.submit") || data === "\n",
            run: () => this.onSubmit?.(this.buffer.value),
        },
        onKey("tui.editor.deleteCharBackward", () => this.buffer.backspace()),
        onKey("tui.editor.deleteCharForward", () => this.buffer.forwardDelete()),
        onKey("tui.editor.deleteWordBackward", () => this.kills.deleteWordBackward()),
        onKey("tui.editor.deleteWordForward", () => this.kills.deleteWordForward()),
        onKey("tui.editor.deleteToLineStart", () => this.kills.deleteToLineStart()),
        onKey("tui.editor.deleteToLineEnd", () => this.kills.deleteToLineEnd()),
        onKey("tui.editor.yank", () => this.kills.yank()),
        onKey("tui.editor.yankPop", () => this.kills.yankPop()),
        onKey("tui.editor.cursorLeft", () => this.buffer.cursorLeft()),
        onKey("tui.editor.cursorRight", () => this.buffer.cursorRight()),
        onKey("tui.editor.cursorLineStart", () => this.buffer.lineStart()),
        onKey("tui.editor.cursorLineEnd", () => this.buffer.lineEnd()),
        onKey("tui.editor.cursorWordLeft", () => this.buffer.wordLeft()),
        onKey("tui.editor.cursorWordRight", () => this.buffer.wordRight()),
    ];

    constructor(options: InputOptions = {}) {
        this.prompt = options.prompt ?? "> ";
        this.placeholder = options.placeholder ?? "";
        this.placeholderStyle = options.placeholderStyle ?? ((text) => text);
    }

    getValue(): string {
        return this.buffer.value;
    }

    setValue(value: string): void {
        this.buffer.setValue(value);
    }

    handleInput(data: string): void {
        const taken = this.bracketedPaste.take(data);
        if (taken.kind === "buffering") return;
        if (taken.kind === "paste") {
            this.buffer.paste(taken.text);
            // Handle any remaining input after the paste marker
            if (taken.remaining) this.handleInput(taken.remaining);
            return;
        }

        const kb = getKeybindings();
        const handler = this.keyHandlers.find((h) => h.matches(taken.data, kb));
        if (handler) {
            handler.run(taken.data);
            return;
        }
        this.insertTypedText(taken.data);
    }

    invalidate(): void {
        // No cached state to invalidate currently
    }

    render(width: number): string[] {
        const { prompt, placeholder, placeholderStyle, focused } = this;
        const { value, cursor } = this.buffer;
        return [renderInputLine({ prompt, value, cursor, placeholder, placeholderStyle, focused }, width)];
    }

    private insertTypedText(data: string): void {
        // Kitty CSI-u printable character (e.g. \x1b[97u for 'a').
        // Terminals with Kitty protocol flag 1 (disambiguate) send CSI-u for all keys,
        // including plain printable characters. Decode before the control-char check
        // since CSI-u sequences contain \x1b which would be rejected.
        const kittyPrintable = decodeKittyPrintable(data);
        if (kittyPrintable !== undefined) {
            this.buffer.insertCharacter(kittyPrintable);
            return;
        }

        // Regular character input - accept printable characters including Unicode,
        // but reject control characters
        if (!hasControlChars(data)) {
            this.buffer.insertCharacter(data);
        }
    }
}
