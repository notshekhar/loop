/**
 * Own tool execution renderer for our 7 tools:
 * status-colored box, bold title with a per-tool arg summary, output that
 * collapses to a preview and expands with ctrl+e, diff coloring for edit/write,
 * syntax highlighting for read.
 */
import { Box, Container, Markdown, Spacer, Text, type TUI } from "@notshekhar/loop-tui";
import { artifactResultSummary, normalizePlanText } from "@notshekhar/loop-core";
import { getLanguageFromPath, getMarkdownTheme, highlightCode, theme } from "./theme";
import {
    formatToolArgs,
    highlightToolSummary,
    readGutterPrefixes,
    readLineRangeText,
    taskPromptSnippet,
} from "./tool-summary";
import { formatToolReceipt, toolPeek, type ToolPeek } from "./tool-receipt";
import { uiRenderers, uiStyle, type ToolGroupMember } from "./ui-mode";
import { markSelectedLines } from "./messages";
import { fitAroundTail } from "./fit";
import { foldsEagerly, isPlanSurface } from "./verb-group";
/** Live-streaming preview cap in EXPANDED mode. Highlighting runs on every
 * flush while input streams — unbounded, a large file made a single frame
 * expensive enough to freeze the box. The full content still renders once
 * the call completes (the result path has no such cap). */
const STREAMING_EXPANDED_LINES = 200;

/** Cap on a replayed edit's reconstructed diff (see editReplayDiff). Matches
 * the cap `write` puts on the real thing. */
const REPLAY_DIFF_MAX_LINES = 200;

export interface ToolResultLike {
    content: Array<{ type: string; text?: string }>;
    isError: boolean;
}

/** Per-run summary a finished task box shows in its title (all optional —
 * older persisted runs may miss any of them). */
export interface TaskStatsLike {
    steps?: number;
    durationMs?: number;
    usd?: number;
}

/** `41s` under a minute, `2m05s` beyond — compact enough for a title line. */
export function formatTaskDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export class ToolExecutionComponent extends Container {
    private box: Box;
    private expanded = false;
    private isPartial = true;
    private result?: ToolResultLike;
    /** Live status shown in the title while partial (subagent: current tool). */
    private statusText = "";
    /** Live input while the call's args stream (write: file content so far). */
    private streamingContent = "";
    /** Finished task run summary — steps/duration/cost in the done title. */
    private taskStats?: TaskStatsLike;
    /** Highlighted by the block-selection navigation (ctrl+up/down). */
    private selected = false;
    /** Width the box was last built for — a change re-cuts the title. */
    private boxWidth = -1;
    /** First call of a consecutive tool group (see ToolBlockState.groupLead). */
    private groupLead = true;
    /** The turn was aborted while this call was still running. */
    private interrupted = false;
    /** When this call stopped running (`Date.now()`), for the finish flash —
     * the brief full-colour rail a block wears as it settles. Stays unset on
     * replayed transcripts, whose calls were never seen running. */
    private finishedAt?: number;
    /** The one-line receipt for the current result, or "" for none. Undefined
     * = not computed yet. Derived from the RESULT, so unlike the box it must
     * not be invalidated by mere display changes (expanding, selecting). */
    private receipt?: string;
    /** The peek for the current result, cached with the receipt and for the
     * same reason — both are derived by re-reading the whole output. */
    private peek?: ToolPeek;
    /** State changed since the box was last built. The box is rebuilt lazily
     * at render time: a mode's toolExecution renderer replaces the box
     * entirely, and building it anyway (highlighting, diff coloring) on every
     * streaming delta was pure waste under such modes. */
    private boxDirty = true;

    setGroupLead(lead: boolean): void {
        this.groupLead = lead;
    }

    /** The turn ended (abort) with this call still pending — freeze it as
     * "interrupted" instead of leaving a running spinner forever. */
    markInterrupted(): void {
        if (this.result && !this.isPartial) return; // finished normally
        this.isPartial = false;
        this.interrupted = true;
        this.statusText = "";
        this.finishedAt = Date.now();
        this.receipt = undefined;
        this.peek = undefined;
        this.boxDirty = true;
    }

    constructor(
        private toolName: string,
        private args: Record<string, unknown>,
        private tui: TUI,
        private cwd: string,
    ) {
        super();
        this.addChild(new Spacer(1));
        this.box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
        this.addChild(this.box);
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
        this.boxDirty = true;
    }

    isExpanded(): boolean {
        return this.expanded;
    }

    /** The tool this row calls — the key a verb group aggregates on. */
    getToolName(): string {
        return this.toolName;
    }

    /** Did this call fail? (Feeds the group header's "· N failed" suffix.) */
    hasError(): boolean {
        return this.result?.isError ?? false;
    }

    /** Still streaming. A running call never joins a group, so this only ever
     * reports the row's own state — see {@link isGroupable}. */
    isRunning(): boolean {
        return this.isPartial;
    }

    /**
     * Whether this row may be swallowed into a verb group.
     *
     * Four gates. A RUNNING call never groups: live mode is the base mode plus
     * folding, not a different way to watch a turn — while a call is in flight
     * it renders exactly the row noir renders normally, showing which file is
     * being read and its live status. Only once it lands does it fold into the
     * header with the calls before it. Grouping mid-flight was tried (it holds
     * the transcript height still) and hid the one thing you look at the
     * transcript mid-turn to see.
     *
     * An OPEN call also leaves the group — the user asked to see that one —
     * and the plan surfaces (`plan`, `exit_plan_mode`) never join, being
     * approval surfaces that must stay readable.
     *
     * The last gate is the tool's KIND. Every kind folds — reads, commands,
     * edits, third-party calls — except the surfaces the user has to act on
     * (`ask`, `plan`). See verb-group.ts for the vocabulary.
     */
    isGroupable(): boolean {
        return !this.isPartial && !this.expanded && !isPlanSurface(this.toolName) && foldsEagerly(this.toolName);
    }

    /**
     * This call as one line of a folded verb group.
     *
     * The group renders members itself rather than calling back into each
     * row's renderer: a member is a DIFFERENT shape from a row — one line, a
     * shared receipt column, no peek — and reusing the row renderer would mean
     * teaching it a second layout it only ever uses here.
     *
     * Note what is NOT here: no output, not even for an edit or a failure. The
     * receipt is the whole of a member, by design — see ToolGroupMember.
     */
    groupMember(): ToolGroupMember {
        const output = this.outputText();
        return {
            toolName: this.toolName,
            summary: this.argsSummary(),
            receipt: this.receiptText(output),
            isError: this.result?.isError ?? false,
        };
    }

    /** Selection highlight for the ctrl+up/down block navigation. */
    setSelected(selected: boolean): void {
        this.selected = selected;
    }

    updateResult(result: ToolResultLike, isPartial = false): void {
        const wasRunning = this.isPartial;
        this.result = result;
        this.isPartial = isPartial;
        if (!isPartial) {
            this.statusText = "";
            this.streamingContent = "";
            // Only the running→done edge starts a flash. A late result update
            // on an already-finished call must not re-flash it.
            if (wasRunning) this.finishedAt = Date.now();
        }
        this.receipt = undefined;
        this.peek = undefined;
        this.boxDirty = true;
        this.tui.requestRender();
    }

    /** Live input fields while the call's args stream in (before `tool-call`):
     * the path fills the title as soon as it's known, the content renders as a
     * growing tail under it. */
    updateStreamingInput(fields: Record<string, string>): void {
        if (fields.path && this.args.path !== fields.path) this.args = { ...this.args, path: fields.path };
        // the plan surfaces stream their text under "plan"; write/edit under "content".
        this.streamingContent = fields.content ?? fields.plan ?? "";
        this.boxDirty = true;
        this.tui.requestRender();
    }

    updateStatus(status: string): void {
        this.statusText = status;
        this.boxDirty = true;
        this.tui.requestRender();
    }

    /** Attach a finished task run's summary — rendered in the done title. */
    setTaskStats(stats: TaskStatsLike): void {
        this.taskStats = stats;
        this.boxDirty = true;
        this.tui.requestRender();
    }

    /** Fill in the args once the tool's input has finished streaming (the box was
     * created as a pending stub on `tool-input-start` with no args yet). */
    updateArgs(args: Record<string, unknown>): void {
        this.args = args;
        this.receipt = undefined;
        this.peek = undefined;
        this.boxDirty = true;
        this.tui.requestRender();
    }

    override invalidate(): void {
        super.invalidate();
        this.receipt = undefined;
        this.peek = undefined;
        this.boxDirty = true;
    }

    override render(width: number): string[] {
        const lines = this.renderInner(width);
        return this.selected ? markSelectedLines(lines) : lines;
    }

    /** Copy payload for the y key: the call one-liner plus its output. */
    copyText(): string {
        const title = `${this.toolName} ${this.argsSummary()}`.trim();
        const output = this.outputText();
        return output ? `${title}\n${output}` : title;
    }

    private renderInner(width: number): string[] {
        const override = uiRenderers().toolExecution;
        if (override) {
            const output = this.outputText();
            const peek = this.peekLines(output);
            const lines = override(
                {
                    toolName: this.toolName,
                    args: this.args,
                    summary: this.argsSummary(),
                    output,
                    receipt: this.receiptText(output),
                    peek: peek.lines,
                    peekHidden: peek.hidden,
                    isError: this.result?.isError ?? false,
                    isPartial: this.isPartial,
                    expanded: this.expanded,
                    selected: this.selected,
                    groupLead: this.groupLead,
                    interrupted: this.interrupted,
                    statusText: this.statusText,
                    streamingContent: this.streamingContent,
                    taskStats: this.taskStats,
                    cwd: this.cwd,
                    finishedAt: this.finishedAt,
                },
                { width, theme },
            );
            if (lines) return lines;
        }
        // Width is part of what the box is built FROM, not just how it is
        // drawn: the title has to be cut to fit, and a Text child wraps rather
        // than clipping — which turned one long call into a two-line title.
        if (this.boxDirty || this.boxWidth !== width) {
            this.rebuildBox(width);
            this.boxDirty = false;
            this.boxWidth = width;
        }
        return super.render(width);
    }

    /** (Re)build the default box's children from current state. Called lazily
     * from render — never eagerly on state changes (see boxDirty). */
    private rebuildBox(width: number): void {
        // Subagents (task tool) keep the purple custom-message background as
        // their identity — pending and done alike; errors still go red.
        const isTask = this.toolName === "task";
        this.box.setBgFn(
            this.result?.isError && !this.isPartial
                ? (text: string) => theme.bg("toolErrorBg", text)
                : isTask
                  ? (text: string) => theme.bg("customMessageBg", text)
                  : this.isPartial || this.interrupted
                    ? (text: string) => theme.bg("toolPendingBg", text)
                    : (text: string) => theme.bg("toolSuccessBg", text),
        );
        this.box.clear();
        // Box pads by one column on each side (see Box.render), so that is the
        // room the title actually has.
        this.box.addChild(new Text(this.titleLine(Math.max(1, width - 2)), 0, 0));

        // sql: render the query as a highlighted SQL block instead of leaving it
        // as a raw JSON arg blob.
        const inputLines = this.inputPreview();
        if (inputLines) {
            this.box.addChild(new Spacer(1));
            this.box.addChild(new Text(inputLines.join("\n"), 0, 0));
        }

        // plan / exit_plan_mode: the input IS the deliverable — render it as
        // full markdown (no collapse) so the user actually reads what they're
        // approving, and drop the one-line ack output. While the input still
        // streams the raw tail renders via streamingLines below, like write.
        if (isPlanSurface(this.toolName) && !this.result?.isError) {
            const plan = typeof this.args.plan === "string" ? normalizePlanText(this.args.plan.trim()) : "";
            if (plan) {
                this.box.addChild(new Spacer(1));
                this.box.addChild(new Markdown(plan, 0, 0, getMarkdownTheme()));
                return;
            }
        }

        // Streaming write: the file content renders live (tail-capped) while
        // the input is still arriving; the diff replaces it once done.
        const streaming = this.streamingLines();
        if (streaming) {
            this.box.addChild(new Spacer(1));
            this.box.addChild(new Text(streaming.join("\n"), 0, 0));
        }

        const output = this.outputText();
        if (!output) return;

        const lines = this.colorOutput(output.split("\n"));
        // Collapsed → short preview capped at the mode's collapsedLines;
        // expanded (ctrl+e) → the full output, no cap.
        const cap = uiStyle().tool.collapsedLines;
        const truncated = !this.expanded && lines.length > cap;
        const shown = truncated ? lines.slice(0, cap) : lines;

        this.box.addChild(new Spacer(1));
        this.box.addChild(new Text(shown.join("\n"), 0, 0));
        if (truncated) {
            this.box.addChild(
                new Text(
                    theme.fg("dim", `… +${lines.length - cap} lines (${uiStyle().hints.expandHint} to expand)`),
                    0,
                    0,
                ),
            );
        }
    }

    /** Title color by state: pending/stale grey, failed vivid red, done normal.
     * Modes with mutedCollapsed grey the finished title while folded. */
    private titleColor(): "muted" | "toolError" | "toolTitle" {
        if (this.isPartial || this.interrupted) return "muted";
        if (this.result?.isError) return "toolError";
        if (uiStyle().tool.mutedCollapsed && !this.expanded) return "muted";
        return "toolTitle";
    }

    /** `toolname summary` — bold name, muted single-line arg summary, cut to
     * `width` so it stays ONE line however long the summary is. */
    private titleLine(width: number): string {
        // Subagent header: `task <agent> · <state> · <prompt snippet>` where
        // state is the live tool while running, then done/failed.
        if (this.toolName === "task") {
            const agent = typeof this.args.agent === "string" ? this.args.agent : "default";
            const state = this.isPartial
                ? this.statusText || "running"
                : this.result?.isError
                  ? "failed"
                  : ["done", ...this.taskStatsParts()].join(" · ");
            const snippet = taskPromptSnippet(this.args);
            const bullet = uiStyle().tool.bullet;
            const title =
                (bullet ? theme.fg(this.titleColor(), `${bullet} `) : "") +
                theme.fg(this.titleColor(), theme.bold(`task ${agent}`));
            return fitAroundTail(`${title} `, theme.fg("muted", snippet ? `${state} · ${snippet}` : state), "", width);
        }
        const bullet = uiStyle().tool.bullet;
        const title =
            (bullet ? theme.fg(this.titleColor(), `${bullet} `) : "") +
            theme.fg(this.titleColor(), theme.bold(this.toolName));
        const summary = this.argsSummary();
        if (!summary) return title;
        // The range is a tail: it says WHICH lines were read, so it must not be
        // the part that disappears when the path is long.
        // `read` appends its offset/limit as a warning-colored `:start-end`
        // suffix; the range sits outside the muted wrap so it
        // keeps its own color.
        const range = this.toolName === "read" ? this.readLineRange() : "";
        // bash's summary is a shell command; colour it as one. Every other
        // tool's is a path or a pattern, which reads fine as a muted run.
        const shown = highlightToolSummary(this.toolName, summary) ?? theme.fg("muted", summary);
        return fitAroundTail(`${title} `, shown, range, width);
    }

    /** `12 steps · 41s · $0.0430` fragments — only what the run recorded. */
    private taskStatsParts(): string[] {
        const s = this.taskStats;
        if (!s) return [];
        const parts: string[] = [];
        if (s.steps) parts.push(`${s.steps} step${s.steps === 1 ? "" : "s"}`);
        if (s.durationMs !== undefined) parts.push(formatTaskDuration(s.durationMs));
        if (s.usd !== undefined) parts.push(`$${s.usd.toFixed(4)}`);
        return parts;
    }

    /**
     * The call's one-line receipt, computed once per result rather than once
     * per frame.
     *
     * The caching is not premature: a render walks every row in the transcript
     * and bash caps its output at 2000 lines, so deriving this inline would
     * re-split every one of them on every repaint — sixty times a second while
     * a rail animates.
     *
     * A running call has no result to report and an interrupted one never got
     * its own; both get "" and let the title's own status carry the state.
     */
    private receiptText(output: string): string {
        if (this.receipt === undefined) {
            this.receipt =
                this.isPartial || this.interrupted
                    ? ""
                    : formatToolReceipt(this.toolName, this.args, output, this.result?.isError ?? false);
        }
        return this.receipt;
    }

    /**
     * The few output lines a folded row shows, cached like the receipt and for
     * the same reason — both re-read the whole result.
     *
     * A running call is excluded because it already has a live tail of its own
     * (streaming content, a subagent's activity), and an interrupted one never
     * produced a result to preview.
     */
    private peekLines(output: string): ToolPeek {
        if (this.peek === undefined) {
            this.peek =
                this.isPartial || this.interrupted
                    ? { lines: [], hidden: 0 }
                    : toolPeek(
                          this.toolName,
                          output,
                          this.result?.isError ?? false,
                          uiStyle().tool.peekLines,
                          this.args,
                      );
        }
        return this.peek;
    }

    private argsSummary(): string {
        // Shared with the /tree row (tool-summary.ts) so both describe a call
        // the same way; the empty-args guard lives inside formatToolArgs.
        return formatToolArgs(this.toolName, this.args, this.cwd);
    }

    /**
     * `read` line range — `:start` or `:start-end` from offset/limit, empty
     * when neither is set. Themed wrap around the shared plain-text range.
     */
    private readLineRange(): string {
        const range = readLineRangeText(this.args);
        return range ? theme.fg("warning", range) : "";
    }

    /** Streamed input content while partial: the last few lines (or all of them
     * when expanded), syntax-highlighted by the target path. Only the shown tail
     * is highlighted — the full content may be large and this runs per delta. */
    private streamingLines(): string[] | null {
        if (!this.isPartial || this.result || !this.streamingContent) return null;
        const raw = this.streamingContent.split("\n");
        // Expanded mode is capped too: the preview re-highlights on every
        // flush, so an unbounded window froze the TUI on large files.
        const cap = this.expanded ? STREAMING_EXPANDED_LINES : uiStyle().tool.collapsedLines;
        const truncated = raw.length > cap;
        const shown = truncated ? raw.slice(-cap) : raw;
        const lang = getLanguageFromPath(String(this.args.path ?? ""));
        const lines = lang ? highlightCode(shown.join("\n"), lang) : shown.map((l) => theme.fg("toolOutput", l));
        if (!truncated) return lines;
        const hint = this.expanded ? "streaming" : `${uiStyle().hints.expandHint} to expand`;
        return [...lines, theme.fg("dim", `… +${raw.length - cap} earlier lines (${hint})`)];
    }

    /** sql: the query, highlighted as a SQL block under the title. */
    private inputPreview(): string[] | null {
        if (this.toolName !== "sql") return null;
        const query = typeof this.args.query === "string" ? this.args.query.trim() : "";
        if (!query) return null;
        return highlightCode(query, "sql");
    }

    private outputText(): string {
        if (!this.result) return "";
        const text = this.result.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text)
            .join("\n")
            .trimEnd();
        // An `artifact` result carries a JSON card payload for the desktop app
        // after its summary. The terminal has no card to draw, so it shows the
        // summary and drops the payload rather than printing raw JSON at the
        // user — `/artifacts` is where a terminal opens one.
        const summary = artifactResultSummary(text).trimEnd();
        const replay = this.editReplayDiff(summary);
        return replay ? `${summary}\n${replay}` : summary;
    }

    /**
     * The diff a REPLAYED edit no longer carries.
     *
     * `edit` keeps its diff out of the model's context via `toModelOutput`, and
     * the AI SDK persists the model-facing value — so the real diff rides the
     * live `tool-result` event and exists nowhere else. Replaying a session,
     * the call's own arguments are all that survive, and they are enough: the
     * model sent every oldText/newText pair.
     *
     * Line numbers are deliberately absent. The arguments never said where in
     * the file the blocks landed, and invented numbers sitting in the same
     * gutter as a live edit's real ones would be read as real.
     */
    private editReplayDiff(output: string): string | null {
        if (this.toolName !== "edit" || this.isPartial || this.result?.isError) return null;
        // A live edit carries its own real diff — never dress one up twice.
        if (!output || /^[+-]/m.test(output)) return null;
        const edits = this.args.edits;
        if (!Array.isArray(edits)) return null;
        const lines: string[] = [];
        for (const edit of edits as Array<{ oldText?: unknown; newText?: unknown }>) {
            if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") return null;
            for (const line of edit.oldText.split("\n")) lines.push(`-${line}`);
            for (const line of edit.newText.split("\n")) lines.push(`+${line}`);
        }
        if (lines.length === 0) return null;
        if (lines.length > REPLAY_DIFF_MAX_LINES) {
            const rest = lines.length - REPLAY_DIFF_MAX_LINES;
            return `${lines.slice(0, REPLAY_DIFF_MAX_LINES).join("\n")}\n… ${rest} more diff lines`;
        }
        return lines.join("\n");
    }

    private colorOutput(lines: string[]): string[] {
        if (this.result?.isError) {
            return lines.map((l) => theme.fg("toolError", l));
        }
        // edit/write results contain unified diffs — color +/- lines
        if (this.toolName === "edit" || this.toolName === "write") {
            return lines.map((l) => {
                if (l.startsWith("+")) return theme.fg("toolDiffAdded", l);
                if (l.startsWith("-")) return theme.fg("toolDiffRemoved", l);
                return theme.fg("toolDiffContext", l);
            });
        }
        if (this.toolName === "read") {
            const lang = getLanguageFromPath(String(this.args.path ?? this.args.file_path ?? ""));
            // Highlight first, then prepend the gutter: the line numbers are
            // chrome, and feeding them to the highlighter colors them as code.
            const body = lang ? highlightCode(lines.join("\n"), lang) : lines.map((l) => theme.fg("toolOutput", l));
            const gutters = readGutterPrefixes(lines, this.args);
            return body.map((l, i) => (gutters[i] ? theme.fg("dim", gutters[i]) + l : l));
        }
        return lines.map((l) => theme.fg("toolOutput", l));
    }
}
