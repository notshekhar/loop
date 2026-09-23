/**
 * A tool call as a flat one-line row: `◆ name summary` — no box, no
 * background. Muted once done and folded, theme text when selected, error red
 * on failure. Expanding a row shows its output under an accent gutter.
 *
 * The plan tool keeps the box look (an approval surface the user must read),
 * so this returns null for it and `tool-execution.ts` draws that box itself.
 *
 * Subagents (task) are the same row shape: `◆ task <agent> · <status>` with
 * the live activity tail while running and the full run log when expanded.
 * The subagent's own turns/parts render as lines of that log — per-part
 * folding inside a subagent needs nested entries.
 */
import { wrapTextWithAnsi } from "@notshekhar/loop-tui";
import { bulletColor, RAIL_WIDTH, railForState, withRail, type RailSpec } from "../rail";
import { fgHex } from "../theme";
import { highlightToolSummary, readGutterPrefixes, readLineRangeText, taskPromptSnippet } from "../tool-summary";
import { fitAroundTail, fitRow } from "../fit";
import { showsReceipt } from "../tool-detail";
import { isPlanSurface } from "../verb-group";
import { canvasBg, EXPAND_HINT, fmtSeconds, hexOf, LIVE_TAIL_LINES, railColors, TOOL_BULLET } from "./shared";
import type { RenderCtx, ToolBlockState } from "./types";

export function renderTool(state: ToolBlockState, ctx: RenderCtx): string[] | null {
    if (isPlanSurface(state.toolName)) return null;
    const isTask = state.toolName === "task";
    const th = ctx.theme;
    const width = ctx.width - RAIL_WIDTH;
    const bodyWidth = Math.max(20, width - 1);
    const bg = canvasBg(ctx);

    // The diamond carries the state (grok's accent_running/success/error):
    // yellow while running, green on success, red on failure. The title text
    // stays muted once done (bright while running or selected).
    const failed = state.isError && !state.isPartial;
    const spec = railForState(state, railColors(ctx), bg);
    // While running, the diamond rides the head of its own rail's wave, so
    // bullet and line pulse as one mark (grok syncs them off the same curve).
    const diamond = state.isPartial
        ? fgHex(bulletColor(spec, bg, hexOf(ctx, "warning", "#dcb77f")), TOOL_BULLET)
        : th.fg(failed ? "toolError" : state.interrupted ? "muted" : "success", TOOL_BULLET);
    const titleColor = failed ? "toolError" : state.isPartial || state.selected ? "text" : "muted";

    /** Single exit: every return applies the rail and the block's lead gap. */
    const finish = (content: string[], spc: RailSpec | null = spec): string[] =>
        state.groupLead ? ["", ...withRail(content, spc, bg)] : withRail(content, spc, bg);

    /**
     * The receipt — what the call RETURNED, as opposed to what it was asked
     * for. Only a finished call has one; a running row's status already says
     * everything there is to know, and an interrupted one never got a result.
     */
    const wantsReceipt = showsReceipt() && !state.isPartial && !state.interrupted;
    let receipt = wantsReceipt ? state.receipt : "";

    let name = state.toolName;
    // A bash row's summary is a shell command, so it is coloured like one —
    // program, quoting, variables, pipeline. Anything else stays a muted run,
    // which is what a path or a pattern wants.
    const summaryText = state.summary
        ? (highlightToolSummary(state.toolName, state.summary) ?? th.fg("muted", state.summary))
        : "";
    let detail = summaryText ? " " + summaryText : "";
    // `read src/app.ts:120-180` — the offset/limit range rides the row the way
    // the default box shows it (dim here, since noir's details are dim). Modes
    // only get `summary`, which is the path alone, so without this an offset
    // read is indistinguishable from a whole-file one.
    // The range rides the TAIL, not the detail: it says which lines were read,
    // so a path long enough to need clipping must not take it down with it.
    const tail = state.toolName === "read" ? th.fg("dim", readLineRangeText(state.args)) : "";
    if (isTask) {
        // `task <agent> · <live status | done · stats> · <prompt snippet>` —
        // the same identity line the default box shows, as a grok row.
        const agent = typeof state.args.agent === "string" ? state.args.agent : "default";
        const snippet = taskPromptSnippet(state.args);
        const stats = state.taskStats;
        const doneParts = [
            "done",
            ...(stats?.steps ? [`${stats.steps} step${stats.steps === 1 ? "" : "s"}`] : []),
            ...(stats?.durationMs !== undefined ? [fmtSeconds(stats.durationMs)] : []),
            ...(stats?.usd !== undefined ? [`$${stats.usd.toFixed(4)}`] : []),
        ];
        const status = state.isPartial
            ? state.statusText || "running"
            : state.interrupted
              ? "interrupted"
              : failed
                ? "failed"
                : doneParts.join(" · ");
        name = `task ${agent}`;
        // A finished run's outcome is a RECEIPT, not part of the call's
        // identity: with receipts on it moves to its own row and the header
        // keeps the agent and the prompt — which is what you scan a transcript
        // for. Without them it stays inline, exactly as before.
        if (wantsReceipt) {
            receipt = status;
            detail = snippet ? " " + th.fg("muted", snippet) : "";
        } else {
            detail = " " + th.fg("muted", snippet ? `${status} · ${snippet}` : status);
        }
    }
    const status = !isTask
        ? state.isPartial
            ? th.fg("dim", ` · ${state.statusText || "running"}`)
            : state.interrupted
              ? th.fg("dim", " · interrupted")
              : ""
        : "";
    // The name and diamond are fixed, the status is the tail that must survive,
    // and the detail in between is what gets clipped when the row is too long.
    const head = diamond + " " + th.fg(titleColor, th.bold(name));
    const buildHeader = (extraTail = ""): string => fitAroundTail(head, detail, tail + status + extraTail, width);

    const lines = [buildHeader()];
    // `└ 580 lines` — the gutter mark separates what came back from the call
    // itself, so one glance reads the row and the next reads the result. A
    // failure colours it: a red diamond with no text anywhere is precisely the
    // state this row exists to end.
    if (receipt) {
        lines.push(fitRow(th.fg("dim", "└ ") + th.fg(failed ? "toolError" : "muted", receipt), width));
    }

    /**
     * Whether the peek already told the user how to reach the rest. It ends
     * with the same hint the header carries, and a row wearing both says the
     * same thing twice on two adjacent lines.
     */
    let hintOnPeek = false;
    // The peek: a few lines of the real output, taken from whichever end of it
    // answers — see tool-receipt.ts. Indented under the receipt's text, past
    // the `└`, so the gutter column reads as one mark rather than a ladder.
    //
    // Truncated per line, never wrapped: a 400-column log line has to cost one
    // row like any other, or the line budget the peek was given stops meaning
    // anything and one long line eats the whole preview.
    if (!state.expanded && state.peek.length > 0) {
        for (const l of state.peek) lines.push(fitRow("  " + th.fg(failed ? "toolError" : "toolOutput", l), width));
        hintOnPeek = true;
        if (state.peekHidden > 0) {
            const hint = state.selected ? ` (${EXPAND_HINT} to expand)` : "";
            const n = `${state.peekHidden} ${state.peekHidden === 1 ? "line" : "lines"}`;
            lines.push(fitRow("  " + th.fg("dim", `… +${n}${hint}`), width));
        }
    }

    const expandHint = (): void => {
        if (hintOnPeek) return;
        // Rebuilt rather than appended to: appending to a line that has already
        // been fitted cuts it a second time, so the hint arrived only to push
        // the status it was sitting beside off the end.
        lines[0] = buildHeader(th.fg("dim", ` (${EXPAND_HINT} to expand)`));
    };

    // Subagent body: the live activity tail while running; the full run log
    // when expanded. Each subagent turn/part is one log line.
    if (isTask) {
        if (!state.output) return finish(lines);
        const raw = state.output.split("\n");
        if (state.isPartial) {
            const tail = raw.slice(-LIVE_TAIL_LINES);
            for (const l of tail.flatMap((x) => (x ? wrapTextWithAnsi(x, bodyWidth) : [""]))) {
                lines.push(th.fg("toolOutput", l));
            }
            return finish(lines);
        }
        if (!state.expanded) {
            if (state.selected) expandHint();
            return finish(lines);
        }
        for (const rawLine of raw) {
            for (const l of rawLine ? wrapTextWithAnsi(rawLine, bodyWidth) : [""]) {
                lines.push(th.fg(state.isError ? "toolError" : "toolOutput", l));
            }
        }
        return finish(lines);
    }

    // Streaming input (write/edit content) — live tail while the args arrive.
    if (state.isPartial && state.streamingContent && !state.output) {
        const tail = state.streamingContent.split("\n").slice(-LIVE_TAIL_LINES);
        for (const l of tail.flatMap((x) => wrapTextWithAnsi(x, bodyWidth))) {
            lines.push(th.fg("toolOutput", l));
        }
        return finish(lines);
    }

    // Output: hidden while folded (grok's whole point), shown expanded.
    // Failures fold too — the red diamond + title carry the signal; expand
    // (nav →) to read the error.
    if (!state.output || !state.expanded) {
        if (state.output && state.selected) expandHint();
        return finish(lines);
    }
    const color = state.isError ? "toolError" : "toolOutput";
    const rawLines = state.output.split("\n");
    // `read` bodies carry absolute line numbers; every other tool's output is
    // its own text and gets none.
    const gutters =
        state.toolName === "read" && !state.isError ? readGutterPrefixes(rawLines, state.args) : rawLines.map(() => "");
    for (const [i, raw] of rawLines.entries()) {
        const num = gutters[i];
        // Only the first visual row of a wrapped source line is numbered; its
        // continuations are indented to stay under the same column.
        const numWidth = num.length;
        let first = true;
        for (const l of raw ? wrapTextWithAnsi(raw, Math.max(20, bodyWidth - numWidth)) : [""]) {
            const prefix = num ? (first ? th.fg("dim", num) : " ".repeat(numWidth)) : "";
            first = false;
            const diff =
                !state.isError && (state.toolName === "edit" || state.toolName === "write")
                    ? l.startsWith("+")
                        ? th.fg("toolDiffAdded", l)
                        : l.startsWith("-")
                          ? th.fg("toolDiffRemoved", l)
                          : th.fg("toolDiffContext", l)
                    : th.fg(color, l);
            lines.push(prefix + diff);
        }
    }
    return finish(lines);
}
