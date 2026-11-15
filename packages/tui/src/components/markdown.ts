import type { Token, Tokens } from "marked";
import type { Component } from "../component";
import { isImageLine } from "../terminal-image";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils";
import { renderBlock } from "./markdown/blocks";
import { type MarkdownContext, stylePrefixOf } from "./markdown/context";
import { DiagramRenderer } from "./markdown/diagram";
import { renderInline } from "./markdown/inline";
import { markdownParser } from "./markdown/parser";
import { freezePoint, trimPartialClosingFences } from "./markdown/streaming";
import type { DefaultTextStyle, InlineStyleContext, MarkdownOptions, MarkdownTheme } from "./markdown/types";

export type { DefaultTextStyle, MarkdownOptions, MarkdownTheme } from "./markdown/types";

/** The settled head of a streaming document: `src` renders to exactly `lines` at `width`. */
interface StableHead {
    width: number;
    src: string;
    lines: string[];
}

export class Markdown implements Component {
    private text: string;
    private paddingX: number; // Left/right padding
    private paddingY: number; // Top/bottom padding
    private defaultTextStyle?: DefaultTextStyle;
    private theme: MarkdownTheme;
    private options: MarkdownOptions;
    private defaultStylePrefix?: string;

    // Cache for rendered output
    private cachedText?: string;
    private cachedWidth?: number;
    private cachedLines?: string[];
    /** Streaming mode: the text is still being appended to (see setStreaming). */
    private streaming = false;
    /**
     * The settled head of a streaming document: `src` renders to exactly
     * `lines`, and nothing arriving after it can change that (see
     * freezePoint). While it holds, a delta only re-lexes the tail.
     *
     * Without it, every token re-lexed the whole message: measured 23.8ms for
     * a 50k-char response, 15.8ms of it inside the lexer, on every delta AND
     * on every 80ms loader tick — past ~30k chars a single frame no longer fit
     * in the render budget.
     */
    private stable?: StableHead;
    private readonly diagrams = new DiagramRenderer();
    private readonly context: MarkdownContext;

    constructor(
        text: string,
        paddingX: number,
        paddingY: number,
        theme: MarkdownTheme,
        defaultTextStyle?: DefaultTextStyle,
        options?: MarkdownOptions,
    ) {
        this.text = text;
        this.paddingX = paddingX;
        this.paddingY = paddingY;
        this.theme = theme;
        this.defaultTextStyle = defaultTextStyle;
        this.options = options ? { ...options } : {};
        this.context = this.createContext();
    }

    setText(text: string): void {
        this.text = text;
        this.clearRenderCache();
    }

    /**
     * Whether this text is still streaming in.
     *
     * On (and only on) the way in does the incremental head get built, so a
     * static document renders exactly as it always did. On the way OUT the
     * head is thrown away and the finished text is rendered once, whole: that
     * final pass is authoritative, and it is what covers the one thing
     * incremental lexing cannot see — a link reference definition
     * (`[foo]: url`) arriving after the `[foo]` that uses it, which is only
     * resolvable when the lexer sees the whole document.
     */
    setStreaming(streaming: boolean): void {
        if (this.streaming === streaming) return;
        this.streaming = streaming;
        this.stable = undefined;
        if (!streaming) this.invalidate();
    }

    invalidate(): void {
        this.clearRenderCache();
        this.stable = undefined;
        this.diagrams.clear();
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
            return this.cachedLines;
        }
        // Calculate available width for content (subtract horizontal padding)
        const contentWidth = Math.max(1, width - this.paddingX * 2);
        const text = this.options.transform?.(this.text, contentWidth) ?? this.text;
        if (!text || text.trim() === "") {
            return this.cacheResult(width, []);
        }
        // Replace tabs with 3 spaces for consistent rendering
        const contentLines = this.renderContent(text.replace(/\t/g, "   "), width, contentWidth);
        const padding = this.paddingRows(width);
        const result = this.cacheResult(width, padding.concat(contentLines, padding));
        return result.length > 0 ? result : [""];
    }

    /**
     * Lex and render the document. While streaming, everything up to the
     * settled head was rendered on an earlier delta and cannot have changed,
     * so only the tail is lexed.
     */
    private renderContent(text: string, width: number, contentWidth: number): string[] {
        const head =
            this.stable && this.stable.width === width && text.startsWith(this.stable.src) ? this.stable : undefined;
        const tailText = head ? text.slice(head.src.length) : text;
        const tokens = markdownParser.lexer(tailText);
        trimPartialClosingFences(tokens);

        // Wrap and add margins token by token, so each token's span of
        // finished lines is known — that span is what the streaming head is
        // cut from.
        const tailLines: string[] = [];
        const tokenEnds: number[] = [];
        tokens.forEach((token, i) => {
            for (const line of renderBlock(this.context, token, contentWidth, tokens[i + 1]?.type)) {
                tailLines.push(...this.finishLine(line, width, contentWidth));
            }
            tokenEnds.push(tailLines.length);
        });
        if (this.streaming) this.advanceStable(head, tokens, tokenEnds, tailLines, tailText, width);
        return head ? head.lines.concat(tailLines) : tailLines;
    }

    /** Wrap a rendered line to the content width, then add margins and the background (or plain padding). */
    private finishLine(line: string, width: number, contentWidth: number): string[] {
        if (isImageLine(line)) return [line];
        const margin = " ".repeat(this.paddingX);
        return wrapTextWithAnsi(line, contentWidth).map((wrapped) => this.fillRow(margin + wrapped + margin, width));
    }

    private fillRow(line: string, width: number): string {
        const bgFn = this.defaultTextStyle?.bgColor;
        if (bgFn) return applyBackgroundToLine(line, width, bgFn);
        return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    }

    /** The top (and bottom) padding rows. */
    private paddingRows(width: number): string[] {
        const emptyLine = " ".repeat(width);
        const bgFn = this.defaultTextStyle?.bgColor;
        const row = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
        const rows: string[] = [];
        for (let i = 0; i < this.paddingY; i++) rows.push(row);
        return rows;
    }

    private cacheResult(width: number, lines: string[]): string[] {
        this.cachedText = this.text;
        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }

    private clearRenderCache(): void {
        this.cachedText = undefined;
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    /**
     * Push the settled head forward over whatever this render just sealed.
     *
     * The frozen source is rebuilt from the tokens' own `raw` and checked back
     * against the text before it is trusted: if marked's raws ever stop
     * reconstructing the source exactly, the head is dropped and the next
     * render lexes the whole document, which is only the old cost — never a
     * wrong frame.
     */
    private advanceStable(
        head: StableHead | undefined,
        tokens: readonly Token[],
        tokenEnds: readonly number[],
        tailLines: readonly string[],
        tailText: string,
        width: number,
    ): void {
        const last = freezePoint(tokens);
        if (last < 0) return;
        let frozenSrc = "";
        for (let i = 0; i <= last; i++) frozenSrc += tokens[i].raw;
        if (!tailText.startsWith(frozenSrc)) {
            this.stable = undefined;
            return;
        }
        this.stable = {
            width,
            src: (head?.src ?? "") + frozenSrc,
            lines: (head?.lines ?? []).concat(tailLines.slice(0, tokenEnds[last])),
        };
    }

    private createContext(): MarkdownContext {
        const context: MarkdownContext = {
            theme: this.theme,
            options: this.options,
            applyDefaultStyle: (text) => this.applyDefaultStyle(text),
            defaultInlineStyle: () => this.defaultInlineStyle(),
            renderBlock: (token, width, nextTokenType, style) =>
                renderBlock(context, token, width, nextTokenType, style),
            renderInline: (tokens, style) => renderInline(context, tokens, style),
            renderDiagram: (token, width) => this.renderDiagram(token, width),
        };
        return context;
    }

    private renderDiagram(token: Tokens.Code, width: number): string[] | undefined {
        if (this.options.renderMermaid === false) return undefined;
        const available = width - visibleWidth(this.theme.codeBlockIndent ?? "  ");
        return this.diagrams.render(token, available, this.theme.diagram);
    }

    /**
     * Apply default text style to a string.
     * This is the base styling applied to all text content.
     * NOTE: Background color is NOT applied here - it's applied at the padding stage
     * to ensure it extends to the full line width.
     */
    private applyDefaultStyle(text: string): string {
        const style = this.defaultTextStyle;
        if (!style) return text;
        let styled = text;
        if (style.color) styled = style.color(styled);
        if (style.bold) styled = this.theme.bold(styled);
        if (style.italic) styled = this.theme.italic(styled);
        if (style.strikethrough) styled = this.theme.strikethrough(styled);
        if (style.underline) styled = this.theme.underline(styled);
        return styled;
    }

    private defaultInlineStyle(): InlineStyleContext {
        this.defaultStylePrefix ??= stylePrefixOf((text) => this.applyDefaultStyle(text));
        return { applyText: (text) => this.applyDefaultStyle(text), stylePrefix: this.defaultStylePrefix };
    }
}
