import { type Component, Container, Markdown, Spacer, type TUI } from "@notshekhar/loop-tui";
import { matchSessionHookContext, type BtwMeta, type TeamTurnMeta } from "@notshekhar/loop-core";
import { getMarkdownTheme, theme } from "../ui/theme";
import { getToolDetail } from "../ui/tool-detail";
import {
    BranchSummaryMessageComponent,
    CompactionSummaryMessageComponent,
    parseSkillBlock,
    SkillInvocationMessageComponent,
    UserMessageComponent,
} from "../ui/messages";
import { ToolExecutionComponent } from "../ui/tool-execution";
import { FoldView, OpenFolds } from "./transcript-fold-view";
import { dim, err } from "../ui/text";
import { type Foldable, foldSlots, standaloneFoldable, toolFoldable } from "./chat-history/foldables";
import { renderTranscript, type EntryRange } from "./chat-history/render";
import { TranscriptSelection } from "./chat-history/selection";
import { LiveAssistant, type PiAssistantMessage } from "./chat-history/live-assistant";
import { ExpandAll } from "./chat-history/expansion";
import { PendingToolCalls } from "./chat-history/tool-calls";
import {
    btwQuestionHeader,
    commandEcho,
    hookContextNotice,
    recapBody,
    teamCardLines,
    textRow,
    turnCompletedLine,
    turnFailedLine,
} from "./chat-history/notices";

export { stringifyResult } from "./chat-history/tool-calls";

/**
 * The transcript: places every block in arrival order and composes the parts
 * that act on it — the streaming assistant message, pending tool calls,
 * expand-all, the entry selection, and the fold-aware render.
 */
export class ChatHistory extends Container {
    private live = new LiveAssistant();
    private toolCalls = new PendingToolCalls();
    private expansion = new ExpandAll();
    private assistantTurn: Container | null = null;
    /** Every selectable entry in transcript order — user prompts, response
     * text, thinking, tool calls — addressable by the ctrl+up/down selection
     * (alt+up/down jumps between user turns). */
    private foldables: Foldable[] = [];
    /** Which folds the user opened — the only fold state that persists; the
     * folds themselves are derived per render (see foldView). */
    private openFolds = new OpenFolds();
    private selection = new TranscriptSelection({
        foldables: () => this.foldables,
        foldView: () => this.foldView(),
        openFolds: this.openFolds,
    });
    /** The startup status block's own container — see openStartupBlock. */
    private startupBlock: Container | null = null;

    constructor(
        private tui: TUI,
        private cwd: string,
    ) {
        super();
    }

    setToolsExpanded(expanded: boolean): void {
        this.expansion.set(expanded);
        // Expand-all reflows the whole transcript — bring the selection back.
        this.selection.requestReveal();
    }
    toggleToolsExpanded(): boolean {
        this.setToolsExpanded(!this.expansion.isExpanded());
        return this.expansion.isExpanded();
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
        this.expansion.resetAssistantFolds();
        for (const f of this.foldables) if (f.kind === "user") f.handle.setExpanded(true);
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

    private foldView(): FoldView {
        return FoldView.compute(foldSlots(this, this.foldables), this.openFolds);
    }

    override render(width: number): string[] {
        const ranges: EntryRange[] = [];
        this.selection.setRanges(ranges);
        return renderTranscript(this, width, {
            foldables: this.foldables,
            view: this.foldView(),
            selected: this.selection.selectedEntry(),
            ranges,
        });
    }

    // ------------------------------------------------------------------
    // Selection — see TranscriptSelection.
    // ------------------------------------------------------------------

    takeRevealRequest(): boolean {
        return this.selection.takeRevealRequest();
    }
    selectedRange(): { start: number; end: number } | null {
        return this.selection.selectedRange();
    }
    moveSelection(delta: -1 | 1): boolean {
        return this.selection.moveSelection(delta);
    }
    jumpTurn(delta: -1 | 1): boolean {
        return this.selection.jumpTurn(delta);
    }
    toggleSelected(): boolean {
        return this.selection.toggleSelected();
    }
    clearSelection(): boolean {
        return this.selection.clearSelection();
    }
    selectLast(): boolean {
        return this.selection.selectLast();
    }
    hasSelection(): boolean {
        return this.selection.hasSelection();
    }
    setSelectedExpanded(expanded: boolean): boolean {
        return this.selection.setSelectedExpanded(expanded);
    }
    getSelectedText(): string | null {
        return this.selection.getSelectedText();
    }
    clickAtLocalLine(line: number): boolean {
        return this.selection.clickAtLocalLine(line);
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
        this.live.reset();
        this.toolCalls.clear();
        this.expansion.clear();
        this.assistantTurn = null;
        this.foldables = [];
        this.selection.reset();
        // clear() dropped the container; a new one is opened by whoever rebuilds
        // the header, and until then startup lines append as they always did.
        this.startupBlock = null;
        // Holds component references from the transcript being discarded (/new,
        // /clear) — they can never match a new one, so keeping them is pure
        // retention of the old tree.
        this.openFolds.clear();
    }

    addUser(text: string, ts?: number): void {
        this.addChild(new Spacer(1));
        const prompt = this.addHookContextNotice(text);
        if (prompt !== null) this.addPrompt(prompt, ts);
        this.assistantTurn = null;
    }

    /**
     * SessionStart hook context is model-facing — collapse it to a dim notice
     * instead of rendering it as part of what the user typed. Applies to live
     * turns and to transcript replay on resume alike. Returns what the user
     * typed around it, or null when nothing is left.
     */
    private addHookContextNotice(text: string): string | null {
        const hookCtx = matchSessionHookContext(text);
        if (!hookCtx) return text;
        this.addChild(textRow(hookContextNotice(hookCtx.context)));
        if (!hookCtx.rest) return null;
        this.addChild(new Spacer(1));
        return hookCtx.rest;
    }

    /** A prompt: a skill invocation (with its message, if any) or a user box. */
    private addPrompt(text: string, ts?: number): void {
        const skill = parseSkillBlock(text);
        if (!skill) {
            this.addUserComponent(text, ts);
            return;
        }
        const comp = new SkillInvocationMessageComponent(skill);
        this.expansion.trackSkill(comp);
        this.addChild(comp);
        if (skill.userMessage) this.addUserComponent(skill.userMessage, ts);
    }

    /**
     * The question that opened a `/btw` side thread: typed by the user, so a
     * user box — under a tag saying where it was asked, because this session
     * is a copy of that one and would otherwise read as the same chat.
     */
    addBtwQuestion(btw: BtwMeta, text: string, ts?: number): void {
        this.addSpaced(this, textRow(btwQuestionHeader(btw)));
        this.addUserComponent(text, ts);
        this.assistantTurn = null;
    }

    /**
     * Something the thread team wrote into this conversation (core teams/):
     * a member's brief from its lead, or mail between threads. Drawn as a
     * card, not a user box — the user never typed it.
     *
     * Mail that reached the model between two steps (`midTurn`) goes inside
     * the turn it interrupted; anything else opens a turn, like a prompt.
     */
    addTeamCard(team: TeamTurnMeta, text: string): void {
        const lines = teamCardLines(team, text);
        if (lines.length === 0) return;
        const card = textRow(lines.join("\n"));
        if (team.midTurn) {
            // Inside the reply it interrupted: the next text block starts below it.
            this.finishAssistant();
            this.addSpaced(this.tail, card);
            return;
        }
        this.addSpaced(this, card);
        this.assistantTurn = null;
    }

    /** A user message box, registered as a selectable "user" turn entry. */
    private addUserComponent(text: string, ts?: number): void {
        const comp = new UserMessageComponent(text, ts);
        this.addChild(comp);
        this.foldables.push(standaloneFoldable("user", comp));
    }

    ensureAssistant(provider: string, model: string, ts?: number): void {
        if (!this.assistantTurn) {
            this.assistantTurn = new Container();
            // Each block carries its own leading blank, so a turn-level
            // spacer here would double the gap after the user box.
            this.addChild(this.assistantTurn);
        }
        if (this.live.isOpen()) return;
        const comp = this.live.open(provider, model, ts);
        this.expansion.trackAssistant(comp);
        this.assistantTurn.addChild(comp);
    }

    appendAssistantDelta(text: string, provider: string, model: string): void {
        this.ensureAssistant(provider, model);
        this.addFoldable(this.live.appendText(text));
    }

    appendAssistantThinking(text: string, provider: string, model: string, durationMs?: number): void {
        this.ensureAssistant(provider, model);
        this.addFoldable(this.live.appendThinking(text, durationMs));
    }

    private addFoldable(entry: Foldable | null): void {
        if (entry) this.foldables.push(entry);
    }

    finishAssistant(stopReason: PiAssistantMessage["stopReason"] = "stop"): void {
        this.live.finish(stopReason);
    }

    addToolCall(toolName: string, toolCallId: string, args: Record<string, unknown>): void {
        if (this.toolCalls.fillArgs(toolCallId, args)) return;
        this.live.closeWithToolCall(toolCallId, toolName, args);

        const comp = new ToolExecutionComponent(toolName, args, this.tui, this.cwd);
        // Tight inside a tool group; every other block owns its own leading
        // blank (layout.blockGaps), so a group's first row leads with one too.
        comp.setGroupLead(this.foldables.at(-1)?.kind !== "tool");
        this.expansion.trackTool(comp);
        this.tail.addChild(comp);
        this.toolCalls.track(toolCallId, comp);
        this.foldables.push(toolFoldable(comp));
    }

    /** Live status line in the tool title (subagent: current tool name). */
    setToolStatus(toolCallId: string, status: string): void {
        this.toolCalls.setStatus(toolCallId, status);
    }

    /** Live input fields of a still-streaming call (write: path + content so far). */
    updateToolInputStream(toolCallId: string, fields: Record<string, string>): void {
        this.toolCalls.updateInputStream(toolCallId, fields);
    }

    /** Live partial output (subagent streaming) — keeps the component pending. */
    updateToolProgress(toolCallId: string, text: string): void {
        this.toolCalls.updateProgress(toolCallId, text);
    }

    addToolResult(toolCallId: string, output: unknown, isError = false): void {
        this.toolCalls.complete(toolCallId, output, isError);
    }

    /** Abort landed while tool calls were still pending — freeze them as
     * "interrupted" so they don't show a running state forever. The persisted
     * transcript records whatever really completed; resume shows that. */
    markPendingToolsInterrupted(): void {
        this.toolCalls.interruptAll();
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

    /** A block that opens with a blank line of its own. */
    private addSpaced(parent: Container, block: Component): void {
        parent.addChild(new Spacer(1));
        parent.addChild(block);
    }

    addSystem(text: string): void {
        this.tail.addChild(textRow(dim(text)));
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
        const line = textRow(kind === "hook" ? theme.fg("hookAccent", text) : dim(text));
        (this.startupBlock ?? this).addChild(line);
    }

    /** The line that closes a turn that finished. */
    addTurnSummary(seconds: number): void {
        this.addSpaced(this.tail, textRow(turnCompletedLine(seconds)));
    }

    /**
     * The line that closes a turn that FAILED — grok's `TurnFailed`, and the
     * counterpart of addTurnSummary. One line says what happened and why;
     * there used to be an `error:` line followed by "Turn completed", which
     * contradicted it.
     */
    addTurnFailed(seconds: number, reason: string): void {
        this.addSpaced(this.tail, textRow(turnFailedLine(seconds, reason)));
    }

    /** Hook-related lines get their own orange accent, like tools get grey/green. */
    addHook(text: string): void {
        this.tail.addChild(textRow(theme.fg("hookAccent", text)));
    }

    /** Echo an executed slash command: highlighted /name, dim args. */
    addCommand(text: string): void {
        this.addSpaced(this, textRow(commandEcho(text)));
        this.assistantTurn = null;
    }

    /** Themed markdown block (changelog, release notes). */
    addMarkdown(md: string): void {
        this.addSpaced(this.tail, new Markdown(md, 1, 0, getMarkdownTheme()));
    }

    addCompactionSummary(
        summary: string,
        tokensBefore: number,
        timestamp = Date.now(),
        handoff?: string,
        focus?: string,
    ): void {
        const comp = new CompactionSummaryMessageComponent({ summary, tokensBefore, timestamp, handoff, focus });
        this.expansion.trackSummary(comp);
        this.addSpaced(this, comp);
        this.foldables.push(standaloneFoldable("compaction", comp));
        this.assistantTurn = null;
    }

    addBranchSummary(summary: string): void {
        const comp = new BranchSummaryMessageComponent(summary);
        // Rides the same expand/collapse toggle as compaction summaries.
        this.expansion.trackSummary(comp);
        this.addSpaced(this, comp);
        this.assistantTurn = null;
    }

    addError(text: string): void {
        this.tail.addChild(textRow(err(`error: ${text}`)));
    }

    /** Post-turn recap (data-recap): dim `※ recap:`-labelled lines under the response. */
    addRecap(text: string): void {
        this.addSpaced(this.tail, textRow(recapBody(text)));
    }
}
