/**
 * A fold's header row — `◈ Read 3 files` for a verb run, `◈ Ran 6 commands`
 * (or `◈ 4 more`) for the oldest rows of a long stretch.
 *
 * ONE row, which is the whole point of a fold: a run of calls costs a line,
 * and opening it gives the calls back in full under the same header. grok's
 * layout says the same thing in its own terms — a collapsed header is height
 * 1, every other member height 0, and an open fold keeps its header above the
 * rows it no longer hides (`state/groups.rs::project_verb_run`).
 */
import { bulletColor, RAIL_WIDTH, railForState, withRail } from "../rail";
import { fgHex } from "../theme";
import { fitAroundTail } from "../fit";
import { canvasBg, EXPAND_HINT, hexOf, railColors } from "./shared";
import type { RenderCtx, ToolGroupState } from "./types";

/**
 * The mark a FOLD wears: a diamond containing a diamond. `◆` is what one call
 * wears, and a header is a different KIND of row — standing in for several
 * calls, not one more call.
 *
 * On the SELECTED row it gives way to a chevron pointing the way the fold
 * goes, as grok's does: the row you are on is the one that needs to say what
 * `→` and `←` will do to it.
 */
const FOLD_BULLET = "◈";
const CHEVRON_CLOSED = "›";
const CHEVRON_OPEN = "⌄";

export function renderToolGroup(state: ToolGroupState, ctx: RenderCtx): string[] {
    const th = ctx.theme;
    const width = ctx.width - RAIL_WIDTH;
    const bg = canvasBg(ctx);
    const failed = state.failed > 0;

    // A settled fold rests in its outcome colour, so a scrolled-back
    // transcript shows at a glance which runs went wrong; a running one
    // pulses on the same wave as a running call's diamond (grok animates the
    // header glyph off the same curve).
    const spec = railForState(
        { isPartial: state.running, isError: failed, expanded: state.expanded, selected: state.selected },
        railColors(ctx),
        bg,
    );
    const glyph = state.selected ? (state.expanded ? CHEVRON_OPEN : CHEVRON_CLOSED) : FOLD_BULLET;
    const mark = state.running
        ? fgHex(bulletColor(spec, bg, hexOf(ctx, "warning", "#e0af68")), glyph)
        : th.fg(failed ? "toolError" : "muted", glyph);

    // A fold that hides a failure has to say so, or folding becomes a way to
    // lose bad news.
    const failure = failed ? th.fg("toolError", ` · ${state.failed} failed`) : "";
    const hint = state.selected && !state.expanded ? th.fg("dim", ` (${EXPAND_HINT} to open)`) : "";
    const label = th.fg(state.selected || state.running ? "text" : "muted", state.label);
    const row = fitAroundTail(mark + " ", label, failure + hint, width);
    const block = withRail([row], spec, bg);
    return state.lead ? ["", ...block] : block;
}
