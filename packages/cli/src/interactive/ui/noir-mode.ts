/**
 * The builtin `noir` UI mode — a dark-canvas experience in the spirit of
 * terminal cockpits: OSC 11 background wash, one-line diamond tool rows that
 * grey out when folded, thinking as its own block that streams a short tail
 * and collapses when the turn moves on, `❯` user prompts, and a turn summary
 * line. Built strictly on the public mode contract (style spec + themes +
 * block renderers) — if this file needs private hooks, the contract is wrong.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@notshekhar/loop-tui";
import {
    atLeastContrast,
    contrastRatio,
    DARK_INK,
    LIGHT_INK,
    mix,
    type Palette,
    type ThemeJson,
    themeFromPalette,
} from "./palette";
import { bulletColor, RAIL_WIDTH, railForState, withRail, type RailSpec } from "./rail";
import { fgHex, type ThemeBg, type ThemeColor } from "./theme";
import { highlightToolSummary, readGutterPrefixes, readLineRangeText, taskPromptSnippet } from "./tool-summary";
import { fitAroundTail, fitRow } from "./fit";
import {
    registerUiMode,
    uiStyle,
    type RenderCtx,
    type ThinkingBlockState,
    type ToolBlockState,
    type ToolGroupState,
    type UiModePlugin,
} from "./ui-mode";
import { isPlanSurface, kindIdOf } from "./verb-group";

/**
 * Noir's palettes. Unlike `loop` mode it washes the canvas, so the terminal
 * background IS the desktop's `--background` and the surface levels can sit as
 * close together as they do in the desktop app. See `palette.ts` for how the
 * theme slots are derived from these primitives.
 */
/**
 * Noir's ink.
 *
 * Loop mode keeps the classic vivid palette, which is right for a mode drawing
 * on whatever background your terminal happens to have. Noir washes its own
 * canvas, so it can afford one deliberate set instead: every colour sits at a
 * single lightness and a shared chroma, with hues spread far enough apart to
 * stay distinguishable. A message renders tonal rather than primary — no
 * colour shouts over its neighbours.
 *
 * Two exceptions carry extra chroma rather than extra brightness, because both
 * have a job beyond looking pleasant: a heading has to lead its section, and an
 * error has to alert. Each hue is still anchored to what it MEANS — success is
 * green, error is red, a number is cool — so the set is normalised, not
 * arbitrary.
 */
const NIGHT_INK = {
    // The brand blue, held at the set's lightness. Full-chroma primary sat
    // outside the family badly: as a list bullet or a prompt it was the one
    // vivid mark on an otherwise tonal screen.
    accent: "#77a0dc",
    heading: "#d5bb7b",
    warning: "#dcb77f",
    error: "#f5a5a7",
    success: "#a0cba5",
    inlineCode: "#d5afd7",
    codeBlock: "#a0cba5",
    accentLift: "#a2c0eb",
    thinkingPeak: "#beb6e8",
    syntax: {
        comment: "#6f6f6f",
        keyword: "#e6a9c5",
        function: "#beb6e8",
        variable: "#e2b293",
        string: "#a0cba5",
        number: "#87cbd5",
        type: "#d5afd7",
        operator: "#8a8a8a",
        punctuation: "#8a8a8a",
    },
} as const;

const DAY_INK = {
    accent: "#3463a6",
    heading: "#7c5f00",
    warning: "#835b06",
    error: "#9a444a",
    success: "#3f7047",
    inlineCode: "#7c527e",
    codeBlock: "#3f7047",
    accentLift: "#446493",
    thinkingPeak: "#645a90",
    syntax: {
        comment: "#767676",
        keyword: "#8c4a6b",
        function: "#645a90",
        variable: "#885531",
        string: "#3f7047",
        number: "#04707c",
        type: "#7c527e",
        operator: "#6b6b6b",
        punctuation: "#6b6b6b",
    },
} as const;

export const NIGHT_PALETTE: Palette = {
    ...DARK_INK,
    ...NIGHT_INK,
    name: "night",
    wash: true,
    bg: "#141414",
    bgRaised: "#1f1f21",
    bgSunken: "#1a1a1c",
    line: "#33333a",
    toolSurfaces: "flat",
};

export const DAY_PALETTE: Palette = {
    ...LIGHT_INK,
    ...DAY_INK,
    name: "day",
    wash: true,
    bg: "#fcfcfc",
    bgRaised: "#f1f1f3",
    bgSunken: "#f7f7f8",
    line: "#d6d6dd",
    toolSurfaces: "flat",
};

export const NIGHT_THEME: ThemeJson = themeFromPalette(NIGHT_PALETTE);
export const DAY_THEME: ThemeJson = themeFromPalette(DAY_PALETTE);

/**
 * `system` — noir's third theme: the mode WITHOUT the canvas.
 *
 * Night and day each claim the terminal's background and wash it (OSC 11/10).
 * That is right when you want noir's canvas, and wrong when your terminal
 * already has a background it means: a true black, a transparency, an image.
 * `system` gives that back — it washes nothing, so every row is noir's ink
 * drawn straight onto whatever the terminal already was.
 *
 * Which ink it uses is not yours to configure: the terminal is ASKED (its
 * colour-scheme report, else its background colour) and the dark or light set
 * follows, live — flip your terminal to light mid-session and the transcript
 * follows it. That is the whole point of calling it `system` rather than
 * shipping two more theme names.
 *
 * Both variants keep their palette's `bg` even though nothing paints it: every
 * surface tint (selection, a custom message, a failed tool's fill) is MIXED
 * against it, so dropping it would drop those surfaces too. It stops being
 * painted; it stays the colour the rest is computed from.
 */
export const SYSTEM_THEME_NAME = "system";

/**
 * How far the two surface levels and the chrome line sit off the canvas.
 * Measured from night AND day, which agree on all three — the lift is a
 * relationship in the design, not a per-palette constant, which is why it
 * survives being moved onto a background neither palette chose.
 */
const LIFT = { raised: 0.05, sunken: 0.025, line: 0.13 } as const;

/**
 * The canvas to assume before the terminal has told us its own — the LIGHTEST
 * background a dark terminal plausibly has (and the darkest a light one does).
 *
 * Not a guess at the average: a guess at the worst case, because the ramp's
 * failure is one-sided. Solve for a canvas lighter than the real one and the
 * greys come out a little brighter than designed — no harm. Solve for a darker
 * one and they come out too faint to read, which is precisely the bug this
 * exists to prevent. It also has to be right from the FIRST paint: the probe's
 * answer lands a moment later, and by then the banner and the startup notices
 * have already baked their colours into the scrollback.
 */
const SAFE_CANVAS = { dark: "#2e2e2e", light: "#ececec" } as const;

/**
 * Build `system` for the canvas it is really drawn on.
 *
 * The ink cannot simply be night's. noir's colours are not those hexes because
 * the hexes are special — each is a RATIO against noir's own `#141414`: text
 * at 16.9:1, muted at 5.3:1, dim deliberately faint at 2.9:1, the accent at
 * 6.9:1. Drop the same hexes onto a lighter terminal and every one of them
 * loses roughly a fifth of its contrast at once; that is not "text is a bit
 * dark", it is the whole palette sinking toward a background it was never
 * measured against.
 *
 * So EVERY colour is checked against the canvas that is actually there — the
 * greys, the semantic hues, the syntax set — and any that fell below the ratio
 * it holds on noir's own canvas is lifted back to it. Lifted by tinting toward
 * white (or black on a light terminal), so a hue stays its hue: a raised red is
 * still red.
 *
 * One-sided, deliberately. A terminal DARKER than noir's canvas makes every
 * slot more readable, not less, and pulling those back down to the exact ratio
 * would be dimming a screen that was already right. Only what fell below is
 * touched — which is why this is safe to run on every background, including
 * the ones that never needed it.
 */
function systemPalette(scheme: "dark" | "light", canvas?: string): Palette {
    const base = scheme === "light" ? DAY_PALETTE : NIGHT_PALETTE;
    const ground = canvas ?? SAFE_CANVAS[scheme];
    // Tinting past the ink toward pure white/black: on a background lighter
    // than the palette's own, the ratio a slot wants can sit beyond its ink.
    const pole = scheme === "light" ? "#000000" : "#ffffff";
    /** `slot`, still as legible here as it is on the palette's own canvas. */
    const held = (slot: string) => atLeastContrast(ground, slot, pole, contrastRatio(slot, base.bg));
    return {
        ...base,
        name: SYSTEM_THEME_NAME,
        wash: false,
        bg: ground,
        bgRaised: mix(ground, pole, LIFT.raised),
        bgSunken: mix(ground, pole, LIFT.sunken),
        line: mix(ground, pole, LIFT.line),
        text: held(base.text),
        muted: held(base.muted),
        dim: held(base.dim),
        accent: held(base.accent),
        accentLift: held(base.accentLift),
        success: held(base.success),
        error: held(base.error),
        warning: held(base.warning),
        heading: held(base.heading),
        inlineCode: held(base.inlineCode),
        codeBlock: held(base.codeBlock ?? base.success),
        thinkingPeak: held(base.thinkingPeak),
        syntax: {
            comment: held(base.syntax.comment),
            keyword: held(base.syntax.keyword),
            function: held(base.syntax.function),
            variable: held(base.syntax.variable),
            string: held(base.syntax.string),
            number: held(base.syntax.number),
            type: held(base.syntax.type),
            operator: held(base.syntax.operator),
            punctuation: held(base.syntax.punctuation),
        },
    };
}

/**
 * What the terminal last told us: which set to wear, and — when it reported a
 * background colour rather than just "dark"/"light" — the canvas to hold the
 * ramp's contrast against. Dark on the safe canvas until it answers, which is
 * the honest default for a terminal that never replies at all.
 */
let systemScheme: "dark" | "light" = "dark";
let systemCanvas: string | undefined;
let systemThemeJson: ThemeJson = themeFromPalette(systemPalette("dark"));

/** The `system` theme as the terminal currently reads. */
export function systemTheme(): ThemeJson {
    return systemThemeJson;
}

/**
 * The canvas `system` is drawn on — the terminal's own background when it told
 * us, else the set's. Rails and bullets blend toward it, and unlike every
 * washed theme there is no `bgBase` slot to read it back out of.
 */
export function systemCanvasHex(): string {
    return systemCanvas ?? SAFE_CANVAS[systemScheme];
}

/**
 * Record what the terminal reported. Returns true when it CHANGED — the caller
 * only has to re-resolve the theme and repaint when it did. Re-registers noir
 * so the mode's theme set carries the new variant.
 */
export function setNoirSystem(scheme: "dark" | "light", canvas?: string): boolean {
    if (scheme === systemScheme && canvas === systemCanvas) return false;
    systemScheme = scheme;
    systemCanvas = canvas;
    systemThemeJson = themeFromPalette(systemPalette(scheme, canvas));
    registerNoirMode();
    return true;
}

/**
 * A theme slot's hex, for the uses that need a real colour to blend rather
 * than an SGR escape (the rail's wave, the bullet's pulse).
 *
 * Themes may carry 256-indexes or the terminal default (`""`) instead of hex —
 * neither can be blended — so those fall back to the caller's colour and the
 * surface renders static. Motion is a nicety; a wrong colour is not.
 */
function hexOf(ctx: RenderCtx, slot: ThemeColor | ThemeBg, fallback: string): string {
    const raw = ctx.theme.raw(slot);
    return typeof raw === "string" && raw.startsWith("#") ? raw : fallback;
}

/**
 * The canvas a block's rail blends TOWARD at the trough of its animation.
 *
 * Normally that is `bgBase` — the colour noir washed the terminal with. Under
 * `system` there is no wash, so `bgBase` is the terminal default (`""`, no hex
 * to blend) and the blend falls back to the palette the theme was derived
 * from: the rail fades toward the same near-black (or near-white, on the light
 * set) it always did, which is the direction a terminal running `system` is in
 * anyway. Choosing by the theme's lightness rather than its name keeps a custom
 * noir theme fading the right way instead of always toward night's grey.
 */
function canvasBg(ctx: RenderCtx): string {
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
function railColors(ctx: RenderCtx): { running: string; success: string; error: string; quiet: string } {
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
function fmtSeconds(ms: number): string {
    const s = Math.max(0, ms) / 1000;
    const tenth = Math.round(s * 10) / 10;
    if (tenth < 10) return `${tenth.toFixed(1)}s`;
    const r = Math.round(s);
    if (r < 60) return `${r}s`;
    return `${Math.floor(r / 60)}m${String(r % 60).padStart(2, "0")}s`;
}

/**
 * Thinking as a foldable one-line row, grok-style: `◆ Thought for 0.5s`
 * once done, a dim header + accent gutter + short tail while streaming,
 * the full gutter body when expanded (nav per-entry → or expand-all).
 */
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
    const diamond = fgHex(bulletColor(spec, bg, think), "◆");
    const header = fitRow(diamond + " " + th.fg("accentThinking", th.italic(label)), ctx.width - RAIL_WIDTH);

    // Every block owns exactly ONE leading blank (layout.blockGaps) — same
    // deterministic gap whether the transcript streamed live or replayed.
    if (!state.streaming && !state.expanded) {
        const hint = state.selected ? th.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to expand)`) : "";
        return ["", ...withRail([fitRow(header + hint, ctx.width - RAIL_WIDTH)], spec, bg)];
    }
    const wrapped = state.text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, bodyWidth) : [""]));
    const body = state.streaming && !state.expanded ? wrapped.slice(-uiStyle().thinking.liveTailLines) : wrapped;
    return ["", ...withRail([header, ...body.map((l) => th.fg("thinkingText", th.italic(l)))], spec, bg)];
}

/**
 * Tools as flat one-line rows: `◆ name summary` — no box, no background.
 * Muted once done+folded, theme text when selected, error red on failure.
 * Expanded rows show the output under an accent gutter. The
 * plan tool keeps its default box look (an approval surface the user must
 * read), so this returns null for it.
 *
 * Subagents (task) are the same row shape: `◆ task <agent> · <status>` with
 * the live activity tail while running and the full run log when expanded.
 * The subagent's own turns/parts render as lines of that log — per-part
 * folding inside a subagent needs nested entries (the pager phase).
 */
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
        ? fgHex(bulletColor(spec, bg, hexOf(ctx, "warning", "#dcb77f")), "◆")
        : th.fg(failed ? "toolError" : state.interrupted ? "muted" : "success", "◆");
    const titleColor = failed ? "toolError" : state.isPartial || state.selected ? "text" : "muted";

    /** Single exit: every return applies the rail and the block's lead gap. */
    const finish = (content: string[], spc: RailSpec | null = spec): string[] =>
        state.groupLead ? ["", ...withRail(content, spc, bg)] : withRail(content, spc, bg);

    /**
     * The receipt — what the call RETURNED, as opposed to what it was asked
     * for. Only a finished call has one; a running row's status already says
     * everything there is to know, and an interrupted one never got a result.
     */
    const wantsReceipt = uiStyle().tool.receipt && !state.isPartial && !state.interrupted;
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
            const hint = state.selected ? ` (${uiStyle().hints.selectedExpandHint} to expand)` : "";
            const n = `${state.peekHidden} ${state.peekHidden === 1 ? "line" : "lines"}`;
            lines.push(fitRow("  " + th.fg("dim", `… +${n}${hint}`), width));
        }
    }

    const expandHint = (): void => {
        if (hintOnPeek) return;
        // Rebuilt rather than appended to: appending to a line that has already
        // been fitted cuts it a second time, so the hint arrived only to push
        // the status it was sitting beside off the end.
        lines[0] = buildHeader(th.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to expand)`));
    };

    // Subagent body: the live activity tail while running; the full run log
    // when expanded. Each subagent turn/part is one log line.
    if (isTask) {
        if (!state.output) return finish(lines);
        const raw = state.output.split("\n");
        if (state.isPartial) {
            const tail = raw.slice(-uiStyle().thinking.liveTailLines);
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
        const tail = state.streamingContent.split("\n").slice(-uiStyle().thinking.liveTailLines);
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

/**
 * Kinds whose one-line summary is a PATH, and so must be clipped from the left.
 *
 * A path's identity is its tail: clip the front of two files in the same
 * directory and they stay distinguishable, clip the back and both collapse
 * into the same repo prefix. Every other summary is the opposite — a command,
 * a pattern, a query and a prompt all say what they are in their first
 * words — so those clip from the right, the ordinary way.
 */
const PATHY_KINDS = new Set(["file", "edit", "dir"]);

/**
 * Fit a member's summary into `max` columns, clipping the end that matters
 * least for that kind of summary.
 *
 * Styled text (an extension colouring its own summary) is always clipped from
 * the right: slicing into a string with escape sequences in it can cut one in
 * half, and a broken SGR bleeds its colour down the rest of the screen.
 */
function clipSummary(text: string, max: number, toolName: string): string {
    if (max <= 0) return "";
    if (visibleWidth(text) <= max) return text;
    const clipRight = (): string => truncateToWidth(text, Math.max(0, max - 1), "") + "…";
    if (!PATHY_KINDS.has(kindIdOf(toolName)) || text.includes("\x1b")) return clipRight();
    const chars = [...text];
    let width = 0;
    let i = chars.length;
    while (i > 0 && width + visibleWidth(chars[i - 1]) <= max - 1) {
        i--;
        width += visibleWidth(chars[i]);
    }
    return "…" + chars.slice(i).join("");
}

/**
 * A folded run of calls, as a TABLE rather than a count.
 *
 * `◈ Read 3 files` alone is the fold that started all this: it hides not just
 * the output but which files, so a scrolled-back turn says a number where it
 * should say a record. The header keeps its aggregate — it is the honest
 * summary of the run — and every member it swallowed gets one line under it:
 * what was called, and what came back.
 *
 * Four rows for three calls, against nine for the same calls unfolded, so the
 * fold still earns its place. What it no longer does is lose the identities.
 */
export function renderToolGroup(state: ToolGroupState, ctx: RenderCtx): string[] | null {
    if (state.members.length === 0) return null;
    const th = ctx.theme;
    const width = ctx.width - RAIL_WIDTH;
    const bg = canvasBg(ctx);
    const anyFailed = state.failed > 0;

    // The group settles in its outcome colour like any finished block, so a
    // scrolled-back transcript shows at a glance which runs went wrong. Its
    // rail is the thin one: everything in it is folded.
    const spec = railForState({ isPartial: false, isError: anyFailed, expanded: false }, railColors(ctx), bg);

    // A run of one kind is already named by the header ("Read 3 files"), so
    // repeating the tool on every line would be three more columns saying what
    // the header said. A MIXED run is not — "Read 2 files, Listed 1 dir" does
    // not say WHICH member was the listing — so there the tool column earns
    // its width.
    const mixed = new Set(state.members.map((m) => kindIdOf(m.toolName))).size > 1;

    // `◈` — a diamond containing a diamond. `◆` is what one call wears, and a
    // group is a different KIND of row: a fold standing in for several calls,
    // not one more call. The failure count rides the error colour, because a
    // fold that hides a failure has to say so.
    //
    // The label is the verb-group's own sentence ("Listed 3 dirs, Read 1
    // file"), mixed run or not. It was briefly cut to a bare count on mixed
    // runs, on the grounds that the tool column below repeats it — but a count
    // says only how MANY, and the one thing a header is for is saying what the
    // turn did. The column and the label answer different questions.
    const failed = anyFailed ? th.fg("toolError", ` · ${state.failed} failed`) : "";
    const hint = state.selected ? th.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to open)`) : "";
    const label = th.fg(state.selected ? "text" : "muted", state.label);
    const lines = [fitAroundTail(th.fg("muted", "◈") + " ", label, failed + hint, width)];
    const toolCol = mixed ? Math.min(12, Math.max(...state.members.map((m) => m.toolName.length))) : 0;
    // What the tool column actually costs the row: the name plus its separator.
    // `avail` used to subtract only the name, so a mixed run built rows two
    // columns too wide and the fit chopped two characters off the RECEIPT —
    // the one part of the row that must never be the thing that gives way.
    const toolWidth = toolCol ? toolCol + 2 : 0;
    const receiptCol = Math.max(0, ...state.members.map((m) => visibleWidth(m.receipt)));

    /**
     * How wide the summaries get.
     *
     * The receipt column is right-aligned WITHIN THE BLOCK, not against the
     * terminal's edge. Anchoring it to the edge is what a table wants only
     * when the table fills the screen; a group of four short paths on a
     * 200-column terminal became two columns separated by a hundred blanks,
     * with nothing to read in between and no way to tell which receipt
     * belonged to which call. Sized to its content, the block stays a block.
     *
     * It still SHRINKS to fit when the summaries are long — that is what the
     * `avail` clamp is — so a narrow terminal clips paths rather than wrapping
     * or overflowing.
     */
    const GAP = 2;
    const longest = Math.max(...state.members.map((m) => visibleWidth(m.summary)));
    const avail = width - 2 - toolWidth - GAP - receiptCol;
    const summaryCol = Math.max(8, Math.min(longest, avail));

    /** `text`, padded to `w` columns — by VISIBLE width, since an extension's
     * summary may carry escapes that `padEnd` would count as characters. */
    const padTo = (text: string, w: number): string => text + " ".repeat(Math.max(0, w - visibleWidth(text)));

    state.members.forEach((m, i) => {
        const last = i === state.members.length - 1;
        const color = m.isError ? "toolError" : "muted";
        const tool = toolCol ? padTo(m.toolName, toolCol) + "  " : "";
        // Clipped BEFORE colouring: the column is measured in visible columns
        // and clipping coloured text has to walk escapes to find them.
        const summary = clipSummary(m.summary, summaryCol, m.toolName);
        const painted = highlightToolSummary(m.toolName, summary, color) ?? th.fg(color, summary);
        // Receipts share one right-aligned column: the eye reads down it for
        // the odd one out — the failure, the empty result, the huge file —
        // which is exactly what a fold is supposed to leave you able to do.
        const receipt = " ".repeat(Math.max(0, receiptCol - visibleWidth(m.receipt))) + m.receipt;
        lines.push(
            fitAroundTail(
                th.fg("dim", last ? "└ " : "├ ") + (tool ? th.fg("dim", tool) : ""),
                painted + " ".repeat(Math.max(0, summaryCol - visibleWidth(summary))),
                " ".repeat(GAP) + th.fg(m.isError ? "toolError" : "dim", receipt),
                width,
            ),
        );
    });

    return ["", ...withRail(lines, spec, bg)];
}

function noirMode(): UiModePlugin {
    return {
        id: "noir",
        name: "Noir",
        // night and day wash their canvas; `system` carries no canvas at all
        // (its bgBase is the terminal default) and shows the terminal's own
        // background through. The wash flag below stays on for all three —
        // it means "this mode paints a canvas WHEN its theme has one", and
        // applyCanvasWash already hands the terminal back when it does not.
        themes: [NIGHT_THEME, DAY_THEME, systemTheme()],
        style: {
            canvas: { wash: true },
            thinking: { display: "block", liveTailLines: 3, collapseOnFinish: true, gutter: true },
            tool: { bullet: "◆", mutedCollapsed: true, receipt: true, peekLines: 3 },
            userMessage: { prefix: "❯", timestamp: true },
            turn: { summaryLine: true },
            layout: { blockGaps: true },
        },
        /**
         * Noir's live variant (ctrl+e) — the same canvas, reading differently
         * because the transcript now has the keyboard.
         *
         * Grouping belongs here rather than in the base look: folding runs of
         * calls into "Read 3 files" is only worth the hidden detail when you can
         * open them again, which is exactly what live mode's arrows are for. In
         * the normal transcript the same fold would just be information you can't
         * get back without entering a mode first.
         */
        live: {
            tool: { group: true },
            // The transcript already has the keyboard here, so the route to hidden
            // content is just the arrow — no "ctrl+e first".
            hints: { expandHint: "→", selectedExpandHint: "→" },
        },
        render: { thinking: renderThinking, toolExecution: renderTool, toolGroup: renderToolGroup },
    };
}

/**
 * Register (or re-register) noir. Re-registering is the supported way to
 * change a mode live: `registerUiMode` replaces by id and drops the resolved
 * style cache, so the next render sees the new theme set — which is how a
 * terminal that flips light/dark mid-session reaches the `system` theme.
 */
export function registerNoirMode(): void {
    registerUiMode(noirMode());
}
