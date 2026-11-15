import type { Keybinding, KeybindingsManager } from "../../keybindings";
import { type KeyId, matchesKey } from "../../keys";

/** A key test and what to do when it matches; the editor tries them in order. */
export interface KeyHandler {
    matches(data: string, kb: KeybindingsManager): boolean;
    run(data: string): void;
}

/** Run `run` on a configurable binding, or on a fixed extra key that always means the same. */
export function onKey(binding: Keybinding, run: (data: string) => void, alsoKey?: KeyId): KeyHandler {
    return {
        matches: (data, kb) => kb.matches(data, binding) || (alsoKey !== undefined && matchesKey(data, alsoKey)),
        run,
    };
}

/** Old terminals and tmux send Shift+Enter / Alt+Enter as these raw sequences. */
export function isNewLineKey(data: string, kb: KeybindingsManager): boolean {
    return (
        kb.matches(data, "tui.input.newLine") ||
        (data.charCodeAt(0) === 10 && data.length > 1) ||
        data === "\x1b\r" ||
        data === "\x1b[13;2~" ||
        (data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
        data === "\n"
    );
}
