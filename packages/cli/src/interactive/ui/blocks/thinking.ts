/**
 * The thinking block: `◆ Thought for 0.5s` once it has settled, a dim header
 * over a short live tail while it streams, the whole thought under an accent
 * gutter when it is opened.
 */
import { wrapTextWithAnsi } from "@notshekhar/loop-tui";
import { bulletColor, RAIL_WIDTH, railForState, withRail } from "../rail";
import { fgHex } from "../theme";
import { fitRow } from "../fit";
import { canvasBg, EXPAND_HINT, fmtSeconds, hexOf, LIVE_TAIL_LINES, railColors, TOOL_BULLET } from "./shared";
import type { RenderCtx, ThinkingBlockState } from "./types";

export function renderThinking(state: ThinkingBlockState, ctx: RenderCtx): string[] {
    const th = ctx.theme;
    const bg = canvasBg(ctx);
    const bodyWidth = Math.max(20, ctx.width - RAIL_WIDTH - 1);
    const label =
        state.durationMs !== undefined
            ? `Thought for ${fmtSeconds(state.durationMs)}`
            : state.streaming
              ? "Thinking…"
              : "Thought";
    // Thinking rides its own hue rather than the tool accent — it is the one
    // block whose rail should read as "the model, not the machine". A settled
    // thought keeps that hue too: it has no success/failure outcome to report,
    // so mapping it onto the green/red pair would be a lie.
    const think = hexOf(ctx, "thinkingXhigh", "#beb6e8");
    const spec = railForState(
        { isPartial: state.streaming, expanded: state.expanded, selected: state.selected },
        { ...railColors(ctx), running: think, success: think, error: think },
        bg,
    );
    const diamond = fgHex(bulletColor(spec, bg, think), TOOL_BULLET);
    const header = fitRow(diamond + " " + th.fg("accentThinking", th.italic(label)), ctx.width - RAIL_WIDTH);

    // Every block owns exactly ONE leading blank — the same deterministic gap
    // whether the transcript streamed live or replayed.
    if (!state.streaming && !state.expanded) {
        const hint = state.selected ? th.fg("dim", ` (${EXPAND_HINT} to expand)`) : "";
        return ["", ...withRail([fitRow(header + hint, ctx.width - RAIL_WIDTH)], spec, bg)];
    }
    const wrapped = state.text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, bodyWidth) : [""]));
    const body = state.streaming && !state.expanded ? wrapped.slice(-LIVE_TAIL_LINES) : wrapped;
    return ["", ...withRail([header, ...body.map((l) => th.fg("thinkingText", th.italic(l)))], spec, bg)];
}
