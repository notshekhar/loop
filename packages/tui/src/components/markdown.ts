import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";
import { renderLatex } from "../latex";
import { type MermaidStyle, renderMermaid } from "../mermaid";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image";
import type { Component } from "../tui";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
    override del(src: string): Tokens.Del | undefined {
        const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
        if (!match) {
            return undefined;
        }

        const text = match[2];
        return {
            type: "del",
            raw: match[0],
            text,
            tokens: this.lexer.inlineTokens(text),
        };
    }
}

interface LatexToken extends Tokens.Generic {
    type: "latex" | "latexBlock";
    text: string;
    pending?: boolean;
}

function isEscaped(source: string, index: number): boolean {
    let backslashes = 0;
    for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
    let index = source.indexOf(closing, start);
    while (index >= 0 && isEscaped(source, index)) {
        index = source.indexOf(closing, index + closing.length);
    }
    return index;
}

function looksLikePendingDollarMath(source: string): boolean {
    return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
    let opening = "";
    let closing = "";
    if (source.startsWith("$$")) {
        opening = "$$";
        closing = "$$";
    } else if (source.startsWith("\\(")) {
        opening = "\\(";
        closing = "\\)";
    } else if (source.startsWith("\\[")) {
        opening = "\\[";
        closing = "\\]";
    } else if (source.startsWith("$") && !/^\$\s/.test(source)) {
        opening = "$";
        closing = "$";
    } else {
        return undefined;
    }

    const closingIndex = findClosingDelimiter(source, closing, opening.length);
    if (
        closingIndex >= 0 &&
        opening === "$" &&
        (/\s$/.test(source.slice(opening.length, closingIndex)) ||
            /^\d/.test(source.slice(closingIndex + 1)) ||
            (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
                /^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
            source.slice(opening.length, closingIndex).includes("`"))
    ) {
        return undefined;
    }

    if (closingIndex < 0) {
        const pendingSource = source.slice(opening.length);
        if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
            return { type: "latex", raw: source, text: pendingSource, pending: true };
        }
        return undefined;
    }

    const text = source.slice(opening.length, closingIndex);
    if (!text || text.includes("\n")) {
        return undefined;
    }

    const raw = source.slice(0, closingIndex + closing.length);
    return { type: "latex", raw, text };
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
    const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
    if (dollarMatch?.[1]) {
        return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
    }

    const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
    if (bracketMatch?.[1]) {
        return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
    }

    const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
    if (pendingBracket) {
        return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
    }
    const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
    if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
        return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
    }
    return undefined;
}

const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
    {
        name: "latexBlock",
        level: "block",
        start(source) {
            const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
            return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
        },
        tokenizer: tokenizeBlockLatex,
    },
    {
        name: "latex",
        level: "inline",
        start(source) {
            const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
                (index) => index >= 0,
            );
            return indices.length > 0 ? Math.min(...indices) : undefined;
        },
        tokenizer: tokenizeInlineLatex,
    },
];

function trimPartialClosingFences(tokens: readonly Token[]): void {
    const token = tokens[tokens.length - 1];
    if (token?.type === "list") {
        trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
        return;
    }
    if (token?.type === "blockquote") {
        trimPartialClosingFences(token.tokens ?? []);
        return;
    }
    if (token?.type !== "code") {
        return;
    }

    // Trim streamed partial closing fences so code blocks do not shrink/flicker
    // when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
    const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
    const lastLine = token.raw.split("\n").pop();
    if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
        return;
    }

    token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

const markdownParser = new Marked();
markdownParser.setOptions({
    tokenizer: new StrictStrikethroughTokenizer(),
});
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });

/**
 * Block types that a following blank line SEALS: once one of these is closed
 * by a blank line, no amount of text arriving after it can change how it
 * lexed. That is what makes it safe to freeze the render of everything up to
 * that point while the rest of the document is still streaming in.
 *
 * `list` is missing on purpose. A blank line does not end a list —
 * "- a\n\n- b" lexes as ONE loose list, not two — so freezing across a
 * trailing list would re-lex "- b" as a fresh list and renumber an ordered
 * one from 1. Indented (unfenced) code has the same property, and `html` and
 * `def` are left out for the same class of reason.
 */
const SEALED_BLOCK_TYPES = new Set(["paragraph", "heading", "hr", "blockquote", "table"]);

/** A fenced code block whose closing fence has already arrived — sealed, unlike
 * an indented code block, which a later indented line extends. */
function isClosedFencedCode(token: Token): boolean {
    if (token.type !== "code") return false;
    const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
    if (!marker) return false; // indented code block
    const lastLine = token.raw.trimEnd().split("\n").pop() ?? "";
    return token.raw.trimEnd().length > marker.length && lastLine.startsWith(marker[0].repeat(marker.length));
}

/**
 * The last token that may be frozen, or -1 for none.
 *
 * Only blank-line boundaries qualify (a `space` token), and only when the
 * block in front of the blank line is sealed. The final two tokens are never
 * frozen: the last one is still growing, and a token's rendering is handed the
 * NEXT token's type, so the second-to-last one's output is not settled either.
 */
function freezePoint(tokens: readonly Token[]): number {
    for (let i = tokens.length - 3; i >= 1; i--) {
        if (tokens[i].type !== "space") continue;
        const prev = tokens[i - 1];
        if (SEALED_BLOCK_TYPES.has(prev.type) || isClosedFencedCode(prev)) return i;
    }
    return -1;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
    /** Foreground color function */
    color?: (text: string) => string;
    /** Background color function */
    bgColor?: (text: string) => string;
    /** Bold text */
    bold?: boolean;
    /** Italic text */
    italic?: boolean;
    /** Strikethrough text */
    strikethrough?: boolean;
    /** Underline text */
    underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
    heading: (text: string) => string;
    link: (text: string) => string;
    linkUrl: (text: string) => string;
    code: (text: string) => string;
    codeBlock: (text: string) => string;
    codeBlockBorder: (text: string) => string;
    quote: (text: string) => string;
    quoteBorder: (text: string) => string;
    hr: (text: string) => string;
    listBullet: (text: string) => string;
    bold: (text: string) => string;
    italic: (text: string) => string;
    strikethrough: (text: string) => string;
    underline: (text: string) => string;
    highlightCode?: (code: string, lang?: string) => string[];
    /** Prefix applied to each rendered code block line (default: "  ") */
    codeBlockIndent?: string;
    /** Colours for rendered diagrams; anything omitted is left unstyled. */
    diagram?: Partial<MermaidStyle>;
}

export interface MarkdownOptions {
    /** Preserve source list markers instead of normalizing them. */
    preserveOrderedListMarkers?: boolean;
    /** Preserve source backslash escapes instead of normalizing escaped punctuation. */
    preserveBackslashEscapes?: boolean;
    /** Transform source Markdown before parsing, with the exact width available for content. */
    transform?: (markdown: string, availableWidth: number) => string;
    /** Render supported LaTeX math expressions as Unicode text (default: true). */
    renderLatex?: boolean;
    /** Draw ```mermaid blocks as diagrams (default: true). */
    renderMermaid?: boolean;
}

interface InlineStyleContext {
    applyText: (text: string) => string;
    stylePrefix: string;
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
    private stable?: { width: number; src: string; lines: string[] };
    /** Laid-out diagrams, keyed by width and source — see renderDiagram. */
    private diagrams = new Map<string, { lines: string[] | undefined }>();

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
    }

    setText(text: string): void {
        this.text = text;
        this.cachedText = undefined;
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
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
        this.cachedText = undefined;
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
        this.stable = undefined;
        this.diagrams.clear();
    }

    render(width: number): string[] {
        // Check cache
        if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
            return this.cachedLines;
        }

        // Calculate available width for content (subtract horizontal padding)
        const contentWidth = Math.max(1, width - this.paddingX * 2);
        const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

        // Don't render anything if there's no actual text
        if (!text || text.trim() === "") {
            const result: string[] = [];
            // Update cache
            this.cachedText = this.text;
            this.cachedWidth = width;
            this.cachedLines = result;
            return result;
        }

        // Replace tabs with 3 spaces for consistent rendering
        const normalizedText = text.replace(/\t/g, "   ");

        // Streaming: everything up to the settled head was rendered on an
        // earlier delta and cannot have changed, so only the tail is lexed.
        const head =
            this.stable && this.stable.width === width && normalizedText.startsWith(this.stable.src)
                ? this.stable
                : undefined;
        const tailText = head ? normalizedText.slice(head.src.length) : normalizedText;

        // Parse markdown to HTML-like tokens
        const tokens = markdownParser.lexer(tailText);
        trimPartialClosingFences(tokens);

        const leftMargin = " ".repeat(this.paddingX);
        const rightMargin = " ".repeat(this.paddingX);
        const bgFn = this.defaultTextStyle?.bgColor;
        // Convert tokens to styled terminal output, wrapping and adding
        // margins as we go so each token's span of finished lines is known —
        // that span is what the streaming head is cut from.
        const tailLines: string[] = [];
        const tokenEnds: number[] = [];

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const nextToken = tokens[i + 1];
            const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
            for (const tokenLine of tokenLines) {
                if (isImageLine(tokenLine)) {
                    tailLines.push(tokenLine);
                    continue;
                }
                for (const wrappedLine of wrapTextWithAnsi(tokenLine, contentWidth)) {
                    const lineWithMargins = leftMargin + wrappedLine + rightMargin;
                    if (bgFn) {
                        tailLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
                    } else {
                        // No background - just pad to width
                        const visibleLen = visibleWidth(lineWithMargins);
                        const paddingNeeded = Math.max(0, width - visibleLen);
                        tailLines.push(lineWithMargins + " ".repeat(paddingNeeded));
                    }
                }
            }
            tokenEnds.push(tailLines.length);
        }

        if (this.streaming) this.advanceStable(head, tokens, tokenEnds, tailLines, tailText, width);

        const contentLines = head ? head.lines.concat(tailLines) : tailLines;

        // Add top/bottom padding (empty lines)
        const emptyLine = " ".repeat(width);
        const emptyLines: string[] = [];
        for (let i = 0; i < this.paddingY; i++) {
            const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
            emptyLines.push(line);
        }

        // Combine top padding, content, and bottom padding
        const result = emptyLines.concat(contentLines, emptyLines);

        // Update cache
        this.cachedText = this.text;
        this.cachedWidth = width;
        this.cachedLines = result;

        return result.length > 0 ? result : [""];
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
        head: { width: number; src: string; lines: string[] } | undefined,
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

    /**
     * Apply default text style to a string.
     * This is the base styling applied to all text content.
     * NOTE: Background color is NOT applied here - it's applied at the padding stage
     * to ensure it extends to the full line width.
     */
    /**
     * A ```mermaid block, drawn — including while it is still arriving, so a
     * diagram grows in like every other block instead of sitting as source and
     * popping at the end.
     *
     * Only whole lines are laid out. A half-written `A[Requ` parses as a bare
     * node, so the box would flicker through its own label a character at a
     * time; waiting for the newline costs one line of latency and removes that
     * entirely. Layout is memoised on the source, so the deltas that arrive
     * mid-line cost nothing.
     */
    private renderDiagram(token: Tokens.Code, width: number): string[] | undefined {
        if (this.options.renderMermaid === false) return undefined;
        if ((token.lang ?? "").trim().split(/\s+/)[0] !== "mermaid") return undefined;

        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1];
        const closed = !fence || new RegExp(`\n {0,3}${fence[0]}{${fence.length},}[ \t]*\n?$`).test(token.raw);
        let source = token.text;
        if (!closed) {
            const settled = source.lastIndexOf("\n");
            if (settled <= 0) return undefined;
            source = source.slice(0, settled);
        }

        const available = width - visibleWidth(this.theme.codeBlockIndent ?? "  ");
        const key = `${available}\u0000${source}`;
        const memo = this.diagrams.get(key);
        if (memo !== undefined) return memo.lines;
        const lines = renderMermaid(source, { width: available, style: this.theme.diagram });
        // A growing block would otherwise keep every frame it passed through.
        if (this.diagrams.size >= 8) this.diagrams.clear();
        this.diagrams.set(key, { lines });
        return lines;
    }

    private applyDefaultStyle(text: string): string {
        if (!this.defaultTextStyle) {
            return text;
        }

        let styled = text;

        // Apply foreground color (NOT background - that's applied at padding stage)
        if (this.defaultTextStyle.color) {
            styled = this.defaultTextStyle.color(styled);
        }

        // Apply text decorations using this.theme
        if (this.defaultTextStyle.bold) {
            styled = this.theme.bold(styled);
        }
        if (this.defaultTextStyle.italic) {
            styled = this.theme.italic(styled);
        }
        if (this.defaultTextStyle.strikethrough) {
            styled = this.theme.strikethrough(styled);
        }
        if (this.defaultTextStyle.underline) {
            styled = this.theme.underline(styled);
        }

        return styled;
    }

    private getDefaultStylePrefix(): string {
        if (!this.defaultTextStyle) {
            return "";
        }

        if (this.defaultStylePrefix !== undefined) {
            return this.defaultStylePrefix;
        }

        const sentinel = "\u0000";
        let styled = sentinel;

        if (this.defaultTextStyle.color) {
            styled = this.defaultTextStyle.color(styled);
        }

        if (this.defaultTextStyle.bold) {
            styled = this.theme.bold(styled);
        }
        if (this.defaultTextStyle.italic) {
            styled = this.theme.italic(styled);
        }
        if (this.defaultTextStyle.strikethrough) {
            styled = this.theme.strikethrough(styled);
        }
        if (this.defaultTextStyle.underline) {
            styled = this.theme.underline(styled);
        }

        const sentinelIndex = styled.indexOf(sentinel);
        this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
        return this.defaultStylePrefix;
    }

    private getStylePrefix(styleFn: (text: string) => string): string {
        const sentinel = "\u0000";
        const styled = styleFn(sentinel);
        const sentinelIndex = styled.indexOf(sentinel);
        return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
    }

    private getDefaultInlineStyleContext(): InlineStyleContext {
        return {
            applyText: (text: string) => this.applyDefaultStyle(text),
            stylePrefix: this.getDefaultStylePrefix(),
        };
    }

    private renderToken(
        token: Token,
        width: number,
        nextTokenType?: string,
        styleContext?: InlineStyleContext,
    ): string[] {
        const lines: string[] = [];

        switch (token.type) {
            case "heading": {
                const headingLevel = token.depth;
                const headingPrefix = `${"#".repeat(headingLevel)} `;

                // Build a heading-specific style context so inline tokens (codespan, bold, etc.)
                // restore heading styling after their own ANSI resets instead of falling back to
                // the default text style.
                let headingStyleFn: (text: string) => string;
                if (headingLevel === 1) {
                    headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
                } else {
                    headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
                }

                const headingStyleContext: InlineStyleContext = {
                    applyText: headingStyleFn,
                    stylePrefix: this.getStylePrefix(headingStyleFn),
                };

                const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
                const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
                lines.push(styledHeading);
                if (nextTokenType && nextTokenType !== "space") {
                    lines.push(""); // Add spacing after headings (unless space token follows)
                }
                break;
            }

            case "paragraph": {
                const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
                lines.push(paragraphText);
                // Don't add spacing if next token is space or list
                if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
                    lines.push("");
                }
                break;
            }

            case "text":
                lines.push(this.renderInlineTokens([token], styleContext));
                break;

            case "latexBlock": {
                const latexToken = token as LatexToken;
                const rendered =
                    !latexToken.pending && this.options.renderLatex !== false
                        ? (renderLatex(latexToken.text, { display: true }) ?? latexToken.raw.trim())
                        : latexToken.raw.trim();
                for (const line of rendered.split("\n")) {
                    lines.push(this.applyDefaultStyle(line));
                }
                if (nextTokenType && nextTokenType !== "space") {
                    lines.push("");
                }
                break;
            }

            case "code": {
                const indent = this.theme.codeBlockIndent ?? "  ";
                const diagram = this.renderDiagram(token as Tokens.Code, width);
                if (diagram) {
                    for (const diagramLine of diagram) lines.push(`${indent}${diagramLine}`);
                    if (nextTokenType && nextTokenType !== "space") lines.push("");
                    break;
                }
                lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
                if (this.theme.highlightCode) {
                    const highlightedLines = this.theme.highlightCode(token.text, token.lang);
                    for (const hlLine of highlightedLines) {
                        lines.push(`${indent}${hlLine}`);
                    }
                } else {
                    // Split code by newlines and style each line
                    const codeLines = token.text.split("\n");
                    for (const codeLine of codeLines) {
                        lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
                    }
                }
                lines.push(this.theme.codeBlockBorder("```"));
                if (nextTokenType && nextTokenType !== "space") {
                    lines.push(""); // Add spacing after code blocks (unless space token follows)
                }
                break;
            }

            case "list": {
                const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
                lines.push(...listLines);
                // Don't add spacing after lists if a space token follows
                // (the space token will handle it)
                break;
            }

            case "table": {
                const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
                lines.push(...tableLines);
                break;
            }

            case "blockquote": {
                const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
                const quoteStylePrefix = this.getStylePrefix(quoteStyle);
                const applyQuoteStyle = (line: string): string => {
                    if (!quoteStylePrefix) {
                        return quoteStyle(line);
                    }
                    const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
                    return quoteStyle(lineWithReappliedStyle);
                };

                // Calculate available width for quote content (subtract border "│ " = 2 chars)
                const quoteContentWidth = Math.max(1, width - 2);

                // Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
                // children with renderToken() instead of renderInlineTokens().
                // Default message style should not apply inside blockquotes.
                const quoteInlineStyleContext: InlineStyleContext = {
                    applyText: (text: string) => text,
                    stylePrefix: quoteStylePrefix,
                };
                const quoteTokens = token.tokens || [];
                const renderedQuoteLines: string[] = [];
                for (let i = 0; i < quoteTokens.length; i++) {
                    const quoteToken = quoteTokens[i];
                    const nextQuoteToken = quoteTokens[i + 1];
                    renderedQuoteLines.push(
                        ...this.renderToken(
                            quoteToken,
                            quoteContentWidth,
                            nextQuoteToken?.type,
                            quoteInlineStyleContext,
                        ),
                    );
                }

                // Avoid rendering an extra empty quote line before the outer blockquote spacing.
                while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
                    renderedQuoteLines.pop();
                }

                for (const quoteLine of renderedQuoteLines) {
                    const styledLine = applyQuoteStyle(quoteLine);
                    const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
                    for (const wrappedLine of wrappedLines) {
                        lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
                    }
                }
                if (nextTokenType && nextTokenType !== "space") {
                    lines.push(""); // Add spacing after blockquotes (unless space token follows)
                }
                break;
            }

            case "hr":
                lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
                if (nextTokenType && nextTokenType !== "space") {
                    lines.push(""); // Add spacing after horizontal rules (unless space token follows)
                }
                break;

            case "html":
                // Render HTML as plain text (escaped for terminal)
                if ("raw" in token && typeof token.raw === "string") {
                    lines.push(this.applyDefaultStyle(token.raw.trim()));
                }
                break;

            case "space":
                // Space tokens represent blank lines in markdown
                lines.push("");
                break;

            default:
                // Handle any other token types as plain text
                if ("text" in token && typeof token.text === "string") {
                    lines.push(token.text);
                }
        }

        return lines;
    }

    private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
        let result = "";
        const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
        const { applyText, stylePrefix } = resolvedStyleContext;
        const applyTextWithNewlines = (text: string): string => {
            const segments: string[] = text.split("\n");
            return segments.map((segment: string) => applyText(segment)).join("\n");
        };

        for (const token of tokens) {
            switch (token.type) {
                case "latex": {
                    const latexToken = token as LatexToken;
                    const rendered =
                        !latexToken.pending && this.options.renderLatex !== false
                            ? (renderLatex(latexToken.text) ?? latexToken.raw)
                            : latexToken.raw;
                    result += applyTextWithNewlines(rendered);
                    break;
                }

                case "escape":
                    result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
                    break;

                case "text":
                    // Text tokens in list items can have nested tokens for inline formatting
                    if (token.tokens && token.tokens.length > 0) {
                        result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
                    } else {
                        result += applyTextWithNewlines(token.text);
                    }
                    break;

                case "paragraph":
                    // Paragraph tokens contain nested inline tokens
                    result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                    break;

                case "strong": {
                    const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                    result += this.theme.bold(boldContent) + stylePrefix;
                    break;
                }

                case "em": {
                    const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                    result += this.theme.italic(italicContent) + stylePrefix;
                    break;
                }

                case "codespan":
                    result += this.theme.code(token.text) + stylePrefix;
                    break;

                case "link": {
                    const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                    const styledLink = this.theme.link(this.theme.underline(linkText));
                    // Internal anchor links (e.g. [x](#heading)) have no clickable target in the
                    // terminal: the emulator would try to "open" the fragment as a URL, and our TUI
                    // has no app-owned viewport to scroll. Render them as styled text only.
                    if (token.href.startsWith("#")) {
                        result += styledLink + stylePrefix;
                    } else if (getCapabilities().hyperlinks) {
                        // OSC 8: render as a clickable hyperlink. The URL is not printed inline,
                        // so we always show only the link text regardless of whether it matches href.
                        result += hyperlink(styledLink, token.href) + stylePrefix;
                    } else {
                        // Fallback: print URL in parentheses when text differs from href.
                        // Compare raw token.text (not styled) against href for the equality check.
                        // For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
                        // but href="mailto:foo@bar.com").
                        const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
                        if (token.text === token.href || token.text === hrefForComparison) {
                            result += styledLink + stylePrefix;
                        } else {
                            result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
                        }
                    }
                    break;
                }

                case "br":
                    result += "\n";
                    break;

                case "del": {
                    const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
                    result += this.theme.strikethrough(delContent) + stylePrefix;
                    break;
                }

                case "html":
                    // Render inline HTML as plain text
                    if ("raw" in token && typeof token.raw === "string") {
                        result += applyTextWithNewlines(token.raw);
                    }
                    break;

                default:
                    // Handle any other inline token types as plain text
                    if ("text" in token && typeof token.text === "string") {
                        result += applyTextWithNewlines(token.text);
                    }
            }
        }

        while (stylePrefix && result.endsWith(stylePrefix)) {
            result = result.slice(0, -stylePrefix.length);
        }

        return result;
    }

    private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
        const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
        return match ? `${match[1]} ` : undefined;
    }

    private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
        const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
        return match ? `${match[1]} ` : undefined;
    }

    /**
     * Render a list with proper nesting support
     */
    private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
        const lines: string[] = [];
        const indent = "    ".repeat(depth);
        // Use the list's start property (defaults to 1 for ordered lists)
        const startNumber = typeof token.start === "number" ? token.start : 1;

        for (let i = 0; i < token.items.length; i++) {
            const item = token.items[i];
            const isLastItem = i === token.items.length - 1;
            const bullet = token.ordered
                ? this.options.preserveOrderedListMarkers
                    ? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
                    : `${startNumber + i}. `
                : this.options.preserveOrderedListMarkers
                  ? (this.getUnorderedListMarker(item) ?? "- ")
                  : "- ";
            const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
            const marker = bullet + taskMarker;
            const firstPrefix = indent + this.theme.listBullet(marker);
            const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
            const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
            let renderedAnyLine = false;

            for (const itemToken of item.tokens) {
                if (itemToken.type === "list") {
                    lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
                    renderedAnyLine = true;
                    continue;
                }

                const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
                for (const line of itemLines) {
                    for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
                        const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
                        lines.push(linePrefix + wrappedLine);
                        renderedAnyLine = true;
                    }
                }
            }

            if (!renderedAnyLine) {
                lines.push(firstPrefix);
            }

            if (token.loose && !isLastItem) {
                lines.push("");
            }
        }

        return lines;
    }

    /**
     * Get the visible width of the longest word in a string.
     */
    private getLongestWordWidth(text: string, maxWidth?: number): number {
        const words = text.split(/\s+/).filter((word) => word.length > 0);
        let longest = 0;
        for (const word of words) {
            longest = Math.max(longest, visibleWidth(word));
        }
        if (maxWidth === undefined) {
            return longest;
        }
        return Math.min(longest, maxWidth);
    }

    /**
     * Wrap a table cell to fit into a column.
     *
     * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
     * consistently with the rest of the renderer.
     */
    private wrapCellText(text: string, maxWidth: number, stylePrefix = ""): string[] {
        const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
        return lines.map((line, index) => {
            // Reset text styles after each non-final fragment, then restore the surrounding style before padding and borders.
            const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
            return `${line}${styleReset}${stylePrefix}`;
        });
    }

    /**
     * Render a table with width-aware cell wrapping.
     * Cells that don't fit are wrapped to multiple lines.
     */
    private renderTable(
        token: Tokens.Table,
        availableWidth: number,
        nextTokenType?: string,
        styleContext?: InlineStyleContext,
    ): string[] {
        const lines: string[] = [];
        const numCols = token.header.length;

        if (numCols === 0) {
            return lines;
        }

        // Calculate border overhead: "│ " + (n-1) * " │ " + " │"
        // = 2 + (n-1) * 3 + 2 = 3n + 1
        const borderOverhead = 3 * numCols + 1;
        const availableForCells = availableWidth - borderOverhead;
        if (availableForCells < numCols) {
            // Too narrow to render a stable table. Fall back to raw markdown.
            const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
            if (nextTokenType && nextTokenType !== "space") {
                fallbackLines.push("");
            }
            return fallbackLines;
        }

        const maxUnbrokenWordWidth = 30;

        // Calculate natural column widths (what each column needs without constraints)
        const naturalWidths: number[] = [];
        const minWordWidths: number[] = [];
        for (let i = 0; i < numCols; i++) {
            const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
            naturalWidths[i] = visibleWidth(headerText);
            minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
        }
        for (const row of token.rows) {
            for (let i = 0; i < row.length; i++) {
                const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
                naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
                minWordWidths[i] = Math.max(
                    minWordWidths[i] || 1,
                    this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
                );
            }
        }

        let minColumnWidths = minWordWidths;
        let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

        if (minCellsWidth > availableForCells) {
            minColumnWidths = new Array(numCols).fill(1);
            const remaining = availableForCells - numCols;

            if (remaining > 0) {
                const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
                const growth = minWordWidths.map((width) => {
                    const weight = Math.max(0, width - 1);
                    return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
                });

                for (let i = 0; i < numCols; i++) {
                    minColumnWidths[i] += growth[i] ?? 0;
                }

                const allocated = growth.reduce((total, width) => total + width, 0);
                let leftover = remaining - allocated;
                for (let i = 0; leftover > 0 && i < numCols; i++) {
                    minColumnWidths[i]++;
                    leftover--;
                }
            }

            minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
        }

        // Calculate column widths that fit within available width
        const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
        let columnWidths: number[];

        if (totalNaturalWidth <= availableWidth) {
            // Everything fits naturally
            columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
        } else {
            // Need to shrink columns to fit
            const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
                return total + Math.max(0, width - minColumnWidths[index]);
            }, 0);
            const extraWidth = Math.max(0, availableForCells - minCellsWidth);
            columnWidths = minColumnWidths.map((minWidth, index) => {
                const naturalWidth = naturalWidths[index];
                const minWidthDelta = Math.max(0, naturalWidth - minWidth);
                let grow = 0;
                if (totalGrowPotential > 0) {
                    grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
                }
                return minWidth + grow;
            });

            // Adjust for rounding errors - distribute remaining space
            const allocated = columnWidths.reduce((a, b) => a + b, 0);
            let remaining = availableForCells - allocated;
            while (remaining > 0) {
                let grew = false;
                for (let i = 0; i < numCols && remaining > 0; i++) {
                    if (columnWidths[i] < naturalWidths[i]) {
                        columnWidths[i]++;
                        remaining--;
                        grew = true;
                    }
                }
                if (!grew) {
                    break;
                }
            }
        }

        // Render top border
        const topBorderCells = columnWidths.map((w) => "─".repeat(w));
        lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

        // Render header with wrapping
        const headerCellLines: string[][] = token.header.map((cell, i) => {
            const text = this.renderInlineTokens(cell.tokens || [], styleContext);
            return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
        });
        const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

        for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
            const rowParts = headerCellLines.map((cellLines, colIdx) => {
                const text = cellLines[lineIdx] || "";
                const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
                return this.theme.bold(padded);
            });
            lines.push(`│ ${rowParts.join(" │ ")} │`);
        }

        // Render separator
        const separatorCells = columnWidths.map((w) => "─".repeat(w));
        const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
        lines.push(separatorLine);

        // Render rows with wrapping
        for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
            const row = token.rows[rowIndex];
            const rowCellLines: string[][] = row.map((cell, i) => {
                const text = this.renderInlineTokens(cell.tokens || [], styleContext);
                return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
            });
            const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

            for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
                const rowParts = rowCellLines.map((cellLines, colIdx) => {
                    const text = cellLines[lineIdx] || "";
                    return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
                });
                lines.push(`│ ${rowParts.join(" │ ")} │`);
            }

            if (rowIndex < token.rows.length - 1) {
                lines.push(separatorLine);
            }
        }

        // Render bottom border
        const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
        lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

        if (nextTokenType && nextTokenType !== "space") {
            lines.push(""); // Add spacing after table
        }
        return lines;
    }
}
