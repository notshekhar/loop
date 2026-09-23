/**
 * UI modes — pluggable chat "experiences". A mode bundles its own theme set,
 * a declarative style spec (per-block rendering knobs), and optional
 * imperative block renderers. The builtin `loop` mode's spec IS today's
 * rendering: every knob default reproduces the current look byte-for-byte
 * (guarded by ui-mode-snapshot.test.ts), so nothing changes until another
 * mode is activated. Extensions register modes through this registry (the
 * extension SDK surface fronts it in a later phase).
 */
import { getExtensionHost, type ExtensionThemeJson } from "@notshekhar/loop-core";
import type { ThemeJson } from "./themes";
import { DARK_THEME, LIGHT_THEME } from "./themes";
import type { TaskStatsLike } from "./tool-execution";
import type { Theme } from "./theme";

// ---------------------------------------------------------------------------
// Style spec — declarative knobs, covers most custom looks without code
// ---------------------------------------------------------------------------

export interface UiStyleSpec {
    canvas: {
        /** Paint the theme's base background across the full width of every line. */
        wash: boolean;
    };
    thinking: {
        /** "inline": italic text inside the assistant message (loop).
         *  "block": a separate collapsible block with its own header (grok). */
        display: "inline" | "block";
        /** Block display only: visible tail lines while streaming. */
        liveTailLines: number;
        /** Block display only: fold to the header line when the block finishes. */
        collapseOnFinish: boolean;
        /** Accent gutter line down the block's left edge. */
        gutter: boolean;
    };
    tool: {
        /** Glyph before the tool title ("" = none). */
        bullet: string;
        /** Output preview lines when collapsed. */
        collapsedLines: number;
        /** Grey out the whole box (not just the title) while collapsed. */
        mutedCollapsed: boolean;
        /**
         * Show a one-line RECEIPT under a finished call — what it returned
         * (`580 lines`, `exit 1 · 214 lines`, `+12 −4`), as opposed to the
         * title's summary of what was asked for.
         *
         * Only worth its row in a mode that hides the output while folded: the
         * default look already shows a preview, where a receipt would just be
         * a count of lines you can see. See tool-receipt.ts.
         */
        receipt: boolean;
        /**
         * Lines of real output a FOLDED call shows under its receipt (0 = none).
         *
         * Distinct from `collapsedLines`, which is the default box's preview:
         * that one previews every tool's output from the top, while a peek is
         * chosen per tool kind — a command's last lines, a search's first, a
         * diff's changed ones, and nothing at all for a file you named
         * yourself. See tool-receipt.ts.
         */
        peekLines: number;
        /** Fold a run of consecutive finished, collapsed tool rows into one
         * aggregated header ("Read 3 files"), grok-style. The run's members
         * are hidden until the header is opened — a second fold level above
         * each call's own expand. */
        group: boolean;
    };
    userMessage: {
        /** Prefix glyph before the message text ("" = none). */
        prefix: string;
        /** Right-aligned hh:mm timestamp on the first line. */
        timestamp: boolean;
    };
    turn: {
        /** "Turn completed in Xs." line after each turn. */
        summaryLine: boolean;
    };
    hints: {
        /** How to reach hidden content from the prompt — shown in the
         * "(… to expand)" hints on truncated tool output and collapsed
         * skill/compaction boxes. The flow: ctrl+e enters nav, e expands
         * everything (per-entry: navigate + selectedExpandHint). */
        expandHint: string;
        /** Key that expands the SELECTED entry inside nav mode — shown on
         * selected rows and on entries the user folded in nav. */
        selectedExpandHint: string;
    };
    layout: {
        /** Block-owned gaps: each thinking/response/tool-group block renders
         * its own single leading blank line, and the chat's built-in Spacers
         * inside assistant turns are skipped. One deterministic spacing rule
         * for live streaming AND replay (they build the tree differently). */
        blockGaps: boolean;
    };
}

/** The builtin loop look. Every default here must keep the snapshot suite green. */
export const LOOP_STYLE: UiStyleSpec = {
    canvas: { wash: false },
    thinking: { display: "inline", liveTailLines: 3, collapseOnFinish: false, gutter: false },
    tool: { bullet: "", collapsedLines: 6, mutedCollapsed: false, receipt: false, peekLines: 0, group: false },
    userMessage: { prefix: "", timestamp: false },
    turn: { summaryLine: false },
    hints: { expandHint: "ctrl+e then e", selectedExpandHint: "→" },
    layout: { blockGaps: false },
};

// ---------------------------------------------------------------------------
// Block renderers — imperative escape hatch for looks the knobs can't reach
// ---------------------------------------------------------------------------

/** Handed to block renderers. Pure data — no I/O, renderers must be sync. */
export interface RenderCtx {
    width: number;
    /** The active theme — renderers color through it, never hardcode. */
    theme: Theme;
}

export interface UserBlockState {
    text: string;
}

export interface ThinkingBlockState {
    text: string;
    /** Still streaming (turn not finished). */
    streaming: boolean;
    /** Effectively open: the block's own toggle, or the global ctrl+e. */
    expanded: boolean;
    /** This block is the current selection (ctrl+up/down navigation). */
    selected: boolean;
    /** Wall-clock thinking time, once known (undefined on replayed turns). */
    durationMs?: number;
}

/** Snapshot of a tool call's display state (mirrors ToolExecutionComponent). */
export interface ToolBlockState {
    toolName: string;
    args: Record<string, unknown>;
    /** One-line plain-text arg summary (same text the default title shows). */
    summary: string;
    /** Flattened result text ("" while pending). */
    output: string;
    /**
     * One line naming what the call RETURNED — `580 lines`, `exit 1 · 214
     * lines`, `+12 −4 · 2 blocks`. Empty while the call is still running, when
     * it was interrupted, and whenever nothing honest could be said about the
     * result (see tool-receipt.ts). Computed once per result, not per frame.
     */
    receipt: string;
    /**
     * A few lines of the call's real output, for a mode that folds the rest
     * away — which end they come from is the tool's business, not the
     * renderer's (see tool-receipt.ts). Empty while running or interrupted.
     */
    peek: string[];
    /** Output lines the peek leaves behind — what expanding the row adds. */
    peekHidden: number;
    isError: boolean;
    isPartial: boolean;
    expanded: boolean;
    /** This block is the current selection (ctrl+up/down navigation). */
    selected: boolean;
    /** First call of a consecutive tool group — a lead blank line reads
     * better after text/user entries; rows inside a group stay tight. */
    groupLead: boolean;
    /** The turn was aborted while this call was still running. */
    interrupted: boolean;
    statusText: string;
    streamingContent: string;
    taskStats?: TaskStatsLike;
    cwd: string;
    /** When the call stopped running (`Date.now()`), for the finish flash.
     * Unset on replayed transcripts — those calls were never seen running. */
    finishedAt?: number;
}

/**
 * One call inside a folded verb group — a row reduced to a single line, but
 * not to nothing.
 *
 * Strictly one line, with no exception for edits or failures. A group's whole
 * value is that every row in it has the same shape: the eye reads straight
 * down the receipt column for the odd one out. Letting some members carry a
 * diff or an error under them buys a little detail and costs exactly the
 * regularity that made the fold worth reading — and the detail was never gone,
 * only one `→` away.
 */
export interface ToolGroupMember {
    toolName: string;
    /** The call's one-line arg summary (a path, a command, a pattern). */
    summary: string;
    /** What it returned — see ToolBlockState.receipt. */
    receipt: string;
    isError: boolean;
}

/** A run of consecutive finished tool calls, folded into one block. */
export interface ToolGroupState {
    /** The aggregated label ("Read 2 files, Listed 1 dir"). */
    label: string;
    /** How many members failed. */
    failed: number;
    /** The run's calls, in order. */
    members: ToolGroupMember[];
    /** The group is the current selection (ctrl+up/down navigation). */
    selected: boolean;
}

/** Each renderer fully replaces that block's default rendering; return null
 * to fall back to the default look for that particular block (e.g. a mode
 * that restyles bash rows but keeps the plan box). */
export interface BlockRenderers {
    userMessage?(state: UserBlockState, ctx: RenderCtx): string[] | null;
    thinking?(state: ThinkingBlockState, ctx: RenderCtx): string[] | null;
    toolExecution?(state: ToolBlockState, ctx: RenderCtx): string[] | null;
    /**
     * The stand-in for a folded run of calls. Without one a mode gets the
     * default single line ("◈ Read 3 files"); with one it can name the members
     * it swallowed, which is the difference between a fold and a disappearance.
     */
    toolGroup?(state: ToolGroupState, ctx: RenderCtx): string[] | null;
}

// ---------------------------------------------------------------------------
// Mode plugin + registry
// ---------------------------------------------------------------------------

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface UiModePlugin {
    id: string;
    /** Picker label; falls back to id. */
    name?: string;
    /** Themes this mode owns; [0] is its default. */
    themes: ThemeJson[];
    /** Knobs layered over the loop defaults. */
    style?: DeepPartial<UiStyleSpec>;
    /**
     * The mode's LIVE variant — knobs layered on top of its own `style` while
     * the transcript holds the keyboard (ctrl+e).
     *
     * Live is a state a mode can be IN, not a mode of its own. Making it a
     * separate registered mode meant a mode's live look could drift from its
     * normal one, and it put a second entry in the picker for something you
     * reach with a key. A mode that wants nothing special while live simply
     * omits this and keeps its own look.
     */
    live?: DeepPartial<UiStyleSpec>;
    /** Per-block render overrides. */
    render?: BlockRenderers;
}

const LOOP_MODE: UiModePlugin = { id: "loop", name: "Loop", themes: [DARK_THEME, LIGHT_THEME] };

const modes = new Map<string, UiModePlugin>([[LOOP_MODE.id, LOOP_MODE]]);
let activeId = LOOP_MODE.id;
let liveVariant = false;
let resolvedStyle: UiStyleSpec | null = null;

/**
 * Enter/leave the active mode's live variant. Returns whether the state
 * changed, so a caller can skip a repaint it doesn't need.
 */
export function setLiveVariant(on: boolean): boolean {
    if (liveVariant === on) return false;
    liveVariant = on;
    resolvedStyle = null;
    return true;
}

export function isLiveVariant(): boolean {
    return liveVariant;
}

/**
 * How much of a finished call the transcript shows. See `AppSettings.toolDetail`.
 *
 * This is the one layer that is the USER's rather than the mode's, and it is
 * deliberately subtractive: `compact` removes the receipt and the peek, and
 * the other two leave the mode's own knobs alone. A density that could ADD a
 * receipt would be inventing a look for a mode that never designed one.
 * (`full` is not additive either — expanding every call is the `e` flag the
 * transcript already owns, applied by the caller.)
 */
export type ToolDetail = "compact" | "normal" | "full";

const DETAILS: readonly ToolDetail[] = ["compact", "normal", "full"] as const;
let toolDetail: ToolDetail = "normal";

/** Set the density. Returns whether it CHANGED, so a caller can skip a repaint. */
export function setToolDetail(detail: ToolDetail): boolean {
    if (toolDetail === detail) return false;
    toolDetail = detail;
    resolvedStyle = null;
    return true;
}

export function getToolDetail(): ToolDetail {
    return toolDetail;
}

/** The next density in the cycle — what `d` moves to. */
export function nextToolDetail(): ToolDetail {
    return DETAILS[(DETAILS.indexOf(toolDetail) + 1) % DETAILS.length];
}

function mergeSpec(base: UiStyleSpec, partial: DeepPartial<UiStyleSpec> | undefined): UiStyleSpec {
    if (!partial) return base;
    const out = { ...base } as Record<string, unknown>;
    for (const [k, v] of Object.entries(partial)) {
        if (v === undefined) continue;
        const cur = out[k];
        out[k] = cur && typeof cur === "object" && typeof v === "object" ? { ...cur, ...v } : v;
    }
    return out as unknown as UiStyleSpec;
}

export function registerUiMode(mode: UiModePlugin): void {
    modes.set(mode.id, mode);
    if (mode.id === activeId) resolvedStyle = null;
}

/** Remove a mode (extension unload). The active or builtin loop mode falls back to loop. */
export function unregisterUiMode(id: string): void {
    if (id === LOOP_MODE.id) return;
    modes.delete(id);
    if (activeId === id) setActiveUiMode(LOOP_MODE.id);
}

export function listUiModes(): UiModePlugin[] {
    return [...modes.values()];
}

/**
 * An extension palette is deliberately PARTIAL — `ThemeJson` demands all ~52
 * slots, but a mode that only restyles a few would be unusable if it had to
 * restate the rest. Missing slots are filled from the builtin dark theme when
 * the theme is loaded (`withDarkFallback` in theme.ts), so the widening here is
 * sound rather than a papered-over mismatch.
 */
function asThemeJson(theme: ExtensionThemeJson): ThemeJson {
    return theme as unknown as ThemeJson;
}

/**
 * Drain extension-contributed modes and palettes into this registry.
 *
 * Must run after the extension host has loaded and BEFORE the configured mode
 * is activated, or a mode an extension provides can't be the one selected at
 * startup. Re-running is safe: modes replace by id and themes dedupe by name,
 * so a reload doesn't accumulate duplicates.
 */
export function applyExtensionUiModes(): void {
    const { modes: contributed, themeAdditions } = getExtensionHost().getUiModes();
    for (const m of contributed) {
        registerUiMode({
            id: m.id,
            name: m.name,
            themes: (m.themes ?? []).map(asThemeJson),
            style: m.style as UiModePlugin["style"],
        });
    }
    for (const { modeId, themes } of themeAdditions) {
        const mode = modes.get(modeId);
        if (!mode) continue;
        for (const t of themes.map(asThemeJson)) {
            const at = mode.themes.findIndex((existing) => existing.name === t.name);
            if (at === -1) mode.themes.push(t);
            else mode.themes[at] = t;
        }
    }
}

export function getUiMode(id: string): UiModePlugin | undefined {
    return modes.get(id);
}

/** Activate a registered mode. Unknown ids are refused (returns false). */
export function setActiveUiMode(id: string): boolean {
    if (!modes.has(id)) return false;
    activeId = id;
    resolvedStyle = null;
    return true;
}

export function activeUiMode(): UiModePlugin {
    return modes.get(activeId) ?? LOOP_MODE;
}

/** The active mode's fully-resolved style spec (partial layered over loop defaults). */
export function uiStyle(): UiStyleSpec {
    if (!resolvedStyle) {
        const mode = activeUiMode();
        // Three layers: loop's defaults, the mode's own look, then its live
        // variant on top. Live can only ever ADD to the mode you are in, so a
        // mode's two states can never drift into looking unrelated.
        const base = mergeSpec(LOOP_STYLE, mode.style);
        const withLive = liveVariant ? mergeSpec(base, mode.live) : base;
        // The user's density sits on top of the mode's own look, and only ever
        // takes away — see ToolDetail.
        resolvedStyle =
            toolDetail === "compact" ? mergeSpec(withLive, { tool: { receipt: false, peekLines: 0 } }) : withLive;
    }
    return resolvedStyle;
}

/** The active mode's block-renderer overrides ({} for none). */
export function uiRenderers(): BlockRenderers {
    return activeUiMode().render ?? {};
}
