import { isKittyProtocolActive, matchesKey } from "@notshekhar/loop-tui";

export const CTRL_C = "\x03";
export const CTRL_D = "\x04";
export const ESC = "\x1b";

export const isCtrlC = (d: string) => d === CTRL_C || matchesKey(d, "ctrl+c");
export const isCtrlD = (d: string) => d === CTRL_D || matchesKey(d, "ctrl+d");
export const isCtrlL = (d: string) => d === "\x0c" || matchesKey(d, "ctrl+l");
/**
 * Ctrl+E — the nav-mode toggle, and the ONE chord that must not be confused
 * with a terminal macro.
 *
 * macOS terminals ship the readline line-navigation bindings by default:
 * Ghostty binds `cmd+left`/`cmd+right` to `text:\x01`/`text:\x05`, i.e. the
 * literal control BYTE. Legacy ctrl+e is that same byte, so under a plain
 * matcher `cmd+→` and `ctrl+e` are indistinguishable — which is exactly how
 * `cmd+→` ended up flinging people into nav mode.
 *
 * They ARE separable once the kitty keyboard protocol is negotiated: a real
 * ctrl+e then arrives as a CSI-u sequence (`\x1b[101;5u`), and ONLY a
 * terminal `text:` macro still sends the raw byte. So when kitty is active,
 * require the CSI-u form; when it isn't (dumb terminals, no negotiation),
 * fall back to the raw byte or ctrl+e breaks entirely.
 */
export const isCtrlE = (d: string) =>
    isKittyProtocolActive() ? matchesKey(d, "ctrl+e") && d !== "\x05" : d === "\x05" || matchesKey(d, "ctrl+e");
export const isCtrlV = (d: string) => d === "\x16" || matchesKey(d, "ctrl+v");
export const isCtrlG = (d: string) => d === "\x07" || matchesKey(d, "ctrl+g");
export const isCtrlP = (d: string) => d === "\x10" || matchesKey(d, "ctrl+p");
/** Delete-to-line-start — loop's "clear what I typed" gesture. */
export const isClearLine = (d: string) =>
    d === "\x15" || matchesKey(d, "ctrl+u") || matchesKey(d, "super+backspace");
// NOTE: \x09 is TAB which legacy terminals share with Ctrl+I (i & 0x1f === 9),
// and matchesKey's legacy ctrl+letter branch treats them as the same byte.
// Exclude raw "\t" so only the Kitty-protocol Ctrl+I (a distinct CSI-u
// sequence) matches — otherwise plain Tab would fire the image picker instead
// of falling through to autocomplete.
export const isCtrlI = (d: string) => d !== "\t" && matchesKey(d, "ctrl+i");
export const isEsc = (d: string) => d === ESC || matchesKey(d, "escape");
// Block-selection navigation (chat history foldables). `\x1b[1;5A/B` are the
// classic xterm ctrl+arrow encodings; matchesKey covers Kitty-protocol forms.
export const isCtrlUp = (d: string) => d === "\x1b[1;5A" || matchesKey(d, "ctrl+up");
export const isCtrlDown = (d: string) => d === "\x1b[1;5B" || matchesKey(d, "ctrl+down");
// Turn jumps. `\x1b[1;3A/B` = xterm alt+arrow; `\x1b\x1b[A/B` = ESC-prefix
// terminals (Apple Terminal's default alt handling).
export const isAltUp = (d: string) => d === "\x1b[1;3A" || d === "\x1b\x1b[A" || matchesKey(d, "alt+up");
export const isAltDown = (d: string) => d === "\x1b[1;3B" || d === "\x1b\x1b[B" || matchesKey(d, "alt+down");
// Scrollback-focus navigation (plain keys — only read while focus mode is on).
export const isUp = (d: string) => d === "\x1b[A" || matchesKey(d, "up");
export const isDown = (d: string) => d === "\x1b[B" || matchesKey(d, "down");
export const isLeft = (d: string) => d === "\x1b[D" || matchesKey(d, "left");
export const isRight = (d: string) => d === "\x1b[C" || matchesKey(d, "right");
export const isShiftLeft = (d: string) => d === "\x1b[1;2D" || matchesKey(d, "shift+left");
export const isShiftRight = (d: string) => d === "\x1b[1;2C" || matchesKey(d, "shift+right");
export const isEnter = (d: string) => d === "\r" || d === "\n" || matchesKey(d, "enter");
/** Printable text input (letter-key auto-focus back to the prompt). Covers
 * multi-codeunit graphemes too — emoji/IME commits arrive as one chunk and
 * must exit nav mode the same way a plain letter does. Anything starting
 * with ESC (chords, mouse reports) or a control byte is not text. */
export const isPrintableChar = (d: string) => {
    if (d.length === 0) return false;
    if (d.length === 1) return d >= " " && d !== "\x7f";
    return d.charCodeAt(0) >= 0x20 && d.charCodeAt(0) !== 0x7f;
};
// SGR mouse reports (CSI < b ; x ; y M/m) — only requested while nav mode is
// on. Wheel = button 64 (up) / 65 (down); 66/67 are horizontal tilt (skip);
// modifier bits may be OR'd on top, so read bit 64 plus the low direction
// bits. A single stdin chunk can carry several events (fast wheel), so
// scrolling counts every one.
export const MOUSE_SGR_ANY = /^\x1b\[<\d+;\d+;\d+[Mm]/;
const MOUSE_SGR_ALL = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
const MOUSE_X10 = /^\x1b\[M[\s\S]{3}/;
const FOCUS_REPORT = /^\x1b\[[IO]$/;
/** Input that came from the keyboard — a key, a chord, a paste — as opposed to
 * the terminal reporting a pointer event or a focus change. */
export const isKeyboardInput = (d: string) =>
    d.length > 0 && !MOUSE_SGR_ANY.test(d) && !MOUSE_X10.test(d) && !FOCUS_REPORT.test(d);
export function countWheelScroll(d: string): number {
    let delta = 0;
    for (const m of d.matchAll(MOUSE_SGR_ALL)) {
        const button = Number(m[1]);
        if (!(button & 64)) continue;
        const dir = button & 3;
        if (dir === 0) delta -= 1;
        else if (dir === 1) delta += 1;
    }
    return delta;
}
export const isPageUp = (d: string) => d === "\x1b[5~" || matchesKey(d, "pageUp");
export const isPageDown = (d: string) => d === "\x1b[6~" || matchesKey(d, "pageDown");
export const isHome = (d: string) => d === "\x1b[H" || d === "\x1b[1~" || matchesKey(d, "home");
export const isEnd = (d: string) => d === "\x1b[F" || d === "\x1b[4~" || matchesKey(d, "end");
export const isTab = (d: string) => d === "\t" || matchesKey(d, "tab");
export const isShiftTab = (d: string) => d === "\x1b[Z" || matchesKey(d, "shift+tab");
