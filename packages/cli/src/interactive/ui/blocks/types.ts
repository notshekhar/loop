/**
 * What a block renderer is handed.
 *
 * Every renderer under `blocks/` is a pure function of one of these states
 * plus a {@link RenderCtx}: no I/O, no reaching back into the component that
 * built the state, no globals beyond the active theme. That is what lets the
 * transcript be measured by re-rendering it — which the click-to-select mapper
 * and the frame's row reservation both depend on — and what lets every block
 * be tested without a TUI.
 */
import type { Theme } from "../theme";
import type { TaskStatsLike } from "../tool-execution";

export interface RenderCtx {
    width: number;
    /** The active theme — renderers colour through it, never hardcode. */
    theme: Theme;
}

export interface ThinkingBlockState {
    text: string;
    /** Still streaming (turn not finished). */
    streaming: boolean;
    /** Effectively open: the block's own toggle, or the global expand-all. */
    expanded: boolean;
    /** This block is the current selection. */
    selected: boolean;
    /** Wall-clock thinking time, once known (undefined on replayed turns). */
    durationMs?: number;
}

/** Snapshot of a tool call's display state (mirrors ToolExecutionComponent). */
export interface ToolBlockState {
    toolName: string;
    args: Record<string, unknown>;
    /** One-line plain-text arg summary. */
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
     * A few lines of the call's real output, since a folded row hides the
     * rest — which end they come from is the tool's business, not the
     * renderer's (see tool-receipt.ts). Empty while running or interrupted.
     */
    peek: string[];
    /** Output lines the peek leaves behind — what expanding the row adds. */
    peekHidden: number;
    isError: boolean;
    isPartial: boolean;
    expanded: boolean;
    /** This block is the current selection. */
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

/** A fold's header row: a verb run (`◈ Read 3 files`) or the "N more" that
 * stands in for the oldest rows of a long stretch. */
export interface ToolGroupState {
    /** What the fold covers, in the verb-group vocabulary. */
    label: string;
    /** How many of the calls it covers failed. */
    failed: number;
    /** Any covered call still running — present tense, and a live glyph. */
    running: boolean;
    /** The header is the current selection. */
    selected: boolean;
    /** The fold is open: its rows render in full under this header. */
    expanded: boolean;
    /** Open the block with a blank line — false when it sits tight under the
     * tool row before it, as tool rows do. */
    lead: boolean;
}
