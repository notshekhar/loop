import type { Token, Tokens } from "marked";
import { renderLatex } from "../../latex";
import { getCapabilities, hyperlink } from "../../terminal-image";
import type { MarkdownContext } from "./context";
import type { LatexToken } from "./latex-tokens";
import type { InlineStyleContext } from "./types";

/**
 * Render inline tokens (text, emphasis, code, links, math) to one styled
 * string. After each nested style the surrounding style's prefix is
 * re-applied, since the nested style ends with a reset.
 */
export function renderInline(ctx: MarkdownContext, tokens: Token[], styleContext?: InlineStyleContext): string {
    const style = styleContext ?? ctx.defaultInlineStyle();
    let result = "";
    for (const token of tokens) result += renderInlineToken(ctx, token, style);
    while (style.stylePrefix && result.endsWith(style.stylePrefix)) {
        result = result.slice(0, -style.stylePrefix.length);
    }
    return result;
}

function renderInlineToken(ctx: MarkdownContext, token: Token, style: InlineStyleContext): string {
    const { theme, options } = ctx;
    const plain = (text: string) => applyPerLine(text, style.applyText);
    const nested = (wrap: (text: string) => string) =>
        wrap(renderInline(ctx, (token as { tokens?: Token[] }).tokens || [], style)) + style.stylePrefix;
    switch (token.type) {
        case "latex":
            return plain(renderInlineLatex(token as LatexToken, options.renderLatex !== false));
        case "escape":
            return plain(options.preserveBackslashEscapes ? token.raw : token.text);
        case "text":
            // Text tokens in list items can have nested tokens for inline formatting
            return token.tokens && token.tokens.length > 0 ? renderInline(ctx, token.tokens, style) : plain(token.text);
        case "paragraph":
            return renderInline(ctx, token.tokens || [], style);
        case "strong":
            return nested((text) => theme.bold(text));
        case "em":
            return nested((text) => theme.italic(text));
        case "del":
            return nested((text) => theme.strikethrough(text));
        case "codespan":
            return theme.code(token.text) + style.stylePrefix;
        case "link":
            return renderLink(ctx, token as Tokens.Link, style);
        case "br":
            return "\n";
        case "html":
            // Render inline HTML as plain text
            return "raw" in token && typeof token.raw === "string" ? plain(token.raw) : "";
        default:
            // Handle any other inline token types as plain text
            return "text" in token && typeof token.text === "string" ? plain(token.text) : "";
    }
}

function applyPerLine(text: string, apply: (text: string) => string): string {
    return text
        .split("\n")
        .map((segment) => apply(segment))
        .join("\n");
}

function renderInlineLatex(token: LatexToken, enabled: boolean): string {
    return !token.pending && enabled ? (renderLatex(token.text) ?? token.raw) : token.raw;
}

function renderLink(ctx: MarkdownContext, token: Tokens.Link, style: InlineStyleContext): string {
    const { theme } = ctx;
    const linkText = renderInline(ctx, token.tokens || [], style);
    const styledLink = theme.link(theme.underline(linkText));
    // Internal anchor links (e.g. [x](#heading)) have no clickable target in the
    // terminal: the emulator would try to "open" the fragment as a URL, and our TUI
    // has no app-owned viewport to scroll. Render them as styled text only.
    if (token.href.startsWith("#")) return styledLink + style.stylePrefix;
    // OSC 8: render as a clickable hyperlink. The URL is not printed inline,
    // so we always show only the link text regardless of whether it matches href.
    if (getCapabilities().hyperlinks) return hyperlink(styledLink, token.href) + style.stylePrefix;
    // Fallback: print URL in parentheses when text differs from href. For mailto:
    // links strip the prefix (autolinked emails use text="foo@bar.com" but
    // href="mailto:foo@bar.com").
    const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
    if (token.text === token.href || token.text === hrefForComparison) return styledLink + style.stylePrefix;
    return styledLink + theme.linkUrl(` (${token.href})`) + style.stylePrefix;
}
