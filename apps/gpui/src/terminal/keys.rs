//! A key press as the bytes a shell expects — xterm's encoding, the one
//! loop's xterm.js drawer sends.

use gpui::{Keystroke, Modifiers};

/// xterm's modifier parameter: 1 + shift + 2·alt + 4·ctrl, or None when
/// none are held.
fn modifier_param(modifiers: &Modifiers) -> Option<u8> {
    let param = 1 + modifiers.shift as u8 + 2 * modifiers.alt as u8 + 4 * modifiers.control as u8;
    (param > 1).then_some(param)
}

/// Arrows, Home and End: `CSI 1;m X` with modifiers, `SS3 X` in
/// application-cursor mode, `CSI X` otherwise.
fn cursor_key(letter: char, modifiers: &Modifiers, app_cursor: bool) -> String {
    match modifier_param(modifiers) {
        Some(param) => format!("\x1b[1;{param}{letter}"),
        None if app_cursor => format!("\x1bO{letter}"),
        None => format!("\x1b[{letter}"),
    }
}

/// Page, Delete, Insert and F5+: `CSI n ~`, or `CSI n;m ~` with modifiers.
fn tilde_key(code: u8, modifiers: &Modifiers) -> String {
    match modifier_param(modifiers) {
        Some(param) => format!("\x1b[{code};{param}~"),
        None => format!("\x1b[{code}~"),
    }
}

/// F1–F4: `SS3 P…S`, or `CSI 1;m P…S` with modifiers.
fn low_function_key(letter: char, modifiers: &Modifiers) -> String {
    match modifier_param(modifiers) {
        Some(param) => format!("\x1b[1;{param}{letter}"),
        None => format!("\x1bO{letter}"),
    }
}

fn named_key(key: &str, modifiers: &Modifiers, app_cursor: bool) -> Option<String> {
    let alt = |bytes: &str| if modifiers.alt { format!("\x1b{bytes}") } else { bytes.to_string() };
    Some(match key {
        "enter" => alt("\r"),
        "backspace" if modifiers.control => alt("\x08"),
        "backspace" => alt("\x7f"),
        "tab" if modifiers.shift => "\x1b[Z".into(),
        "tab" => alt("\t"),
        "escape" => alt("\x1b"),
        "up" => cursor_key('A', modifiers, app_cursor),
        "down" => cursor_key('B', modifiers, app_cursor),
        "right" => cursor_key('C', modifiers, app_cursor),
        "left" => cursor_key('D', modifiers, app_cursor),
        "home" => cursor_key('H', modifiers, app_cursor),
        "end" => cursor_key('F', modifiers, app_cursor),
        "insert" => tilde_key(2, modifiers),
        "delete" => tilde_key(3, modifiers),
        "pageup" => tilde_key(5, modifiers),
        "pagedown" => tilde_key(6, modifiers),
        "f1" => low_function_key('P', modifiers),
        "f2" => low_function_key('Q', modifiers),
        "f3" => low_function_key('R', modifiers),
        "f4" => low_function_key('S', modifiers),
        "f5" => tilde_key(15, modifiers),
        "f6" => tilde_key(17, modifiers),
        "f7" => tilde_key(18, modifiers),
        "f8" => tilde_key(19, modifiers),
        "f9" => tilde_key(20, modifiers),
        "f10" => tilde_key(21, modifiers),
        "f11" => tilde_key(23, modifiers),
        "f12" => tilde_key(24, modifiers),
        _ => return None,
    })
}

/// Ctrl+key as the C0 control it names: ctrl-a is 0x01, ctrl-[ is ESC.
fn control_byte(key: &str) -> Option<u8> {
    let [byte] = key.as_bytes() else {
        return (key == "space").then_some(0);
    };
    match byte {
        b'a'..=b'z' => Some(byte - b'a' + 1),
        b'@' | b'2' => Some(0),
        b'[' | b'3' => Some(0x1b),
        b'\\' | b'4' => Some(0x1c),
        b']' | b'5' => Some(0x1d),
        b'^' | b'6' => Some(0x1e),
        b'_' | b'-' | b'7' => Some(0x1f),
        b'?' | b'8' => Some(0x7f),
        _ => None,
    }
}

/// The bytes for `keystroke`, or None when the terminal should leave it
/// alone — ⌘ shortcuts belong to the app.
pub fn to_bytes(keystroke: &Keystroke, app_cursor: bool) -> Option<Vec<u8>> {
    let modifiers = &keystroke.modifiers;
    if modifiers.platform {
        return None;
    }
    if let Some(bytes) = named_key(&keystroke.key, modifiers, app_cursor) {
        return Some(bytes.into_bytes());
    }
    if modifiers.control
        && let Some(byte) = control_byte(&keystroke.key)
    {
        return Some(if modifiers.alt { vec![0x1b, byte] } else { vec![byte] });
    }
    let typed = keystroke.key_char.clone().or_else(|| (keystroke.key == "space").then(|| " ".into()))?;
    Some(typed.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(key: &'static str, app_cursor: bool) -> Option<Vec<u8>> {
        let keystroke = Keystroke::parse(key).unwrap();
        to_bytes(&keystroke, app_cursor)
    }

    #[test]
    fn controls_and_named_keys_encode_like_xterm() {
        assert_eq!(bytes("enter", false).unwrap(), b"\r");
        assert_eq!(bytes("backspace", false).unwrap(), b"\x7f");
        assert_eq!(bytes("ctrl-c", false).unwrap(), b"\x03");
        assert_eq!(bytes("ctrl-[", false).unwrap(), b"\x1b");
        assert_eq!(bytes("shift-tab", false).unwrap(), b"\x1b[Z");
        assert_eq!(bytes("pageup", false).unwrap(), b"\x1b[5~");
        assert_eq!(bytes("f5", false).unwrap(), b"\x1b[15~");
        assert_eq!(bytes("alt-backspace", false).unwrap(), b"\x1b\x7f");
    }

    #[test]
    fn arrows_follow_the_cursor_mode_and_modifiers() {
        assert_eq!(bytes("up", false).unwrap(), b"\x1b[A");
        assert_eq!(bytes("up", true).unwrap(), b"\x1bOA");
        assert_eq!(bytes("shift-left", true).unwrap(), b"\x1b[1;2D");
        assert_eq!(bytes("ctrl-right", false).unwrap(), b"\x1b[1;5C");
    }

    #[test]
    fn command_shortcuts_stay_with_the_app() {
        assert_eq!(bytes("cmd-c", false), None);
        assert_eq!(bytes("cmd-j", false), None);
    }
}
