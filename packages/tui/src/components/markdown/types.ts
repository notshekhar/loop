import type { MermaidStyle } from "../../mermaid";

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

/** How inline text is styled, and the escape prefix that restores that style after a nested reset. */
export interface InlineStyleContext {
    applyText: (text: string) => string;
    stylePrefix: string;
}
