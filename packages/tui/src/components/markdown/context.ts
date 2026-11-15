import type { Token, Tokens } from "marked";
import type { InlineStyleContext, MarkdownOptions, MarkdownTheme } from "./types";

/**
 * What the block, inline, list and table renderers share. Rendering is
 * recursive (a list item holds blocks, a quote holds lists), so each part
 * reaches the others through here rather than importing them in a cycle.
 */
export interface MarkdownContext {
    theme: MarkdownTheme;
    options: MarkdownOptions;
    /** The component's default text style (color and decorations; never background). */
    applyDefaultStyle(text: string): string;
    defaultInlineStyle(): InlineStyleContext;
    renderBlock(token: Token, width: number, nextTokenType?: string, style?: InlineStyleContext): string[];
    renderInline(tokens: Token[], style?: InlineStyleContext): string;
    renderDiagram(token: Tokens.Code, width: number): string[] | undefined;
}

/** The escape sequence `style` opens with, found by styling a sentinel. Empty for no style. */
export function stylePrefixOf(style: (text: string) => string): string {
    const sentinel = "\u0000";
    const styled = style(sentinel);
    const sentinelIndex = styled.indexOf(sentinel);
    return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
}

/** A blank line after a block, unless a blank (space token) already follows it. */
export function spacingAfter(nextTokenType: string | undefined): string[] {
    return nextTokenType && nextTokenType !== "space" ? [""] : [];
}
