use gpui::{App, KeyBinding, actions};

actions!(terminal, [Copy, Paste, NewTerminal, SplitTerminal, SplitTerminalVertical, CloseTerminal]);

/// Context for keys that only apply while a terminal has focus.
pub const CONTEXT: &str = "Terminal";

/// loop's `when: "terminalFocus"` keys (loop/shared/keybindings.ts).
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-c", Copy, Some(CONTEXT)),
        KeyBinding::new("cmd-v", Paste, Some(CONTEXT)),
        KeyBinding::new("cmd-n", NewTerminal, Some(CONTEXT)),
        KeyBinding::new("cmd-d", SplitTerminal, Some(CONTEXT)),
        KeyBinding::new("cmd-shift-d", SplitTerminalVertical, Some(CONTEXT)),
        KeyBinding::new("cmd-w", CloseTerminal, Some(CONTEXT)),
    ]);
}
