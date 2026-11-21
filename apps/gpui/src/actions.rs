use gpui::{App, KeyBinding, actions};

actions!(loop_gpui, [Quit, ToggleSidebar, ReloadThreads, NewThread, OpenInEditor, ToggleTerminal]);

/// loop desktop's keys (⌘B sidebar, ⌘O open in the preferred editor, ⌘J
/// terminal drawer).
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-b", ToggleSidebar, None),
        KeyBinding::new("cmd-r", ReloadThreads, None),
        KeyBinding::new("cmd-n", NewThread, None),
        KeyBinding::new("cmd-o", OpenInEditor, None),
        KeyBinding::new("cmd-j", ToggleTerminal, None),
    ]);
    crate::ui::text_input::bind_keys(cx);
    crate::ui::composer::bind_keys(cx);
    crate::ui::terminal::actions::bind_keys(cx);
}
