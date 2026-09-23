/**
 * Canvas wash — a theme that owns its canvas sets the terminal's default
 * background to its `bgBase` via OSC 11 AND the default foreground to its
 * `text` via OSC 10, so the whole screen (not just painted cells) is the
 * theme's. Both must move together: washing only the background left
 * unpainted text at the terminal's own default foreground — white-on-white in
 * a dark terminal running the day theme. OSC 111/110 restore the terminal's
 * own colours on exit, and on a switch to a theme that washes nothing
 * (`system`, whose `bgBase` is the terminal default and so has no hex here).
 */
import { theme } from "./theme";

let washApplied = false;

/** Apply (or re-apply after a theme change) the active theme's wash. */
export function applyCanvasWash(out: NodeJS.WriteStream = process.stdout): void {
    const bg = theme.raw("bgBase");
    if (typeof bg === "string" && bg.startsWith("#")) {
        out.write(`\x1b]11;${bg}\x07`);
        const fg = theme.raw("text");
        if (typeof fg === "string" && fg.startsWith("#")) out.write(`\x1b]10;${fg}\x07`);
        washApplied = true;
    } else if (washApplied) {
        resetCanvasWash(out);
    }
}

/** Restore the terminal's own colors (exit path — safe to call twice). */
export function resetCanvasWash(out: NodeJS.WriteStream = process.stdout): void {
    if (!washApplied) return;
    out.write("\x1b]111\x07");
    out.write("\x1b]110\x07");
    washApplied = false;
}
