import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, type TUI } from "@notshekhar/loop-tui";
import { formatSubagentActivity, type SubagentActivityPart } from "@notshekhar/loop-core";
import { getMarkdownTheme, theme } from "../ui/theme";
import { uiRenderers, uiStyle, type ToolGroupMember } from "../ui/ui-mode";
import { formatTaskDuration } from "../ui/tool-execution";
import {
    AssistantMessageComponent,
    BranchSummaryMessageComponent,
    CompactionSummaryMessageComponent,
    type FoldableHandle,
    parseSkillBlock,
    markSelectedLines,
    SkillInvocationMessageComponent,
    UserMessageComponent,
} from "../ui/messages";
import { ToolExecutionComponent } from "../ui/tool-execution";
import { verbGroupLabel, type GroupMember } from "../ui/verb-group";
import { matchSessionHookContext } from "@notshekhar/loop-core";
import { accentTitle, dim, err } from "../ui/text";

interface PiAssistantMessage {
    role: "assistant";
    content: Array<
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
        | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    >;
    api: string;
    provider: string;
    model: string;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    };
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
    timestamp: number;
}

/**
 * Clamp a group header to the terminal width. A mixed run's label grows with
 * the number of kinds in it ("Read 4 files, Listed 3 dirs, Searched 2 patterns,
 * Fetched 1 website"), and an overflowing line trips the TUI's width crash
 * guard and takes the whole UI down with it.
 */
function fitGroupRow(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, Math.max(0, width - 1)) + "…" : line;
}

function emptyAssistantMessage(provider: string, model: string): PiAssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: "openai",
        provider,
        model,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

export class ChatHistory extends Container {
    private liveMsg: PiAssistantMessage | null = null;
    private liveComponent: AssistantMessageComponent | null = null;
    private toolComponents = new Map<string, ToolExecutionComponent>();
    private allToolComponents: ToolExecutionComponent[] = [];
    private skillComponents: SkillInvocationMessageComponent[] = [];
    private compactionComponents: CompactionSummaryMessageComponent[] = [];
    private assistantComponents: AssistantMessageComponent[] = [];
    private assistantTurn: Container | null = null;
    private expanded = false;
    /** Every selectable entry in transcript order — user prompts, response
     * text, thinking, tool calls — addressable by the ctrl+up/down selection
     * (alt+up/down jumps between user turns). */
    private foldables: Array<{
        kind: "user" | "response" | "thinking" | "tool";
        handle: FoldableHandle;
        getText: () => string;
        /** Component that renders this entry (user/tool: the component
         * itself; thinking/response: the assistant message + content index)
         * — lets range tracking map rendered lines back to entries. */
        comp: unknown;
        contentIndex?: number;
    }> = [];
    private selectedFoldable: number | null = null;
    /**
     * Members of verb groups the user has opened. Every member of an open run
     * is marked, not just its head — see isGroupOpen for why. Everything else
     * about grouping is derived per render, so this set is the only grouping
     * state that has to persist.
     */
    private expandedGroups = new Set<unknown>();
    /** Line ranges per foldable within the last full render (click targets
     * and the scroll anchor). Rebuilt on every render. */
    private lastRanges: Array<{ fIdx: number; start: number; end: number }> = [];
    /** The startup status block's own container — see openStartupBlock. */
    private startupBlock: Container | null = null;
    /** Full-transcript render cache, trusted only while the nav viewport is
     * on. Scrolling re-renders NOTHING — it slices these lines. Every content
     * mutation (deltas, tool updates, folds, selection) calls markDirty(). */
    private fullCache: {
        width: number;
        lines: string[];
        ranges: Array<{ fIdx: number; start: number; end: number }>;
    } | null = null;

    private markDirty(): void {
        this.fullCache = null;
    }

    override invalidate(): void {
        this.markDirty();
        super.invalidate();
    }
    /**
     * Window geometry of the last render, when the viewport shaped it.
     *
     * `lead` is how many rows the window puts BEFORE the transcript lines —
     * one clip indicator when it scrolls. Clicks land in window coordinates
     * and have to come back out in transcript ones.
     */
    private lastViewport: { offset: number; sliceLen: number; lead: number } | null = null;

    constructor(
        private tui: TUI,
        private cwd: string,
    ) {
        super();
        void this.tui;
        void this.cwd;
    }

    setToolsExpanded(expanded: boolean): void {
        this.markDirty();
        this.expanded = expanded;
        for (const c of this.allToolComponents) c.setExpanded(expanded);
        for (const c of this.skillComponents) c.setExpanded(expanded);
        for (const c of this.compactionComponents) c.setExpanded(expanded);
        for (const c of this.assistantComponents) c.setThinkingExpanded(expanded);
        // Expand-all reflows the whole transcript — re-anchor on the selection.
        if (this.navViewport) this.pendingAnchor = true;
    }
    toggleToolsExpanded(): boolean {
        this.setToolsExpanded(!this.expanded);
        return this.expanded;
    }

    /**
     * Put every fold back to the mode's default. Called on the way out of
     * navigation.
     *
     * Expanding is a navigation affordance: `e`, →, and Enter exist so you can
     * read a tool's output while stepping through the transcript. Those opens
     * used to survive the trip back to the prompt, leaving chat mode in a
     * shape the user never chose — groups broken open, every tool output
     * unfolded — and chat mode has no key to put them back, since the fold
     * chords only exist inside navigation. So leaving navigation restores the
     * default view: grouped where the mode groups, collapsed where it folds.
     */
    resetFolds(): void {
        this.markDirty();
        // Verb groups the user opened close again; grouping is otherwise
        // derived per render, so this set is the whole of the group state.
        this.expandedGroups.clear();
        // Tool/skill/compaction bodies and thinking blocks all default closed.
        this.setToolsExpanded(false);
        // Per-block overrides on assistant messages (thinking + response text)
        // are not reachable through setToolsExpanded.
        for (const c of this.assistantComponents) c.resetFolds();
    }

    // NAVIGATION (Tab/ctrl+e) owns a WINDOW: loop takes the scrolling off the
    // terminal so that stepping through entries and opening folds never jumps
    // the screen. It is a mode you enter and leave, and while you are in it
    // loop holds the mouse.
    private navViewport = false;
    private viewportOffset = 0;
    /** Anchor the window to the selection on the NEXT render only. Set by
     * user actions (selection moves, folds) — never by passive re-renders,
     * so a streaming turn growing the selected entry can't drag the window
     * to the bottom on every delta. */
    private pendingAnchor = false;
    /** Rows the chrome below the transcript is using this frame; see setReserveRows. */
    private reserveRows: (() => number) | null = null;
    /** Width of the last render, to notice a resize re-wrapping the transcript. */
    private lastRenderWidth = 0;
    /** Entry at the top of the window last render — what a resize re-anchors on. */
    private topAnchorFIdx: number | null = null;

    setViewport(on: boolean): void {
        this.markDirty();
        this.navViewport = on;
        this.pendingAnchor = true;
        if (on) this.viewportOffset = Number.MAX_SAFE_INTEGER; // clamp to bottom
    }

    /**
     * How many rows everything BELOW the transcript is taking right now.
     *
     * The navigation window is the terminal's height minus this, so a wrong
     * answer sizes the window wrong. It cannot be a constant — the editor
     * grows with the draft, and the loader, the todo panel and queued messages
     * come and go mid-turn — so the app measures the real thing.
     *
     * Measured at ~1µs; see the call site in app.ts before caching it.
     */
    setReserveRows(fn: () => number): void {
        this.reserveRows = fn;
    }

    /** Rows left for the transcript once the chrome has taken its share. */
    private rowsForTranscript(): number {
        // The fallback matches the chrome's idle height, and is what nav mode
        // ran on before the measurement existed.
        return this.tui.terminal.rows - (this.reserveRows?.() ?? 8);
    }

    /** Rows the NAVIGATION window may use. */
    private viewportRows(): number {
        return Math.max(6, this.rowsForTranscript());
    }

    /** Page height for PgUp/PgDn (full page minus one line of continuity). */
    viewportPage(): number {
        return Math.max(1, this.viewportRows() - 1);
    }

    /** Manual scroll (navigation only): moves the window; the selection stays. */
    scrollViewportLines(delta: number): void {
        this.viewportOffset = Math.max(0, this.viewportOffset + delta);
        this.pendingAnchor = false;
    }

    /** Jump the window to the very top/bottom (Home/End, navigation only). */
    scrollViewportEdge(edge: "top" | "bottom"): void {
        this.viewportOffset = edge === "top" ? 0 : Number.MAX_SAFE_INTEGER;
        this.pendingAnchor = false;
    }

    // ------------------------------------------------------------------
    // Verb groups: the second fold level (live mode only)
    //
    // A run of consecutive finished, folded tool rows collapses into ONE
    // aggregated header — "Read 3 files". That makes the transcript a
    // two-level fold, which is the whole navigation model: open the group to
    // see which calls it was, open a call to see what it returned.
    //
    // The runs are DERIVED on every use rather than maintained incrementally.
    // A tool row finishing, opening, or folding changes run membership, and an
    // incrementally-maintained model would have to hook all of those; deriving
    // is O(entries) over a list that is already walked once per render.
    // ------------------------------------------------------------------

    /** Runs of ≥2 adjacent groupable tool entries, as foldable-index ranges. */
    private groupRuns(): Array<{ start: number; end: number }> {
        if (!uiStyle().tool.group) return [];
        const runs: Array<{ start: number; end: number }> = [];
        let start = -1;
        const groupable = (i: number): boolean => {
            const f = this.foldables[i];
            return f?.kind === "tool" && f.comp instanceof ToolExecutionComponent && f.comp.isGroupable();
        };
        for (let i = 0; i <= this.foldables.length; i++) {
            if (i < this.foldables.length && groupable(i)) {
                if (start < 0) start = i;
                continue;
            }
            // One member is enough, as in grok (`RunScan::folds`): "Read 1
            // file" is already tighter than the row it replaces, and folding
            // from the first call means a second one joining an existing
            // header instead of the row visibly collapsing under you.
            if (start >= 0) runs.push({ start, end: i - 1 });
            start = -1;
        }
        return runs;
    }

    /**
     * True when this run is currently open.
     *
     * Openness is remembered against EVERY member, not just the head, because
     * a run's head is not stable: expanding the first call drops it out of the
     * run (an open call is not groupable), which promotes the second call to
     * head. Keyed on the head alone, that lookup would miss and the remaining
     * calls would snap shut into a fresh "Read 2 files" — the group appearing
     * to re-collapse itself the moment you opened something inside it. grok
     * solves the same problem by migrating the key
     * (`selection.rs:rekey_verb_group_expansion`); holding every member is the
     * same fix without a migration step to keep in sync.
     */
    private isGroupOpen(run: { start: number; end: number }): boolean {
        for (let i = run.start; i <= run.end; i++) {
            if (this.expandedGroups.has(this.foldables[i]?.comp)) return true;
        }
        return false;
    }

    /** Open/close a whole run, marking every member so the state survives its
     * head changing (see isGroupOpen). */
    private setGroupOpen(run: { start: number; end: number }, open: boolean): void {
        for (let i = run.start; i <= run.end; i++) {
            const comp = this.foldables[i]?.comp;
            if (open) this.expandedGroups.add(comp);
            else this.expandedGroups.delete(comp);
        }
    }

    /**
     * The collapsed group a foldable is hidden inside, if any. The run's FIRST
     * entry is never hidden — it renders as the header row and stays the
     * selectable stand-in for the whole group.
     */
    private collapsedGroupOf(i: number): { start: number; end: number } | null {
        for (const run of this.groupRuns()) {
            if (i > run.start && i <= run.end && !this.isGroupOpen(run)) return run;
        }
        return null;
    }

    /**
     * Aggregated header for a collapsed run — one segment per KIND, so a mixed
     * run reads "Listed 2 dirs, Read 1 file" rather than an anonymous count.
     * See verb-group.ts for the vocabulary and how unknown tools degrade.
     *
     * A run only ever holds FINISHED calls (a running one is not groupable),
     * so the label lands in the past tense; `isRunning` is still passed
     * honestly rather than hardcoded, so the vocabulary's present tense stays
     * correct if a live member is ever admitted again.
     */
    private groupLabel(run: { start: number; end: number }): { text: string; failed: number } {
        const members: GroupMember[] = [];
        for (let i = run.start; i <= run.end; i++) {
            const c = this.foldables[i].comp;
            if (c instanceof ToolExecutionComponent) {
                members.push({ toolName: c.getToolName(), isError: c.hasError(), isRunning: c.isRunning() });
            }
        }
        return verbGroupLabel(members);
    }

    /**
     * The one-line stand-in for a collapsed run: `◈ Read 2 files, Listed 1 dir`.
     *
     * `◈` (a diamond containing a diamond), deliberately: `◆` is what an
     * individual call wears, and a group header is a different KIND of row — a
     * fold standing in for several calls, not one more call — so it reads as
     * the container it is. Same glyph grok uses for the same distinction.
     *
     * The failure count rides in the theme's error colour rather than the
     * muted one: a fold that hides a failure has to say so, or folding becomes
     * a way to lose bad news.
     */
    private renderGroupHeader(
        header: { text: string; failed: number; run: { start: number; end: number } },
        width: number,
        selected: boolean,
    ): string[] {
        // A mode may render the group itself — naming the calls it swallowed
        // rather than only counting them. Without one, the default single line.
        const override = uiRenderers().toolGroup;
        if (override) {
            const members: ToolGroupMember[] = [];
            for (let i = header.run.start; i <= header.run.end; i++) {
                const c = this.foldables[i].comp;
                if (c instanceof ToolExecutionComponent) members.push(c.groupMember());
            }
            const custom = override({ label: header.text, failed: header.failed, members, selected }, { width, theme });
            if (custom) return selected ? markSelectedLines(custom) : custom;
        }
        const hint = selected ? theme.fg("dim", ` (${uiStyle().hints.selectedExpandHint} to open)`) : "";
        const failed = header.failed > 0 ? theme.fg("toolError", ` · ${header.failed} failed`) : "";
        const row =
            "   " + theme.fg("muted", "◈") + " " + theme.fg(selected ? "text" : "muted", header.text) + failed + hint;
        const lines = ["", fitGroupRow(row, width)];
        return selected ? markSelectedLines(lines) : lines;
    }

    /** Full transcript render with per-entry line ranges (lastRanges). This
     * replaces Container.render so every foldable knows exactly which lines
     * it produced — the basis for click-to-select and the scroll anchor. */
    private renderFull(width: number): string[] {
        const lines: string[] = [];
        this.lastRanges = [];
        const compIdx = new Map<unknown, number>();
        const blockIdx = new Map<unknown, Map<number, number>>();
        this.foldables.forEach((f, i) => {
            if (f.contentIndex === undefined) {
                compIdx.set(f.comp, i);
            } else {
                let m = blockIdx.get(f.comp);
                if (!m) {
                    m = new Map();
                    blockIdx.set(f.comp, m);
                }
                m.set(f.contentIndex, i);
            }
        });
        // Collapsed groups: the first member's component renders the aggregated
        // header instead of its own row, and the rest render nothing at all.
        const groupHeader = new Map<
            unknown,
            { text: string; fIdx: number; failed: number; run: { start: number; end: number } }
        >();
        const groupHidden = new Set<unknown>();
        for (const run of this.groupRuns()) {
            if (this.isGroupOpen(run)) continue;
            groupHeader.set(this.foldables[run.start].comp, { ...this.groupLabel(run), fIdx: run.start, run });
            for (let i = run.start + 1; i <= run.end; i++) groupHidden.add(this.foldables[i].comp);
        }

        const walk = (children: ReadonlyArray<{ render(w: number): string[] }>): void => {
            for (const child of children) {
                if (groupHidden.has(child)) continue;
                const header = groupHeader.get(child);
                if (header) {
                    const start = lines.length;
                    const selected = this.selectedFoldable === header.fIdx;
                    for (const l of this.renderGroupHeader(header, width, selected)) lines.push(l);
                    this.lastRanges.push({ fIdx: header.fIdx, start, end: Math.max(start, lines.length - 1) });
                    continue;
                }
                if (child instanceof AssistantMessageComponent) {
                    const start = lines.length;
                    const sub = child.renderTracked(width);
                    const m = blockIdx.get(child);
                    if (m) {
                        for (const b of sub.blocks) {
                            const fIdx = m.get(b.contentIndex);
                            if (fIdx !== undefined) {
                                this.lastRanges.push({ fIdx, start: start + b.start, end: start + b.end });
                            }
                        }
                    }
                    for (const l of sub.lines) lines.push(l);
                } else if (compIdx.has(child)) {
                    const start = lines.length;
                    const childLines = child.render(width);
                    this.lastRanges.push({
                        fIdx: compIdx.get(child)!,
                        start,
                        end: Math.max(start, start + childLines.length - 1),
                    });
                    for (const l of childLines) lines.push(l);
                } else if (child instanceof Container) {
                    // Plain grouping container (assistant turn) — its render is
                    // just child concatenation, so walking keeps line counts
                    // identical while reaching the components inside.
                    walk(child.children);
                } else {
                    for (const l of child.render(width)) lines.push(l);
                }
            }
        };
        walk(this.children);
        return lines;
    }

    override render(width: number): string[] {
        const viewport = this.navViewport;
        let full: string[];
        if (viewport && this.fullCache && this.fullCache.width === width) {
            full = this.fullCache.lines;
            this.lastRanges = this.fullCache.ranges;
        } else {
            full = this.renderFull(width);
            this.fullCache = viewport ? { width, lines: full, ranges: this.lastRanges } : null;
        }
        this.lastViewport = null;
        // Not navigating: the whole transcript goes out as-is and the terminal
        // does what terminals do with it — scroll it, hold it in scrollback,
        // let you select it.
        if (!viewport) return full;

        // A width change re-wraps the whole transcript, so the offset — a line
        // index — silently comes to mean a different place, and a window that
        // was parked on something teleports away from it. Re-find the entry
        // that was at the top of the window and park on that instead.
        const widthChanged = this.lastRenderWidth !== 0 && this.lastRenderWidth !== width;
        this.lastRenderWidth = width;
        if (widthChanged && this.topAnchorFIdx !== null) {
            const r = this.lastRanges.find((x) => x.fIdx === this.topAnchorFIdx);
            // No range means the top of the window was in a gap between
            // entries (spacers, system lines) — nothing to anchor to, so the
            // raw offset stands, which is what happened before this existed.
            if (r) this.viewportOffset = r.start;
        }

        const rows = this.viewportRows();
        if (full.length <= rows) {
            // Short enough to show whole. Navigation is a temporary mode, so
            // leaving it where it already is keeps Tab from shunting the screen
            // around.
            return full;
        }

        // The selected entry's line range is the scroll anchor — applied once
        // per user action, then cleared (see pendingAnchor).
        if (this.pendingAnchor && this.selectedFoldable !== null) {
            const r = this.lastRanges.find((x) => x.fIdx === this.selectedFoldable);
            if (r) {
                const inner = rows - 2; // leave room for the clip indicators
                // An entry taller than the window pins to its TOP — trying to
                // fit both ends made the window ping-pong between them.
                const tall = r.end - r.start + 1 > inner;
                if (tall || r.start < this.viewportOffset + 1) this.viewportOffset = Math.max(0, r.start - 1);
                else if (r.end > this.viewportOffset + inner - 1) this.viewportOffset = r.end - inner + 1;
                this.pendingAnchor = false;
            }
        }

        // The window is sliced by ARRAY INDEX, which assumes one rendered line
        // costs one terminal row. That holds because nothing in loop's
        // transcript emits an inline graphic: attachments render as `[image:
        // …]` text, and the TUI's Image component (inherited from the fork) is
        // never constructed here. If that ever changes, this slice has to stop
        // cutting through an image's reserved rows — a kitty image is one array
        // entry plus blank filler entries, and a slice that keeps the header
        // but drops the fillers paints the picture straight over the prompt.
        const maxOffset = full.length - (rows - 2);
        this.viewportOffset = Math.max(0, Math.min(this.viewportOffset, maxOffset));
        // Remember what is at the top of the window, so a resize can put it
        // back there. The first entry still on screen — one whose range has
        // not ended above the window — is what the eye reads as "where I am".
        this.topAnchorFIdx = this.lastRanges.find((r) => r.end >= this.viewportOffset)?.fIdx ?? null;
        const hasTop = this.viewportOffset > 0;
        const inner = rows - 2;
        const hasBottom = this.viewportOffset + inner < full.length;
        const slice = full.slice(this.viewportOffset, this.viewportOffset + inner);
        const above = this.viewportOffset;
        const below = full.length - this.viewportOffset - slice.length;
        // One lead row here: the top clip indicator.
        this.lastViewport = { offset: this.viewportOffset, sliceLen: slice.length, lead: 1 };
        return [
            hasTop ? theme.fg("dim", `   ▲ ${above} more line${above === 1 ? "" : "s"}`) : "",
            ...slice,
            hasBottom ? theme.fg("dim", `   ▼ ${below} more line${below === 1 ? "" : "s"}`) : "",
        ];
    }

    private selectIndex(next: number): void {
        this.markDirty();
        if (this.selectedFoldable !== null) this.foldables[this.selectedFoldable].handle.setSelected(false);
        this.selectedFoldable = next;
        this.foldables[next].handle.setSelected(true);
        this.pendingAnchor = true;
    }

    /** Move the entry selection (ctrl+up/down). Starts at the most recent
     * entry — the one on screen. Returns false when nothing is selectable. */
    moveSelection(delta: -1 | 1): boolean {
        if (this.foldables.length === 0) return false;
        const prev = this.selectedFoldable;
        let next =
            prev === null ? this.foldables.length - 1 : Math.max(0, Math.min(this.foldables.length - 1, prev + delta));
        // Entries hidden inside a collapsed group are not on screen, so the
        // selection must not stop on them — it lands on the group's header
        // (its first member) and the group opens from there.
        next = this.visibleSelectable(next, delta);
        this.selectIndex(next);
        return true;
    }

    /**
     * Walk from `i` in `delta` until the entry is actually visible, i.e. not
     * swallowed by a collapsed group. Falls back to the group's header rather
     * than running off the end, so there is always somewhere to land.
     */
    private visibleSelectable(i: number, delta: -1 | 1): number {
        let at = i;
        for (let guard = 0; guard < this.foldables.length; guard++) {
            const run = this.collapsedGroupOf(at);
            if (!run) return at;
            const step = at + delta;
            if (step < 0 || step >= this.foldables.length) return run.start;
            at = step;
        }
        return at;
    }

    /** Jump the selection to the previous/next user turn (alt+up/down). */
    jumpTurn(delta: -1 | 1): boolean {
        if (this.foldables.length === 0) return false;
        const from = this.selectedFoldable ?? this.foldables.length;
        for (let i = from + delta; i >= 0 && i < this.foldables.length; i += delta) {
            // User prompts never group, so a hit here is always on screen.
            if (this.foldables[i].kind === "user") {
                this.selectIndex(i);
                return true;
            }
        }
        return false;
    }

    /** Toggle the selected entry only. Returns false when nothing is selected
     * (the caller falls back to the global expand-all). Response text is
     * selectable (navigation, y-copy) but never folds — collapsing the
     * conversation itself reads as data loss. */
    toggleSelected(): boolean {
        this.markDirty();
        if (this.selectedFoldable === null) return false;
        const i = this.selectedFoldable;
        const f = this.foldables[i];
        // On a closed group header, Enter opens the group — same first step as
        // → , so the two keys never disagree about what the row in front of
        // you does.
        const run = this.groupRuns().find((r) => r.start === i);
        if (run && !this.isGroupOpen(run)) {
            this.setGroupOpen(run, true);
            this.pendingAnchor = true;
            return true;
        }
        if (f.kind === "response") return true;
        f.handle.setExpanded(!f.handle.isExpanded());
        this.pendingAnchor = true; // folding reflows — keep the entry in view
        return true;
    }

    /** Drop the selection (esc). Returns whether there was one to drop. */
    clearSelection(): boolean {
        this.markDirty();
        if (this.selectedFoldable === null) return false;
        this.foldables[this.selectedFoldable].handle.setSelected(false);
        this.selectedFoldable = null;
        return true;
    }

    /** Select the most recent entry (scrollback-focus entry point). */
    selectLast(): boolean {
        if (this.foldables.length === 0) return false;
        // The newest entry may be buried inside a collapsed group; land on
        // that group's header instead of on a row that isn't drawn.
        this.selectIndex(this.visibleSelectable(this.foldables.length - 1, -1));
        return true;
    }

    hasSelection(): boolean {
        return this.selectedFoldable !== null;
    }

    /**
     * Explicit open/close of the selected entry (Left/Right keys).
     *
     * Two-level, grok-style: when the selection sits on a COLLAPSED group's
     * header, the arrow acts on the group — → reveals its calls — and only
     * once the group is open does → on a call reveal that call's output. The
     * reverse on the way back: ← folds the call, and ← again on an already
     * folded first member closes the whole group. So one key walks the
     * hierarchy in both directions instead of needing a separate group chord.
     */
    setSelectedExpanded(expanded: boolean): boolean {
        this.markDirty();
        if (this.selectedFoldable === null) return false;
        const i = this.selectedFoldable;
        const f = this.foldables[i];

        const run = this.groupRuns().find((r) => r.start === i);
        if (run) {
            const open = this.isGroupOpen(run);
            if (expanded && !open) {
                this.setGroupOpen(run, true);
                this.pendingAnchor = true;
                return true;
            }
            // Closing: fold the entry first if it is open, else close the group.
            if (!expanded && open && !f.handle.isExpanded()) {
                this.setGroupOpen(run, false);
                this.pendingAnchor = true;
                return true;
            }
        }

        if (f.kind === "response") return true; // responses never fold
        f.handle.setExpanded(expanded);
        this.pendingAnchor = true;
        return true;
    }

    /** The selected entry's plain-text content (y copy). */
    getSelectedText(): string | null {
        if (this.selectedFoldable === null) return null;
        return this.foldables[this.selectedFoldable].getText();
    }

    /** Select the entry under a clicked line (0-based within this component's
     * last rendered output). Translates through the viewport window and the
     * range map from that render. Returns false on a miss (gaps, indicators). */
    clickAtLocalLine(local: number): boolean {
        let line = local;
        if (this.lastViewport) {
            // Window layout: [lead rows, ...slice, trailing rows].
            const { lead, sliceLen, offset } = this.lastViewport;
            if (local < lead || local >= lead + sliceLen) return false;
            line = offset + (local - lead);
        }
        const hit = this.lastRanges.find((r) => line >= r.start && line <= r.end);
        if (!hit) return false;
        this.selectIndex(hit.fIdx);
        return true;
    }

    reset(): void {
        this.markDirty();
        // The transcript that follows shares nothing with the one being
        // dropped, so the renderer must not diff them against each other: line
        // 0 of the new one is not line 0 of the old one. Without this, /new
        // leaves the previous conversation on screen with a fresh prompt under
        // it, because the diff compares unrelated lines and concludes the top
        // of the screen is fine as it is.
        this.tui.resetFrame();
        this.clear();
        this.liveMsg = null;
        this.liveComponent = null;
        this.toolComponents.clear();
        this.allToolComponents = [];
        this.skillComponents = [];
        this.compactionComponents = [];
        this.assistantComponents = [];
        this.assistantTurn = null;
        this.foldables = [];
        this.selectedFoldable = null;
        // clear() dropped the container; a new one is opened by whoever rebuilds
        // the header, and until then startup lines append as they always did.
        this.startupBlock = null;
        // Holds component references from the transcript being discarded (/new,
        // /clear) — they can never match a new one, so keeping them is pure
        // retention of the old tree.
        this.expandedGroups.clear();
        this.lastRanges = [];
        this.lastViewport = null;
        // A fresh transcript (/new, /clear, a mode switch) opens at its top.
        this.viewportOffset = 0;
    }

    addUser(text: string, ts?: number): void {
        this.markDirty();
        this.addChild(new Spacer(1));
        // SessionStart hook context is model-facing — collapse it to a dim notice
        // instead of rendering it as part of what the user typed. Applies to live
        // turns and to transcript replay on resume alike.
        const hookCtx = matchSessionHookContext(text);
        if (hookCtx) {
            const lines = hookCtx.context.split("\n").length;
            this.addChild(
                new Text(theme.fg("hookAccent", `session-start hook context attached (${lines} lines)`), 1, 0),
            );
            text = hookCtx.rest;
            if (!text) {
                this.assistantTurn = null;
                return;
            }
            this.addChild(new Spacer(1));
        }
        const skill = parseSkillBlock(text);
        if (skill) {
            const comp = new SkillInvocationMessageComponent(skill);
            comp.setExpanded(this.expanded);
            this.addChild(comp);
            this.skillComponents.push(comp);
            if (skill.userMessage) {
                this.addUserComponent(skill.userMessage, ts);
            }
        } else {
            this.addUserComponent(text, ts);
        }
        this.assistantTurn = null;
    }

    /** A user message box, registered as a selectable "user" turn entry. */
    private addUserComponent(text: string, ts?: number): void {
        const comp = new UserMessageComponent(text, ts);
        this.addChild(comp);
        this.foldables.push({ kind: "user", handle: comp, getText: () => comp.getText(), comp });
    }

    ensureAssistant(provider: string, model: string, ts?: number): void {
        this.markDirty();
        if (!this.assistantTurn) {
            this.assistantTurn = new Container();
            // Block-gap modes: each block carries its own leading blank, so
            // the turn-level spacer would double the gap after the user box.
            if (!uiStyle().layout.blockGaps) this.addChild(new Spacer(1));
            this.addChild(this.assistantTurn);
        }
        if (this.liveComponent) return;
        this.liveMsg = emptyAssistantMessage(provider, model);
        this.liveComponent = new AssistantMessageComponent(this.liveMsg);
        if (ts !== undefined) this.liveComponent.setCreatedAt(ts);
        this.liveComponent.setThinkingExpanded(this.expanded);
        this.assistantComponents.push(this.liveComponent);
        this.assistantTurn.addChild(this.liveComponent);
    }

    appendAssistantDelta(text: string, provider: string, model: string): void {
        this.markDirty();
        this.ensureAssistant(provider, model);
        const msg = this.liveMsg!;
        const last = msg.content[msg.content.length - 1];
        if (last && last.type === "text") {
            last.text += text;
        } else {
            const entry = { type: "text" as const, text };
            msg.content.push(entry);
            // The stream moved past any thinking — close its wall clock.
            this.liveComponent!.noteThinkingEnd();
            this.foldables.push({
                kind: "response",
                handle: this.liveComponent!.textHandle(msg.content.length - 1),
                getText: () => entry.text,
                comp: this.liveComponent!,
                contentIndex: msg.content.length - 1,
            });
        }
        this.liveComponent!.updateContent(msg);
    }

    appendAssistantThinking(text: string, provider: string, model: string, durationMs?: number): void {
        this.markDirty();
        this.ensureAssistant(provider, model);
        const msg = this.liveMsg!;
        const last = msg.content[msg.content.length - 1];
        if (last && last.type === "thinking") {
            last.thinking += text;
        } else {
            const entry = { type: "thinking" as const, thinking: text };
            msg.content.push(entry);
            const index = msg.content.length - 1;
            // Replay passes the persisted duration; live streaming starts the
            // wall clock instead.
            if (durationMs !== undefined) this.liveComponent!.setThinkingDuration(index, durationMs);
            else this.liveComponent!.noteThinkingStart(index);
            this.foldables.push({
                kind: "thinking",
                handle: this.liveComponent!.thinkingHandle(index),
                getText: () => entry.thinking,
                comp: this.liveComponent!,
                contentIndex: index,
            });
        }
        this.liveComponent!.updateContent(msg);
    }

    finishAssistant(stopReason: PiAssistantMessage["stopReason"] = "stop"): void {
        this.markDirty();
        if (this.liveMsg) {
            this.liveMsg.stopReason = stopReason;
            this.liveComponent?.markDone();
            this.liveComponent?.updateContent(this.liveMsg);
        }
        this.liveMsg = null;
        this.liveComponent = null;
    }

    addToolCall(toolName: string, toolCallId: string, args: Record<string, unknown>): void {
        this.markDirty();
        // The box may already exist from a `tool-input-start` stub — fill in the
        // args on it (once they've finished streaming) instead of duplicating it.
        const existing = this.toolComponents.get(toolCallId);
        if (existing) {
            if (Object.keys(args).length > 0) existing.updateArgs(args);
            return;
        }

        if (this.liveMsg) {
            this.liveMsg.content.push({ type: "toolCall", id: toolCallId, name: toolName, arguments: args });
            this.liveComponent?.markDone();
            this.liveComponent?.updateContent(this.liveMsg);
        }
        this.liveMsg = null;
        this.liveComponent = null;

        const comp = new ToolExecutionComponent(toolName, args, this.tui, this.cwd);
        // Tight inside a tool group; every other block owns its own leading
        // blank (layout.blockGaps), so a group's first row leads with one too.
        const prevKind = this.foldables.length > 0 ? this.foldables[this.foldables.length - 1].kind : null;
        comp.setGroupLead(prevKind !== "tool");
        if (this.expanded) comp.setExpanded(true);
        (this.assistantTurn ?? this).addChild(comp);
        this.toolComponents.set(toolCallId, comp);
        this.allToolComponents.push(comp);
        this.foldables.push({ kind: "tool", handle: comp, getText: () => comp.copyText(), comp });
    }

    /** Live status line in the tool title (subagent: current tool name). */
    setToolStatus(toolCallId: string, status: string): void {
        this.markDirty();
        this.toolComponents.get(toolCallId)?.updateStatus(status);
    }

    /** Live input fields of a still-streaming call (write: path + content so far). */
    updateToolInputStream(toolCallId: string, fields: Record<string, string>): void {
        this.markDirty();
        this.toolComponents.get(toolCallId)?.updateStreamingInput(fields);
    }

    /** Live partial output (subagent streaming) — keeps the component pending. */
    updateToolProgress(toolCallId: string, text: string): void {
        this.markDirty();
        this.toolComponents.get(toolCallId)?.updateResult({ content: [{ type: "text", text }], isError: false }, true);
    }

    addToolResult(toolCallId: string, output: unknown, isError = false): void {
        this.markDirty();
        const comp = this.toolComponents.get(toolCallId);
        if (!comp) return;
        // Task output carries a run summary — surfaces steps/duration/cost in
        // the done title (live runs and replayed sessions alike).
        const stats = (output as { stats?: { steps?: number; durationMs?: number; usd?: number } } | null)?.stats;
        if (stats && typeof stats === "object") comp.setTaskStats(stats);
        const text = stringifyResult(output);
        comp.updateResult({ content: [{ type: "text", text }], isError }, false);
        this.toolComponents.delete(toolCallId);
    }

    addSystem(text: string): void {
        this.markDirty();
        this.addChild(new Text(dim(text), 1, 0));
    }

    /**
     * Open the region that holds the startup status block — everything the
     * header says about this session: workspace context, skills, extensions,
     * hooks, MCP servers.
     *
     * It exists because those lines do not all arrive at once. The hooks list
     * cannot be written until the trust prompt is answered, and MCP servers
     * report when they connect, both of them long after the transcript of a
     * resumed conversation is on screen. Appending them then put them at the
     * bottom, under the whole conversation, which is not where the block they
     * belong to is. Holding a container open means a line that arrives late
     * still lands with its own kind.
     */
    openStartupBlock(): void {
        this.markDirty();
        this.startupBlock = new Container();
        this.addChild(this.startupBlock);
    }

    /** Add a line to the startup block; falls back to the end of the
     * transcript if no block is open (nothing is worse than losing it). */
    addStartupLine(text: string, kind: "system" | "hook" = "system"): void {
        this.markDirty();
        const line = new Text(kind === "hook" ? theme.fg("hookAccent", text) : dim(text), 1, 0);
        if (this.startupBlock) this.startupBlock.addChild(line);
        else this.addChild(line);
    }

    /** Abort landed while tool calls were still pending — freeze them as
     * "interrupted" so they don't show a running state forever. The persisted
     * transcript records whatever really completed; resume shows that. */
    markPendingToolsInterrupted(): void {
        this.markDirty();
        for (const comp of this.toolComponents.values()) comp.markInterrupted();
        this.toolComponents.clear();
    }

    /** Modes with turn.summaryLine print this after each finished turn. */
    addTurnSummary(seconds: number): void {
        this.markDirty();
        const dur = seconds < 60 ? `${Math.round(seconds)}s` : formatTaskDuration(seconds * 1000);
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.fg("turnSummary", `Turn completed in ${dur}.`), 1, 0));
    }

    /** Hook-related lines get their own orange accent, like tools get grey/green. */
    addHook(text: string): void {
        this.markDirty();
        this.addChild(new Text(theme.fg("hookAccent", text), 1, 0));
    }

    /** Echo an executed slash command: highlighted /name, dim args. */
    addCommand(text: string): void {
        this.markDirty();
        this.addChild(new Spacer(1));
        const space = text.indexOf(" ");
        const cmd = space < 0 ? text : text.slice(0, space);
        const rest = space < 0 ? "" : text.slice(space);
        this.addChild(new Text(accentTitle(cmd) + (rest ? dim(rest) : ""), 1, 0));
        this.assistantTurn = null;
    }

    /** Themed markdown block (changelog, release notes). */
    addMarkdown(md: string): void {
        this.markDirty();
        this.addChild(new Spacer(1));
        this.addChild(new Markdown(md, 1, 0, getMarkdownTheme()));
    }

    addCompactionSummary(summary: string, tokensBefore: number, timestamp = Date.now(), handoff?: string): void {
        this.markDirty();
        const comp = new CompactionSummaryMessageComponent({ summary, tokensBefore, timestamp, handoff });
        comp.setExpanded(this.expanded);
        this.addChild(new Spacer(1));
        this.addChild(comp);
        this.compactionComponents.push(comp);
        this.assistantTurn = null;
    }

    addBranchSummary(summary: string): void {
        this.markDirty();
        const comp = new BranchSummaryMessageComponent(summary);
        comp.setExpanded(this.expanded);
        this.addChild(new Spacer(1));
        this.addChild(comp);
        // Rides the same expand/collapse toggle as compaction summaries.
        this.compactionComponents.push(comp as unknown as CompactionSummaryMessageComponent);
        this.assistantTurn = null;
    }

    addError(text: string): void {
        this.markDirty();
        this.addChild(new Text(err(`error: ${text}`), 1, 0));
    }

    /** Post-turn recap (data-recap): dim `※ recap:`-labelled lines under the response. */
    addRecap(text: string): void {
        this.markDirty();
        const lines = text.split("\n");
        lines.push("(disable recaps in /settings)");
        const body = lines.map((l, i) => dim(i === 0 ? `※ recap: ${l}` : `  ${l}`)).join("\n");
        this.addChild(new Spacer(1));
        this.addChild(new Text(body, 1, 0));
    }
}

export function stringifyResult(output: unknown): string {
    if (output == null) return "";
    if (typeof output === "string") return output;
    const o = output as Record<string, unknown>;
    // AI-SDK tool-result output shape { type, value } — used by replayed
    // (persisted) tool results. Unwrap to the underlying text/JSON.
    if (typeof o.type === "string" && "value" in o) {
        const v = o.value;
        if (o.type === "text" || o.type === "error-text") return typeof v === "string" ? v : String(v ?? "");
        if (o.type === "json" || o.type === "error-json") return JSON.stringify(v, null, 2);
        if (o.type === "content" && Array.isArray(v)) {
            return v
                .map((part) => (part?.type === "text" ? part.text : ""))
                .filter(Boolean)
                .join("\n");
        }
    }
    // Task (subagent) output: structured run log; flatten for display. The
    // last text part is the final report, so nothing is appended twice.
    if (Array.isArray(o.history)) {
        return (
            formatSubagentActivity(o.history as SubagentActivityPart[]) ||
            (typeof o.report === "string" ? o.report : "")
        );
    }
    if (typeof o.stdout === "string" || typeof o.stderr === "string") {
        return `${o.stdout ?? ""}${o.stderr ? `\n[stderr]\n${o.stderr}` : ""}`.trim();
    }
    if (typeof o.content === "string") return o.content;
    // Raw MCP CallToolResult shape — the LIVE tool-result event carries this
    // ({ content: [{type:"text", text}], structuredContent?, isError? }), while
    // the persisted entry carries the toModelOutput shape ({type:"content",
    // value}). Unwrap the text blocks the same way so runtime and resume render
    // identically instead of the live view dumping a raw JSON blob. Fall back to
    // structuredContent if the server sent no text content.
    if (Array.isArray(o.content)) {
        const text = (o.content as Array<{ type?: string; text?: string }>)
            .filter((p) => p?.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
        if (text) return text;
        if (o.structuredContent != null) return JSON.stringify(o.structuredContent, null, 2);
    }
    if (typeof o.matches === "string") return o.matches;
    if (Array.isArray((o as { paths?: unknown }).paths)) return (o as { paths: string[] }).paths.join("\n");
    if (Array.isArray((o as { entries?: unknown }).entries)) {
        return (o as { entries: { name: string; type: string }[] }).entries
            .map((e) => (e.type === "dir" ? `${e.name}/` : e.name))
            .join("\n");
    }
    return JSON.stringify(output, null, 2);
}
