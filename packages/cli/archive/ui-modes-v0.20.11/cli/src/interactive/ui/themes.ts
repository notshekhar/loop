/**
 * The built-in `loop` mode palettes.
 *
 * Both are one `Palette` each — see `palette.ts` for the primitives and for how
 * the ~55 theme slots are derived from them. Embedded as TS so no JSON assets
 * need to ship next to the compiled binary.
 *
 * `loop` mode does not wash the canvas: it draws on whatever background the
 * user's terminal already has. So while the ink (text, accent, semantics) is
 * the desktop app's token set verbatim, the SURFACES are lifted a little more
 * than the desktop's — `--border: #191919` on an unknown background is
 * invisible, and a box fill has to read as a box. `noir` mode owns its canvas
 * and uses the desktop's surface values as-is.
 */
import { DARK_INK, LIGHT_INK, type Palette, themeFromPalette } from "./palette";

export type { ThemeColors, ThemeJson, Palette, SyntaxPalette } from "./palette";
export { PRIMARY_DARK, PRIMARY_LIGHT, SYNTAX_DARK, SYNTAX_LIGHT, themeFromPalette } from "./palette";

export const DARK_PALETTE: Palette = {
    ...DARK_INK,
    name: "dark",
    wash: false,
    // Assumed canvas: a dark terminal. Tints are computed against it even
    // though it is never painted.
    bg: "#0f0f11",
    bgRaised: "#1b1c20",
    bgSunken: "#16171a",
    line: "#3f434b",
    // The fills loop mode has always used for tool boxes.
    toolSurfaces: { pending: "#282832", success: "#283228", error: "#3c2828" },
};

export const LIGHT_PALETTE: Palette = {
    ...LIGHT_INK,
    name: "light",
    wash: false,
    bg: "#ffffff",
    bgRaised: "#f1f1f3",
    bgSunken: "#f7f7f8",
    line: "#c9c9cf",
    toolSurfaces: { pending: "#e8e8f0", success: "#e8f0e8", error: "#f0e8e8" },
};

export const DARK_THEME = themeFromPalette(DARK_PALETTE);
export const LIGHT_THEME = themeFromPalette(LIGHT_PALETTE);
