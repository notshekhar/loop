/**
 * Message components — our chat-history renderers:
 * UserMessageComponent / AssistantMessageComponent /
 * SkillInvocationMessageComponent / CompactionSummaryMessageComponent /
 * parseSkillBlock / DynamicBorder.
 * Trimmed to what our chat history actually uses.
 */
import {
    Box,
    type Component,
    Container,
    Markdown,
    type MarkdownTheme,
    Spacer,
    Text,
    visibleWidth,
} from "@notshekhar/loop-tui";
import { getMarkdownTheme, theme, verticalRuleSlot } from "./theme";
import { type ThinkingBlockState, uiRenderers, uiStyle } from "./ui-mode";

// OSC 133 shell-integration zones — let terminals jump between messages
const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07";
const ZONE_FINAL = "\x1b]133;C\x07";

const expandHint = () => uiStyle().hints.expandHint;

export class DynamicBorder implements Component {
    private color: (str: string) => string;

    constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
        this.color = color;
    }

    invalidate(): void {}

    render(width: number): string[] {
        return [this.color("─".repeat(Math.max(1, width)))];
    }
}

/** Folded long entries keep this many rendered lines visible. */
const FOLDED_PREVIEW_LINES = 2;

/** Fold rendered lines to a short preview + a dim "+N lines" hint. Applied
 * only when the user folds an entry in nav — never by default — so the hint
 * is the nav per-entry expand key (expand-all doesn't reopen these). */
function foldLines(lines: string[], hint: string): string[] {
    if (lines.length <= FOLDED_PREVIEW_LINES + 1) return lines;
    return [
        ...lines.slice(0, FOLDED_PREVIEW_LINES),
        theme.fg("dim", ` … +${lines.length - FOLDED_PREVIEW_LINES} lines (${hint} to expand)`),
    ];
}

/**
 * The selection visual: a solid accent bar down the LEFT edge of every line
 * of the selected entry. Crucially it changes neither the entry's height nor
 * its width — a corner-border box (+2 lines, -4 cols) made the whole layout
 * shift on every selection move. The bar replaces each line's first visible
 * cell (entries all carry at least one column of margin), skipping any
 * leading ANSI codes so bg-painted box lines aren't corrupted.
 */
const LEADING_ANSI = /^(?:\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07)*/;
export function markSelectedLines(lines: string[]): string[] {
    // Every line gets the bar — including blank paragraph separators, so the
    // bar reads as one connected spine instead of dashes with gaps.
    return lines.map((l) => {
        const prefix = l.match(LEADING_ANSI)?.[0] ?? "";
        const rest = l.slice(prefix.length);
        // verticalRuleSlot, not theme.fg: `▌` is a BLOCK ELEMENT, and macOS
        // Terminal.app draws that family short of the cell box — so the
        // "connected spine" above came out as exactly the dashes it is meant
        // to avoid. There the bar is painted as a background instead, which
        // fills the whole cell and cannot gap. A selection bar is already a
        // solid mark, so the heavier treatment costs it nothing.
        return prefix + verticalRuleSlot("selectionBorder", "▌") + rest.slice(rest.length > 0 ? 1 : 0);
    });
}

/** `9:10 PM`, grok-style. */
export function fmtEntryTime(ts: number): string {
    const d = new Date(ts);
    const h24 = d.getHours();
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Right-align a timestamp on a text line within `width` cols. Markdown lines
 * arrive space-padded to full width — trim that first so there's room. */
function appendTimestamp(line: string, ts: number, width: number): string {
    const label = fmtEntryTime(ts);
    const trimmed = line.replace(/ +$/, "");
    const pad = width - visibleWidth(trimmed) - label.length - 1;
    if (pad < 1) return line;
    return trimmed + " ".repeat(pad) + theme.fg("timestamp", label) + " ";
}

/** Right-align a timestamp inside a bg-padded box line — the padding spaces
 * sit right before the closing `\x1b[49m`, so the label replaces their tail. */
const BOX_TAIL = /( +)(\x1b\[49m)$/;
function injectBoxTimestamp(line: string, ts: number): string {
    const label = fmtEntryTime(ts);
    const m = line.match(BOX_TAIL);
    if (!m || m[1].length < label.length + 2) return line;
    return line.replace(BOX_TAIL, (_all, spaces: string, reset: string) => {
        return spaces.slice(0, spaces.length - label.length - 1) + theme.fg("timestamp", label) + " " + reset;
    });
}

export class UserMessageComponent extends Container {
    private expanded = true;
    private selected = false;

    constructor(
        private text: string,
        private createdAt: number = Date.now(),
        markdownTheme: MarkdownTheme = getMarkdownTheme(),
    ) {
        super();
        const prefix = uiStyle().userMessage.prefix;
        const box = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
        box.addChild(
            new Markdown(prefix ? `${prefix} ${text}` : text, 0, 0, markdownTheme, {
                color: (content: string) => theme.fg("userMessageText", content),
            }),
        );
        this.addChild(box);
    }

    isExpanded(): boolean {
        return this.expanded;
    }
    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
    }
    setSelected(selected: boolean): void {
        this.selected = selected;
    }
    getText(): string {
        return this.text;
    }

    private renderInner(width: number): string[] {
        const override = uiRenderers().userMessage;
        let lines = (override ? override({ text: this.text }, { width, theme }) : null) ?? super.render(width);
        if (uiStyle().userMessage.timestamp && lines.length > 1) {
            lines[1] = injectBoxTimestamp(lines[1], this.createdAt);
        }
        if (!this.expanded) lines = foldLines(lines, uiStyle().hints.selectedExpandHint);
        return lines;
    }

    override render(width: number): string[] {
        let lines = this.renderInner(width);
        if (this.selected) lines = markSelectedLines(lines);
        if (lines.length === 0) return lines;
        lines[0] = ZONE_START + lines[0];
        lines[lines.length - 1] = ZONE_END + ZONE_FINAL + lines[lines.length - 1];
        return lines;
    }
}

/** A foldable transcript block the ctrl+up/down selection can address —
 * implemented by tool boxes directly and by thinking-block handles. */
export interface FoldableHandle {
    isExpanded(): boolean;
    setExpanded(expanded: boolean): void;
    setSelected(selected: boolean): void;
}

/** Marker carried by in-message block components (thinking/response text) so
 * range tracking can map rendered lines back to their transcript entry. */
export interface TrackedBlock {
    readonly blockKind: "thinking" | "response";
    readonly contentIndex: number;
}

/** Thinking content — dispatches to the mode's thinking renderer when one is
 * registered, else renders the default italic markdown. All state is read
 * fresh through getters: the component instances are recreated on every
 * streaming delta, so per-block state lives in the parent (keyed by content
 * index) and only flows through here. */
class ThinkingBlock implements Component, TrackedBlock {
    readonly blockKind = "thinking" as const;
    private md: Markdown;

    constructor(
        readonly contentIndex: number,
        private text: string,
        private state: () => Omit<ThinkingBlockState, "text">,
        markdownTheme: MarkdownTheme,
    ) {
        this.md = new Markdown(text, 1, 0, markdownTheme, {
            color: (t: string) => theme.fg("thinkingText", t),
            italic: true,
        });
    }

    /** Grow this block in place. The instance surviving the delta is the whole
     * point: it is what lets the markdown keep its settled head instead of
     * re-lexing the block from the top on every token. */
    setText(text: string): void {
        if (text === this.text) return;
        this.text = text;
        this.md.setText(text);
    }

    invalidate(): void {
        this.md.invalidate();
    }

    private renderInner(width: number): string[] {
        this.md.setStreaming(this.state().streaming);
        const override = uiRenderers().thinking;
        if (override) {
            const lines = override({ text: this.text, ...this.state() }, { width, theme });
            if (lines) return lines;
        }
        return this.md.render(width);
    }

    render(width: number): string[] {
        const lines = this.renderInner(width);
        return this.state().selected ? markSelectedLines(lines) : lines;
    }
}

/** An assistant response text block — selectable/foldable like tools and
 * thinking. Per-index state lives in the parent (instances are recreated on
 * every streaming delta). Folding is user-initiated only; the global
 * expand-all never folds responses. */
class ResponseTextBlock implements Component, TrackedBlock {
    readonly blockKind = "response" as const;
    private md: Markdown;

    constructor(
        readonly contentIndex: number,
        private text: string,
        private state: () => { expanded: boolean; selected: boolean; createdAt: number; streaming: boolean },
        markdownTheme: MarkdownTheme,
    ) {
        this.md = new Markdown(text, 1, 0, markdownTheme);
    }

    /** Grow this block in place — see ThinkingBlock.setText. */
    setText(text: string): void {
        if (text === this.text) return;
        this.text = text;
        this.md.setText(text);
    }

    invalidate(): void {
        this.md.invalidate();
    }

    private renderInner(width: number): string[] {
        const { expanded, createdAt, streaming } = this.state();
        this.md.setStreaming(streaming);
        let lines = this.md.render(width);
        if (uiStyle().userMessage.timestamp && !streaming && lines.length > 0) {
            lines[0] = appendTimestamp(lines[0], createdAt, width);
        }
        if (!expanded) lines = foldLines(lines, uiStyle().hints.selectedExpandHint);
        // Block-gap modes: the response block owns its single leading blank.
        if (uiStyle().layout.blockGaps) lines = ["", ...lines];
        return lines;
    }

    render(width: number): string[] {
        const lines = this.renderInner(width);
        return this.state().selected ? markSelectedLines(lines) : lines;
    }
}

export interface AssistantMessageLike {
    content: Array<
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
        | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    >;
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
}

export class AssistantMessageComponent extends Container {
    private contentContainer: Container;
    private markdownTheme: MarkdownTheme;
    private lastMessage?: AssistantMessageLike;
    private hasToolCalls = false;
    private done = false;
    private thinkingExpanded = false;
    /** Per-thinking-block individual toggles (content index → open/closed);
     * unset follows the global thinkingExpanded. Lives here, not on the
     * ThinkingBlock — those instances are recreated on every delta. */
    private thinkingOverride = new Map<number, boolean>();
    /** Content index of the selected thinking block, if any. */
    private selectedThinking: number | null = null;
    /** Per-response-text-block fold state (default open; global-toggle-immune). */
    private textOverride = new Map<number, boolean>();
    /** Content index of the selected response text block, if any. */
    private selectedText: number | null = null;
    /** Wall-clock timing per thinking block (start on first delta, end when
     * the turn moves on) — feeds "Thought for Xs" in block-style modes. */
    private thinkingTimes = new Map<number, { start: number; end?: number }>();
    /** Message time for the response timestamp (replay passes the real one). */
    private createdAt = Date.now();
    /** Live block components by content index, carried across deltas — see
     * updateContent. */
    private blocks = new Map<number, ResponseTextBlock | ThinkingBlock>();

    setCreatedAt(ts: number): void {
        this.createdAt = ts;
    }

    constructor(message?: AssistantMessageLike, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
        super();
        this.markdownTheme = markdownTheme;
        this.contentContainer = new Container();
        this.addChild(this.contentContainer);
        if (message) this.updateContent(message);
    }

    override invalidate(): void {
        super.invalidate();
        if (this.lastMessage) this.updateContent(this.lastMessage);
    }

    override render(width: number): string[] {
        return this.renderTracked(width).lines;
    }

    /** Render plus per-block line ranges — the transcript's click/scroll map
     * needs to know which lines belong to which thinking/response entry. */
    renderTracked(width: number): {
        lines: string[];
        blocks: Array<{ blockKind: "thinking" | "response"; contentIndex: number; start: number; end: number }>;
    } {
        const lines: string[] = [];
        const blocks: Array<{ blockKind: "thinking" | "response"; contentIndex: number; start: number; end: number }> =
            [];
        for (const child of this.contentContainer.children) {
            const start = lines.length;
            const childLines = child.render(width);
            const tracked = child as Partial<TrackedBlock>;
            if (
                (tracked.blockKind === "thinking" || tracked.blockKind === "response") &&
                childLines.length > 0 &&
                tracked.contentIndex !== undefined
            ) {
                blocks.push({
                    blockKind: tracked.blockKind,
                    contentIndex: tracked.contentIndex,
                    start,
                    end: start + childLines.length - 1,
                });
            }
            for (const l of childLines) lines.push(l);
        }
        if (!this.hasToolCalls && lines.length > 0) {
            lines[0] = ZONE_START + lines[0];
            lines[lines.length - 1] = ZONE_END + ZONE_FINAL + lines[lines.length - 1];
        }
        return { lines, blocks };
    }

    /** The live turn moved past this message (finished or handed off to a tool
     * call) — its thinking blocks stop counting as streaming. */
    markDone(): void {
        this.done = true;
        for (const t of this.thinkingTimes.values()) t.end ??= Date.now();
    }

    /** Rides the expand-all toggle (e in nav) — modes that fold finished thinking
     * blocks (grok) reopen them; the loop mode's inline display ignores it.
     * The global toggle clears individual overrides so "expand all" wins. */
    setThinkingExpanded(expanded: boolean): void {
        this.thinkingExpanded = expanded;
        this.thinkingOverride.clear();
    }

    /** Drop every per-block fold override, back to the mode's own defaults —
     * see ChatHistory.resetFolds for why leaving navigation does this. */
    resetFolds(): void {
        this.thinkingExpanded = false;
        this.thinkingOverride.clear();
        this.textOverride.clear();
        this.invalidate();
    }

    /** Start the wall clock for the thinking block at this content index. */
    noteThinkingStart(index: number): void {
        if (!this.thinkingTimes.has(index)) this.thinkingTimes.set(index, { start: Date.now() });
    }

    /** Set a known duration directly (replay of a persisted reasoningMs). */
    setThinkingDuration(index: number, ms: number): void {
        this.thinkingTimes.set(index, { start: 0, end: ms });
    }

    /** Close every open thinking clock (the stream moved on to text/tools). */
    noteThinkingEnd(): void {
        for (const t of this.thinkingTimes.values()) t.end ??= Date.now();
    }

    /** A stable selection/toggle handle for the thinking block at a content
     * index — survives the block components being recreated per delta. */
    thinkingHandle(index: number): FoldableHandle {
        return {
            isExpanded: () => this.thinkingOverride.get(index) ?? this.thinkingExpanded,
            setExpanded: (expanded) => {
                this.thinkingOverride.set(index, expanded);
                this.invalidate();
            },
            setSelected: (selected) => {
                this.selectedThinking = selected
                    ? index
                    : this.selectedThinking === index
                      ? null
                      : this.selectedThinking;
                this.invalidate();
            },
        };
    }

    /** Same, for the response text block at a content index. */
    textHandle(index: number): FoldableHandle {
        return {
            isExpanded: () => this.textOverride.get(index) ?? true,
            setExpanded: (expanded) => {
                this.textOverride.set(index, expanded);
                this.invalidate();
            },
            setSelected: (selected) => {
                this.selectedText = selected ? index : this.selectedText === index ? null : this.selectedText;
                this.invalidate();
            },
        };
    }

    /** Is this the block the stream is currently writing into? Read through
     * `lastMessage` rather than a captured message, so a reused block's state
     * getter always answers about the CURRENT turn. */
    private isLiveBlock(index: number): boolean {
        return !this.done && index === (this.lastMessage?.content.length ?? 0) - 1;
    }

    updateContent(message: AssistantMessageLike): void {
        this.lastMessage = message;
        this.contentContainer.clear();
        // Block components are carried over by content index instead of being
        // rebuilt. A rebuild meant a fresh Markdown per block per delta, so
        // every FINISHED block above the cursor — a long thinking block above
        // the answer, most of all — was re-lexed on every token: measured
        // 5.8ms a frame with a 20k-char thinking block, all of it redoing text
        // that can no longer change.
        const previous = this.blocks;
        this.blocks = new Map();

        // Block-gap modes: every block renders its own leading blank, so the
        // container-level spacers here would double every gap.
        const blockGaps = uiStyle().layout.blockGaps;
        const hasVisibleContent = message.content.some(
            (c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
        );
        if (hasVisibleContent && !blockGaps) this.contentContainer.addChild(new Spacer(1));

        for (let i = 0; i < message.content.length; i++) {
            const content = message.content[i];
            if (content.type === "text" && content.text.trim()) {
                const index = i;
                const cached = previous.get(index);
                const block =
                    cached instanceof ResponseTextBlock
                        ? cached
                        : new ResponseTextBlock(
                              index,
                              content.text.trim(),
                              () => ({
                                  expanded: this.textOverride.get(index) ?? true,
                                  selected: this.selectedText === index,
                                  createdAt: this.createdAt,
                                  streaming: this.isLiveBlock(index),
                              }),
                              this.markdownTheme,
                          );
                block.setText(content.text.trim());
                this.blocks.set(index, block);
                this.contentContainer.addChild(block);
            } else if (content.type === "thinking" && content.thinking.trim()) {
                const index = i;
                const cached = previous.get(index);
                const block =
                    cached instanceof ThinkingBlock
                        ? cached
                        : new ThinkingBlock(
                              index,
                              content.thinking.trim(),
                              () => {
                                  const time = this.thinkingTimes.get(index);
                                  return {
                                      streaming: this.isLiveBlock(index),
                                      expanded: this.thinkingOverride.get(index) ?? this.thinkingExpanded,
                                      selected: this.selectedThinking === index,
                                      durationMs: time?.end !== undefined ? time.end - time.start : undefined,
                                  };
                              },
                              this.markdownTheme,
                          );
                block.setText(content.thinking.trim());
                this.blocks.set(index, block);
                this.contentContainer.addChild(block);
                const hasVisibleContentAfter = message.content
                    .slice(i + 1)
                    .some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
                if (hasVisibleContentAfter && !blockGaps) this.contentContainer.addChild(new Spacer(1));
            }
        }

        this.hasToolCalls = message.content.some((c) => c.type === "toolCall");
        if (!this.hasToolCalls) {
            if (message.stopReason === "aborted") {
                const abortMessage =
                    message.errorMessage && message.errorMessage !== "Request was aborted"
                        ? message.errorMessage
                        : "Operation aborted";
                this.contentContainer.addChild(new Spacer(1));
                this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
            } else if (message.stopReason === "error") {
                this.contentContainer.addChild(new Spacer(1));
                this.contentContainer.addChild(
                    new Text(theme.fg("error", `Error: ${message.errorMessage || "Unknown error"}`), 1, 0),
                );
            }
        }
    }
}

export interface ParsedSkillBlock {
    name: string;
    location: string;
    content: string;
    userMessage: string | undefined;
}

export function parseSkillBlock(text: string): ParsedSkillBlock | null {
    const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
    if (!match) return null;
    return {
        name: match[1],
        location: match[2],
        content: match[3],
        userMessage: match[4]?.trim() || undefined,
    };
}

export class SkillInvocationMessageComponent extends Box {
    private expanded = false;

    constructor(
        private skillBlock: ParsedSkillBlock,
        private markdownTheme: MarkdownTheme = getMarkdownTheme(),
    ) {
        super(1, 1, (t) => theme.bg("customMessageBg", t));
        this.updateDisplay();
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
        this.updateDisplay();
    }

    override invalidate(): void {
        super.invalidate();
        this.updateDisplay();
    }

    private updateDisplay(): void {
        this.clear();
        if (this.expanded) {
            this.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[skill]\x1b[22m"), 0, 0));
            this.addChild(
                new Markdown(`**${this.skillBlock.name}**\n\n${this.skillBlock.content}`, 0, 0, this.markdownTheme, {
                    color: (text: string) => theme.fg("customMessageText", text),
                }),
            );
        } else {
            this.addChild(
                new Text(
                    theme.fg("customMessageLabel", "\x1b[1m[skill]\x1b[22m ") +
                        theme.fg("customMessageText", this.skillBlock.name) +
                        theme.fg("dim", ` (${expandHint()} to expand)`),
                    0,
                    0,
                ),
            );
        }
    }
}

export interface CompactionSummaryLike {
    summary: string;
    tokensBefore: number;
    timestamp?: number;
    /** A rollover's recovery record — shown in place of the (empty) summary. */
    handoff?: string;
}

export class CompactionSummaryMessageComponent extends Box {
    private expanded = false;

    constructor(
        private message: CompactionSummaryLike,
        private markdownTheme: MarkdownTheme = getMarkdownTheme(),
    ) {
        super(1, 1, (t) => theme.bg("customMessageBg", t));
        this.updateDisplay();
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
        this.updateDisplay();
    }

    override invalidate(): void {
        super.invalidate();
        this.updateDisplay();
    }

    private updateDisplay(): void {
        this.clear();
        const tokenStr = this.message.tokensBefore.toLocaleString();
        // A rollover has no summary at all — labelling it "compaction" and
        // rendering its empty summary would show a blank box above a window
        // whose history the user can still scroll to.
        const rollover = Boolean(this.message.handoff);
        const label = rollover ? "[fresh context]" : "[compaction]";
        const lead = rollover ? `Fresh window from ${tokenStr} tokens` : `Compacted from ${tokenStr} tokens`;
        const body = this.message.handoff ?? this.message.summary;
        this.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m${label}\x1b[22m`), 0, 0));
        this.addChild(new Spacer(1));
        if (this.expanded) {
            this.addChild(
                new Markdown(
                    `**${lead}**\n\n${body}`,
                    0,
                    0,
                    this.markdownTheme,
                    {
                        color: (text: string) => theme.fg("customMessageText", text),
                    },
                ),
            );
        } else {
            this.addChild(
                new Text(
                    theme.fg("customMessageText", `${lead} (`) +
                        theme.fg("dim", expandHint()) +
                        theme.fg("customMessageText", " to expand)"),
                    0,
                    0,
                ),
            );
        }
    }
}

/** Branch summary box — rendered when
 * /tree navigation summarized the abandoned branch. */
export class BranchSummaryMessageComponent extends Box {
    private expanded = false;

    constructor(
        private summary: string,
        private markdownTheme: MarkdownTheme = getMarkdownTheme(),
    ) {
        super(1, 1, (t) => theme.bg("customMessageBg", t));
        this.updateDisplay();
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
        this.updateDisplay();
    }

    override invalidate(): void {
        super.invalidate();
        this.updateDisplay();
    }

    private updateDisplay(): void {
        this.clear();
        this.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[branch]\x1b[22m"), 0, 0));
        this.addChild(new Spacer(1));
        if (this.expanded) {
            this.addChild(
                new Markdown(`**Branch Summary**\n\n${this.summary}`, 0, 0, this.markdownTheme, {
                    color: (text: string) => theme.fg("customMessageText", text),
                }),
            );
        } else {
            this.addChild(
                new Text(
                    theme.fg("customMessageText", "Branch summary (") +
                        theme.fg("dim", expandHint()) +
                        theme.fg("customMessageText", " to expand)"),
                    0,
                    0,
                ),
            );
        }
    }
}
