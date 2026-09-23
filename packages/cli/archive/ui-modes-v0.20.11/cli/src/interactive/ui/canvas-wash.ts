/**
 * Canvas wash — modes with `canvas.wash` set the terminal's default
 * background to the theme's bgBase via OSC 11 AND the default foreground to
 * the theme's text via OSC 10, so the whole screen (not just painted cells)
 * matches the mode. Both must move together: washing only the background left
 * unpainted text at the terminal's own default foreground — white-on-white in
 * a dark terminal running the day theme. OSC 111/110 restore the terminal's
 * own colors on exit or when the wash goes away.
 */
import { theme } from "./theme";
import { uiStyle } from "./ui-mode";

let washApplied = false;

/** Apply (or re-apply after a mode/theme change) the active mode's wash. */
export function applyCanvasWash(out: NodeJS.WriteStream = process.stdout): void {
    const bg = uiStyle().canvas.wash ? theme.raw("bgBase") : undefined;
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
