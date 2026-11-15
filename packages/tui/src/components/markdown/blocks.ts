import type { Token, Tokens } from "marked";
import { renderLatex } from "../../latex";
import { wrapTextWithAnsi } from "../../utils";
import { type MarkdownContext, spacingAfter, stylePrefixOf } from "./context";
import type { LatexToken } from "./latex-tokens";
import { renderList } from "./list";
import { renderTable } from "./table";
import type { InlineStyleContext } from "./types";

/** Width of the "│ " border in front of quoted text. */
const QUOTE_BORDER_WIDTH = 2;

/** Render one block-level token to lines (not yet wrapped to the width). */
export function renderBlock(
    ctx: MarkdownContext,
    token: Token,
    width: number,
    nextTokenType?: string,
    style?: InlineStyleContext,
): string[] {
    switch (token.type) {
        case "heading":
            return [renderHeading(ctx, token as Tokens.Heading), ...spacingAfter(nextTokenType)];
        case "paragraph": {
            // A list right after a paragraph hugs it; anything else gets a blank line.
            const spacing = nextTokenType === "list" ? [] : spacingAfter(nextTokenType);
            return [ctx.renderInline(token.tokens || [], style), ...spacing];
        }
        case "text":
            return [ctx.renderInline([token], style)];
        case "latexBlock":
            return [...renderLatexBlock(ctx, token as LatexToken), ...spacingAfter(nextTokenType)];
        case "code":
            return [...renderCode(ctx, token as Tokens.Code, width), ...spacingAfter(nextTokenType)];
        case "list":
            // A space token after a list handles the spacing.
            return renderList(ctx, token as Tokens.List, 0, width, style);
        case "table":
            return renderTable(ctx, token as Tokens.Table, width, nextTokenType, style);
        case "blockquote":
            return [...renderBlockquote(ctx, token as Tokens.Blockquote, width), ...spacingAfter(nextTokenType)];
        case "hr":
            return [ctx.theme.hr("─".repeat(Math.min(width, 80))), ...spacingAfter(nextTokenType)];
        case "html":
            // Render HTML as plain text (escaped for terminal)
            return "raw" in token && typeof token.raw === "string" ? [ctx.applyDefaultStyle(token.raw.trim())] : [];
        case "space":
            // Space tokens represent blank lines in markdown
            return [""];
        default:
            // Handle any other token types as plain text
            return "text" in token && typeof token.text === "string" ? [token.text] : [];
    }
}

/**
 * Headings carry their own style context so inline tokens (codespan, bold,
 * etc.) restore heading styling after their own resets instead of falling
 * back to the default text style. Level 3+ keeps its "### " marker.
 */
function renderHeading(ctx: MarkdownContext, token: Tokens.Heading): string {
    const { theme } = ctx;
    const headingStyle =
        token.depth === 1
            ? (text: string) => theme.heading(theme.bold(theme.underline(text)))
            : (text: string) => theme.heading(theme.bold(text));
    const text = ctx.renderInline(token.tokens || [], {
        applyText: headingStyle,
        stylePrefix: stylePrefixOf(headingStyle),
    });
    return token.depth >= 3 ? headingStyle(`${"#".repeat(token.depth)} `) + text : text;
}

function renderLatexBlock(ctx: MarkdownContext, token: LatexToken): string[] {
    const rendered =
        !token.pending && ctx.options.renderLatex !== false
            ? (renderLatex(token.text, { display: true }) ?? token.raw.trim())
            : token.raw.trim();
    return rendered.split("\n").map((line) => ctx.applyDefaultStyle(line));
}

/** A fenced block between ``` rules, highlighted when the theme can — or drawn, if it is a diagram. */
function renderCode(ctx: MarkdownContext, token: Tokens.Code, width: number): string[] {
    const { theme } = ctx;
    const indent = theme.codeBlockIndent ?? "  ";
    const diagram = ctx.renderDiagram(token, width);
    if (diagram) return diagram.map((line) => `${indent}${line}`);
    const body = theme.highlightCode
        ? theme.highlightCode(token.text, token.lang).map((line) => `${indent}${line}`)
        : token.text.split("\n").map((line) => `${indent}${theme.codeBlock(line)}`);
    return [theme.codeBlockBorder(`\`\`\`${token.lang || ""}`), ...body, theme.codeBlockBorder("```")];
}

/**
 * A quote: its blocks rendered in quote style (the default message style
 * does not apply inside), wrapped, behind a "│ " border.
 */
function renderBlockquote(ctx: MarkdownContext, token: Tokens.Blockquote, width: number): string[] {
    const { theme } = ctx;
    const quoteStyle = (text: string) => theme.quote(theme.italic(text));
    const quoteStylePrefix = stylePrefixOf(quoteStyle);
    const contentWidth = Math.max(1, width - QUOTE_BORDER_WIDTH);
    const innerStyle: InlineStyleContext = { applyText: (text) => text, stylePrefix: quoteStylePrefix };

    const children = token.tokens || [];
    const rendered = children.flatMap((child, i) =>
        ctx.renderBlock(child, contentWidth, children[i + 1]?.type, innerStyle),
    );
    // Avoid rendering an extra empty quote line before the outer blockquote spacing.
    while (rendered.length > 0 && rendered[rendered.length - 1] === "") rendered.pop();

    // A nested reset would end the quote style mid-line, so re-open it after each one.
    const styleLine = (line: string) =>
        quoteStyle(quoteStylePrefix ? line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`) : line);
    return rendered.flatMap((line) =>
        wrapTextWithAnsi(styleLine(line), contentWidth).map((wrapped) => theme.quoteBorder("│ ") + wrapped),
    );
}
