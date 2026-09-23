import { Container, logRenderError, Markdown, Spacer, Text, truncateToWidth, type TUI } from "@notshekhar/loop-tui";
import { formatSubagentActivity, type SubagentActivityPart } from "@notshekhar/loop-core";
import { getMarkdownTheme, theme } from "../ui/theme";
import { renderToolGroup } from "../ui/blocks/tool-group";
import { getToolDetail } from "../ui/tool-detail";
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
import type { FoldSpan, RunStep } from "../transcript-folds";
import { FoldView, OpenFolds, type FoldParticipant, type FoldSlot } from "./transcript-fold-view";
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

/** `41s` under a minute, `1m23s` beyond — how a turn's length is said. */
function turnDuration(seconds: number): string {
    return seconds < 60 ? `${Math.round(seconds)}s` : formatTaskDuration(seconds * 1000);
}

/** A selectable transcript entry: a prompt, a response, a thought, a call. */
interface Foldable extends FoldParticipant {
    kind: "user" | "response" | "thinking" | "tool";
    handle: FoldableHandle;
    getText: () => string;
    /** Component that renders this entry (user/tool: the component itself;
     * thinking/response: the assistant message + content index) — lets range
     * tracking map rendered lines back to entries. */
    comp: unknown;
    contentIndex?: number;
}

/** Prompts, responses and thoughts are what a transcript is scrolled back
 * FOR, so they end any run of tool calls and are never counted into one. */
const NEVER_FOLDS = (): RunStep => ({ kind: "break" });

/**
 * Draw one piece of the transcript, and never let it take the frame down.
 *
 * The transcript is the one place arbitrary content reaches the renderer —
 * model output, tool output, whatever an extension returns — so it is the one
 * place a render can meet input nobody anticipated. A throw here used to
 * escape the whole frame, and a frame that throws paints nothing: the UI
 * looked frozen until a restart. Now the entry that failed draws a single
 * line saying so, the failure is logged once with its stack, and everything
 * around it keeps working.
 */
function drawSafely(where: string, width: number, draw: () => string[]): string[] {
    try {
        return draw();
    } catch (error) {
        return failedToDraw(where, width, error);
    }
}

/** The one line a piece of the transcript draws in place of itself when it
 * could not be drawn — logged once, with its stack, for the bug report. */
function failedToDraw(where: string, width: number, error: unknown): string[] {
    logRenderError(`transcript ${where}`, error);
    const message = error instanceof Error ? error.message : String(error);
    return [truncateToWidth(theme.fg("error", ` ⚠ could not draw this ${where}: ${message}`), width)];
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
    private foldables: Foldable[] = [];
    private selectedFoldable: number | null = null;
    /** Which folds the user opened — the only fold state that persists; the
     * folds themselves are derived per render (see foldView). */
    private openFolds = new OpenFolds();
    /** Line ranges per foldable within the last full render (click targets
     * and the scroll anchor). Rebuilt on every render. */
    private lastRanges: Array<{ fIdx: number; start: number; end: number }> = [];
    /** The startup status block's own container — see openStartupBlock. */
    private startupBlock: Container | null = null;
    /**
     * Set when a user action moved or reflowed the selection, so whoever owns
     * scrolling can bring it back into view — see {@link takeRevealRequest}.
     *
     * A flag rather than a scroll: this component renders the transcript and
     * knows where each entry sits in it, but the window onto that transcript
     * belongs to the frame (the terminal's own scroll, or the pinned layout's
     * ScrollView). It reports; the app moves.
     */
    private revealRequested = false;

    constructor(
        private tui: TUI,
        private cwd: string,
    ) {
        super();
        void this.tui;
        void this.cwd;
    }

    setToolsExpanded(expanded: boolean): void {
        this.expanded = expanded;
        for (const c of this.allToolComponents) c.setExpanded(expanded);
        for (const c of this.skillComponents) c.setExpanded(expanded);
        for (const c of this.compactionComponents) c.setExpanded(expanded);
        for (const c of this.assistantComponents) c.setThinkingExpanded(expanded);
        // Expand-all reflows the whole transcript — bring the selection back.
        this.revealRequested = true;
    }
    toggleToolsExpanded(): boolean {
        this.setToolsExpanded(!this.expanded);
        return this.expanded;
    }

    /**
     * Put every fold back the way the transcript draws it by default — called
     * on the way out of navigation.
     *
     * Opening things is what navigating is FOR: → on a group, Enter on a call,
     * `e` for everything. None of it is meant to outlive the trip; leaving
     * navigation returns the transcript to the state it was in before you
     * entered — groups closed, calls and thoughts folded, messages unfolded.
     * The one thing kept is the density you chose with `d`: a `full` density
     * is a setting, not an open.
     */
    resetFolds(): void {
        this.openFolds.clear();
        this.setToolsExpanded(getToolDetail() === "full");
        for (const c of this.assistantComponents) c.resetFolds();
        for (const f of this.foldables) if (f.kind === "user") f.handle.setExpanded(true);
    }

    /**
     * Whether a user action asked for the selection to be scrolled back into
     * view, clearing the request.
     *
     * The transcript never scrolls itself. It renders whole — the terminal
     * (or the pinned layout's ScrollView) is the window onto it, the same one
     * the wheel and PgUp already move — so navigating is not a mode with a
     * viewport of its own, it is the same page with one entry marked. What
     * this reports is only WHEN to look: a selection move or a fold, never a
     * passive repaint, so a streaming turn growing the selected entry cannot
     * drag the page down on every delta.
     */
    takeRevealRequest(): boolean {
        const requested = this.revealRequested;
        this.revealRequested = false;
        return requested;
    }

    /** Where the selected entry sits in the last render, in line numbers. */
    selectedRange(): { start: number; end: number } | null {
        if (this.selectedFoldable === null) return null;
        const r = this.lastRanges.find((x) => x.fIdx === this.selectedFoldable);
        return r ? { start: r.start, end: r.end } : null;
    }

    // ------------------------------------------------------------------
    // Folds
    //
    // Which entries this render draws, which it hides, and which stand a
    // header in for others. The rules are grok's (transcript-folds.ts); the
    // view is derived from scratch on every use rather than maintained
    // incrementally, because a call starting, finishing or being opened all
    // change membership, and deriving is O(entries) over a list already walked
    // once per render.
    // ------------------------------------------------------------------

    /**
     * The transcript in render order, as the fold pass sees it: each entry,
     * and a break for every visible row that is not one (a system line, an
     * error) — those end any run they interrupt, as they do in grok.
     */
    private foldSlots(): FoldSlot[] {
        const { single, blocks } = this.foldableIndex();
        const slots: FoldSlot[] = [];
        const visit = (children: ReadonlyArray<unknown>): void => {
            for (const child of children) {
                if (child instanceof AssistantMessageComponent) {
                    for (const i of blocks.get(child) ?? []) slots.push(this.foldables[i]);
                } else if (single.has(child)) {
                    slots.push(this.foldables[single.get(child)!]);
                } else if (child instanceof Spacer) {
                    continue;
                } else if (child instanceof Container) {
                    visit(child.children);
                } else {
                    slots.push(null);
                }
            }
        };
        visit(this.children);
        return slots;
    }

    private foldView(): FoldView {
        return FoldView.compute(this.foldSlots(), this.openFolds);
    }

    /**
     * Where each foldable lives in the component tree: a component that IS an
     * entry (a prompt, a call), or an assistant message holding several block
     * entries in content order.
     */
    private foldableIndex(): { single: Map<unknown, number>; blocks: Map<unknown, number[]> } {
        const single = new Map<unknown, number>();
        const blocks = new Map<unknown, number[]>();
        this.foldables.forEach((f, i) => {
            if (f.contentIndex === undefined) {
                single.set(f.comp, i);
                return;
            }
            const list = blocks.get(f.comp) ?? [];
            list.push(i);
            blocks.set(f.comp, list);
        });
        for (const list of blocks.values()) {
            list.sort((a, b) => this.foldables[a].contentIndex! - this.foldables[b].contentIndex!);
        }
        return { single, blocks };
    }

    /** A fold's header row, marked when its entry is the selection. */
    private renderFoldHeader(view: FoldView, span: FoldSpan, width: number, lead: boolean): string[] {
        const header = view.header(span);
        const selected =
            this.selectedFoldable !== null && this.foldables[this.selectedFoldable] === view.headerEntry(span);
        const lines = renderToolGroup(
            {
                label: header.label,
                failed: header.failed,
                running: header.running,
                selected,
                expanded: header.open,
                lead,
            },
            { width, theme },
        );
        return selected ? markSelectedLines(lines) : lines;
    }

    /**
     * Full transcript render with per-entry line ranges (lastRanges) — the
     * basis for click-to-select and for scrolling the selection into view.
     *
     * Each entry is drawn according to its fold role: as itself; not at all
     * (hidden inside a closed fold); or as the fold's header — alone while the
     * fold is closed, above its own rows once it is open.
     */
    private renderFull(width: number): string[] {
        const lines: string[] = [];
        this.lastRanges = [];
        const { single, blocks } = this.foldableIndex();
        const view = this.foldView();

        /** Append an entry's lines, recording which lines are that entry's. */
        const push = (fIdx: number, entryLines: readonly string[]): void => {
            const start = lines.length;
            for (const l of entryLines) lines.push(l);
            if (lines.length > start) this.lastRanges.push({ fIdx, start, end: lines.length - 1 });
        };

        /**
         * A tool call, drawn under its fold role: not at all while a closed run
         * hides it; as the run's header — alone while the run is closed, above
         * its own rows once it is open; or simply as itself.
         */
        const pushTool = (fIdx: number, call: ToolExecutionComponent): void => {
            const role = view.roleOf(this.foldables[fIdx]);
            if (role.kind === "hidden") return;
            if (role.kind === "self") {
                push(fIdx, drawSafely("tool call", width, () => call.render(width)));
                return;
            }
            const header = drawSafely("fold header", width, () =>
                this.renderFoldHeader(view, role.span, width, call.leadsWithGap()),
            );
            // Open, the header has already opened the block, so the row under
            // it is drawn without a blank line of its own.
            const below = role.span.open ? drawSafely("tool call", width, () => call.renderBelowHeader(width)) : [];
            push(fIdx, [...header, ...below]);
        };

        const walk = (children: ReadonlyArray<{ render(w: number): string[] }>): void => {
            for (const child of children) {
                if (child instanceof AssistantMessageComponent) {
                    let sub: ReturnType<AssistantMessageComponent["renderTracked"]>;
                    try {
                        sub = child.renderTracked(width);
                    } catch (error) {
                        for (const l of failedToDraw("message", width, error)) lines.push(l);
                        continue;
                    }
                    const byIndex = new Map((blocks.get(child) ?? []).map((i) => [this.foldables[i].contentIndex!, i]));
                    let cursor = 0;
                    for (const b of sub.blocks) {
                        // Lines between blocks (an error, an abort note) are the
                        // message's own and always drawn.
                        for (; cursor < b.start; cursor++) lines.push(sub.lines[cursor]);
                        const blockLines = sub.lines.slice(b.start, b.end + 1);
                        const fIdx = byIndex.get(b.contentIndex);
                        if (fIdx === undefined) for (const l of blockLines) lines.push(l);
                        else push(fIdx, blockLines);
                        cursor = b.end + 1;
                    }
                    for (; cursor < sub.lines.length; cursor++) lines.push(sub.lines[cursor]);
                } else if (single.has(child)) {
                    const fIdx = single.get(child)!;
                    if (child instanceof ToolExecutionComponent) pushTool(fIdx, child);
                    else push(fIdx, drawSafely(this.foldables[fIdx].kind, width, () => child.render(width)));
                } else if (child instanceof Container) {
                    // Plain grouping container (assistant turn) — its render is
                    // just child concatenation, so walking keeps line counts
                    // identical while reaching the components inside.
                    walk(child.children);
                } else {
                    for (const l of drawSafely("line", width, () => child.render(width))) lines.push(l);
                }
            }
        };
        walk(this.children);
        return lines;
    }

    override render(width: number): string[] {
        return this.renderFull(width);
    }

    private selectIndex(next: number): void {
        if (this.selectedFoldable !== null) this.foldables[this.selectedFoldable].handle.setSelected(false);
        this.selectedFoldable = next;
        this.foldables[next].handle.setSelected(true);
        this.revealRequested = true;
    }

    /** Move the entry selection (ctrl+up/down). Starts at the most recent
     * entry — the one on screen. Returns false when nothing is selectable. */
    moveSelection(delta: -1 | 1): boolean {
        if (this.foldables.length === 0) return false;
        const view = this.foldView();
        const prev = this.selectedFoldable;
        const from = prev === null ? this.foldables.length : prev;
        // Entries hidden inside a closed fold are not on screen, so the
        // selection steps over them — onto the fold's header, which is.
        for (let i = from + delta; i >= 0 && i < this.foldables.length; i += delta) {
            if (view.isHidden(this.foldables[i])) continue;
            this.selectIndex(i);
            return true;
        }
        // At either end: stay put, but a first press still selects something.
        if (prev === null) return this.selectLast();
        this.revealRequested = true;
        return true;
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
        if (this.selectedFoldable === null) return false;
        const f = this.foldables[this.selectedFoldable];
        // On a closed fold's header, Enter opens the fold — the same first
        // step as →, so the two keys never disagree about the row in front of
        // you.
        const view = this.foldView();
        const span = view.headedBy(f);
        if (span && !span.open) return this.setFoldOpen(view, span, true);
        if (f.kind === "response") return true;
        f.handle.setExpanded(!f.handle.isExpanded());
        this.revealRequested = true; // folding reflows — keep the entry in view
        return true;
    }

    /** Drop the selection (esc). Returns whether there was one to drop. */
    clearSelection(): boolean {
        if (this.selectedFoldable === null) return false;
        this.foldables[this.selectedFoldable].handle.setSelected(false);
        this.selectedFoldable = null;
        return true;
    }

    /** Select the most recent entry on screen (scrollback-focus entry point).
     * The newest entry may be hidden inside a closed fold, in which case its
     * header is what gets selected. */
    selectLast(): boolean {
        const view = this.foldView();
        for (let i = this.foldables.length - 1; i >= 0; i--) {
            if (view.isHidden(this.foldables[i])) continue;
            this.selectIndex(i);
            return true;
        }
        return false;
    }

    hasSelection(): boolean {
        return this.selectedFoldable !== null;
    }

    /**
     * Explicit open/close of the selected entry (Left/Right keys).
     *
     * One key walks the hierarchy in both directions, grok-style. → on a
     * closed fold's header opens the fold; → on a call opens the call. ← folds
     * an open call first; ← on a folded entry inside an open fold closes the
     * fold and moves the selection to its header — the row that now stands
     * for everything that just disappeared.
     */
    setSelectedExpanded(expanded: boolean): boolean {
        if (this.selectedFoldable === null) return false;
        const f = this.foldables[this.selectedFoldable];
        const view = this.foldView();

        if (expanded) {
            const span = view.headedBy(f);
            if (span && !span.open) return this.setFoldOpen(view, span, true);
        } else if (!f.handle.isExpanded() || f.kind === "response") {
            const span = view.spanContaining(f);
            if (span?.open) {
                this.setFoldOpen(view, span, false);
                this.selectIndex(this.foldables.indexOf(view.headerEntry(span) as Foldable));
                return true;
            }
        }

        if (f.kind === "response") return true; // responses never fold
        f.handle.setExpanded(expanded);
        this.revealRequested = true;
        return true;
    }

    /** Open or close every entry a fold covers (see OpenFolds for why every
     * entry is marked rather than the header alone). */
    private setFoldOpen(view: FoldView, span: FoldSpan, open: boolean): boolean {
        this.openFolds.set(view.entriesOf(span), open);
        this.revealRequested = true;
        return true;
    }

    /** The selected entry's plain-text content (y copy). */
    getSelectedText(): string | null {
        if (this.selectedFoldable === null) return null;
        return this.foldables[this.selectedFoldable].getText();
    }

    /** Select the entry that owns a line of the last render (0-based).
     * Returns false on a miss — the gaps between entries are not clickable. */
    clickAtLocalLine(line: number): boolean {
        const hit = this.lastRanges.find((r) => line >= r.start && line <= r.end);
        if (!hit) return false;
        this.selectIndex(hit.fIdx);
        return true;
    }

    reset(): void {
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
        this.openFolds.clear();
        this.lastRanges = [];
    }

    addUser(text: string, ts?: number): void {
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
        this.foldables.push({ kind: "user", handle: comp, getText: () => comp.getText(), comp, foldStep: NEVER_FOLDS });
    }

    ensureAssistant(provider: string, model: string, ts?: number): void {
        if (!this.assistantTurn) {
            this.assistantTurn = new Container();
            // Each block carries its own leading blank, so a turn-level
            // spacer here would double the gap after the user box.
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
                foldStep: NEVER_FOLDS,
            });
        }
        this.liveComponent!.updateContent(msg);
    }

    appendAssistantThinking(text: string, provider: string, model: string, durationMs?: number): void {
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
                // A thought is never folded into a run of tool calls: it is the
                // model's reasoning, not one of its actions, and it always keeps
                // its own row. It ends any run around it (grok folds finished
                // thoughts into runs; loop deliberately does not).
                foldStep: NEVER_FOLDS,
            });
        }
        this.liveComponent!.updateContent(msg);
    }

    finishAssistant(stopReason: PiAssistantMessage["stopReason"] = "stop"): void {
        if (this.liveMsg) {
            this.liveMsg.stopReason = stopReason;
            this.liveComponent?.markDone();
            this.liveComponent?.updateContent(this.liveMsg);
        }
        this.liveMsg = null;
        this.liveComponent = null;
    }

    addToolCall(toolName: string, toolCallId: string, args: Record<string, unknown>): void {
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
        this.tail.addChild(comp);
        this.toolComponents.set(toolCallId, comp);
        this.allToolComponents.push(comp);
        this.foldables.push({
            kind: "tool",
            handle: comp,
            getText: () => comp.copyText(),
            comp,
            foldStep: () => comp.foldStep(),
            member: () => comp.groupMember(),
        });
    }

    /** Live status line in the tool title (subagent: current tool name). */
    setToolStatus(toolCallId: string, status: string): void {
        this.toolComponents.get(toolCallId)?.updateStatus(status);
    }

    /** Live input fields of a still-streaming call (write: path + content so far). */
    updateToolInputStream(toolCallId: string, fields: Record<string, string>): void {
        this.toolComponents.get(toolCallId)?.updateStreamingInput(fields);
    }

    /** Live partial output (subagent streaming) — keeps the component pending. */
    updateToolProgress(toolCallId: string, text: string): void {
        this.toolComponents.get(toolCallId)?.updateResult({ content: [{ type: "text", text }], isError: false }, true);
    }

    addToolResult(toolCallId: string, output: unknown, isError = false): void {
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

    /**
     * Where the next line of the transcript goes.
     *
     * A turn's output streams into its own container, so anything appended to
     * the root while a turn is running lands BELOW the whole turn — and every
     * later line of that turn then streams in above it. That is how an error
     * came to stick to the bottom of the screen with the rest of the turn
     * piling up on top of it. grok keeps one flat list in arrival order; the
     * equivalent here is to append to the turn while it is the last thing in
     * the transcript, and to the root otherwise.
     */
    private get tail(): Container {
        return this.assistantTurn !== null && this.children.at(-1) === this.assistantTurn ? this.assistantTurn : this;
    }

    addSystem(text: string): void {
        this.tail.addChild(new Text(dim(text), 1, 0));
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
        this.startupBlock = new Container();
        this.addChild(this.startupBlock);
    }

    /** Add a line to the startup block; falls back to the end of the
     * transcript if no block is open (nothing is worse than losing it). */
    addStartupLine(text: string, kind: "system" | "hook" = "system"): void {
        const line = new Text(kind === "hook" ? theme.fg("hookAccent", text) : dim(text), 1, 0);
        if (this.startupBlock) this.startupBlock.addChild(line);
        else this.addChild(line);
    }

    /** Abort landed while tool calls were still pending — freeze them as
     * "interrupted" so they don't show a running state forever. The persisted
     * transcript records whatever really completed; resume shows that. */
    markPendingToolsInterrupted(): void {
        for (const comp of this.toolComponents.values()) comp.markInterrupted();
        this.toolComponents.clear();
    }

    /** The line that closes a turn that finished. */
    addTurnSummary(seconds: number): void {
        this.tail.addChild(new Spacer(1));
        this.tail.addChild(new Text(theme.fg("turnSummary", `Turn completed in ${turnDuration(seconds)}.`), 1, 0));
    }

    /**
     * The line that closes a turn that FAILED — grok's `TurnFailed`, and the
     * counterpart of addTurnSummary. One line says what happened and why;
     * there used to be an `error:` line followed by "Turn completed", which
     * contradicted it.
     */
    addTurnFailed(seconds: number, reason: string): void {
        this.tail.addChild(new Spacer(1));
        this.tail.addChild(new Text(err(`Turn failed in ${turnDuration(seconds)}: ${reason}`), 1, 0));
    }

    /** Hook-related lines get their own orange accent, like tools get grey/green. */
    addHook(text: string): void {
        this.tail.addChild(new Text(theme.fg("hookAccent", text), 1, 0));
    }

    /** Echo an executed slash command: highlighted /name, dim args. */
    addCommand(text: string): void {
        this.addChild(new Spacer(1));
        const space = text.indexOf(" ");
        const cmd = space < 0 ? text : text.slice(0, space);
        const rest = space < 0 ? "" : text.slice(space);
        this.addChild(new Text(accentTitle(cmd) + (rest ? dim(rest) : ""), 1, 0));
        this.assistantTurn = null;
    }

    /** Themed markdown block (changelog, release notes). */
    addMarkdown(md: string): void {
        this.tail.addChild(new Spacer(1));
        this.tail.addChild(new Markdown(md, 1, 0, getMarkdownTheme()));
    }

    addCompactionSummary(summary: string, tokensBefore: number, timestamp = Date.now(), handoff?: string): void {
        const comp = new CompactionSummaryMessageComponent({ summary, tokensBefore, timestamp, handoff });
        comp.setExpanded(this.expanded);
        this.addChild(new Spacer(1));
        this.addChild(comp);
        this.compactionComponents.push(comp);
        this.assistantTurn = null;
    }

    addBranchSummary(summary: string): void {
        const comp = new BranchSummaryMessageComponent(summary);
        comp.setExpanded(this.expanded);
        this.addChild(new Spacer(1));
        this.addChild(comp);
        // Rides the same expand/collapse toggle as compaction summaries.
        this.compactionComponents.push(comp as unknown as CompactionSummaryMessageComponent);
        this.assistantTurn = null;
    }

    addError(text: string): void {
        this.tail.addChild(new Text(err(`error: ${text}`), 1, 0));
    }

    /** Post-turn recap (data-recap): dim `※ recap:`-labelled lines under the response. */
    addRecap(text: string): void {
        const lines = text.split("\n");
        lines.push("(disable recaps in /settings)");
        const body = lines.map((l, i) => dim(i === 0 ? `※ recap: ${l}` : `  ${l}`)).join("\n");
        this.tail.addChild(new Spacer(1));
        this.tail.addChild(new Text(body, 1, 0));
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
