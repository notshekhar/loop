/**
 * What every block in the transcript agrees on: the canvas it blends toward,
 * the rail's colours, and the handful of constants that give the rows their
 * common shape.
 */
import { DAY_PALETTE, NIGHT_PALETTE, SYSTEM_THEME_NAME, systemCanvasHex } from "../themes";
import type { ThemeBg, ThemeColor } from "../theme";
import type { RenderCtx } from "./types";

/**
 * The key that opens the selected entry, as the hints spell it.
 *
 * One string, because there is one way in: select a row and press `→`. It used
 * to be two (a "how do I even get there" hint outside navigation and a "you
 * are here" hint on the selected row), which is exactly the split this
 * transcript no longer has — entries are selectable wherever you are.
 */
export const EXPAND_HINT = "→";

/** Visible tail lines of something still streaming: a thought being had, a
 * subagent working, a file's content arriving. Enough to see it moving,
 * little enough that the row below it does not walk down the screen. */
export const LIVE_TAIL_LINES = 3;

/** The mark one tool call wears. */
export const TOOL_BULLET = "◆";

/**
 * A theme slot's hex, for the uses that need a real colour to blend rather
 * than an SGR escape (the rail's wave, the bullet's pulse).
 *
 * Themes may carry 256-indexes or the terminal default (`""`) instead of hex —
 * neither can be blended — so those fall back to the caller's colour and the
 * surface renders static. Motion is a nicety; a wrong colour is not.
 */
export function hexOf(ctx: RenderCtx, slot: ThemeColor | ThemeBg, fallback: string): string {
    const raw = ctx.theme.raw(slot);
    return typeof raw === "string" && raw.startsWith("#") ? raw : fallback;
}

/**
 * The canvas a block's rail blends TOWARD at the trough of its animation.
 *
 * Normally that is `bgBase` — the colour the theme washed the terminal with.
 * Under `system` there is no wash, so `bgBase` is the terminal default (`""`,
 * no hex to blend) and the blend falls back to the palette the theme was
 * derived from: the rail fades toward the same near-black (or near-white, on
 * the light set) it always did, which is the direction a terminal running
 * `system` is in anyway. Choosing by the theme's lightness rather than its
 * name keeps a CUSTOM theme fading the right way instead of always toward
 * night's grey.
 */
export function canvasBg(ctx: RenderCtx): string {
    if (ctx.theme.name === SYSTEM_THEME_NAME) return systemCanvasHex();
    return hexOf(ctx, "bgBase", ctx.theme.isLight ? DAY_PALETTE.bg : NIGHT_PALETTE.bg);
}

/**
 * The rail palette for this theme — resolved once per block render.
 *
 * NOT `accentTool`/`accentThinking`: those slots resolve to the palette's
 * `dim`/`muted` greys (they were the old expanded-body gutter colours, meant to
 * recede). A LIVE rail has the opposite job — it is the one thing on screen
 * that should catch the eye — so running rides `warning`, the same yellow the
 * running diamond already wears.
 */
export function railColors(ctx: RenderCtx): { running: string; success: string; error: string; quiet: string } {
    return {
        running: hexOf(ctx, "warning", "#dcb77f"),
        success: hexOf(ctx, "success", "#a0cba5"),
        error: hexOf(ctx, "toolError", "#f5a5a7"),
        quiet: hexOf(ctx, "borderMuted", "#33333a"),
    };
}

/** `0.5s` under 10s, `41s` under a minute, `1m23s` beyond. Branch on the
 * ROUNDED value — branching on the raw one printed "60s" and "1m00s" for
 * 119.7s (minutes floored raw, seconds rounded up past the boundary). */
export function fmtSeconds(ms: number): string {
    const s = Math.max(0, ms) / 1000;
    const tenth = Math.round(s * 10) / 10;
    if (tenth < 10) return `${tenth.toFixed(1)}s`;
    const r = Math.round(s);
    if (r < 60) return `${r}s`;
    return `${Math.floor(r / 60)}m${String(r % 60).padStart(2, "0")}s`;
}
