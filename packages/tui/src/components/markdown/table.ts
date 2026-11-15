import type { Tokens } from "marked";
import { visibleWidth, wrapTextWithAnsi } from "../../utils";
import { type MarkdownContext, spacingAfter } from "./context";
import { fitColumnWidths, longestWordWidth, MAX_UNBROKEN_WORD_WIDTH } from "./table-columns";
import type { InlineStyleContext } from "./types";

/** Resets every text style but background, so a wrapped cell's style doesn't bleed into the border. */
const RESET_TEXT_STYLES = "\x1b[22;23;24;25;27;28;29;39m";

/**
 * Render a table with width-aware cell wrapping. Cells that don't fit are
 * wrapped to multiple lines; a table too narrow to draw falls back to its
 * raw markdown.
 */
export function renderTable(
    ctx: MarkdownContext,
    token: Tokens.Table,
    availableWidth: number,
    nextTokenType?: string,
    style?: InlineStyleContext,
): string[] {
    const numCols = token.header.length;
    if (numCols === 0) return [];
    // Border overhead: "│ " + (n-1) * " │ " + " │" = 3n + 1
    const borderOverhead = 3 * numCols + 1;
    if (availableWidth - borderOverhead < numCols) {
        const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
        return [...fallbackLines, ...spacingAfter(nextTokenType)];
    }

    const cellText = (cell: Tokens.TableCell) => ctx.renderInline(cell.tokens || [], style);
    const header = token.header.map(cellText);
    const rows = token.rows.map((row) => row.map(cellText));
    const widths = columnWidths(header, rows, availableWidth, borderOverhead);
    const rule = (left: string, mid: string, right: string) =>
        `${left}─${widths.map((w) => "─".repeat(w)).join(`─${mid}─`)}─${right}`;
    const separator = rule("├", "┼", "┤");

    const lines = [rule("┌", "┬", "┐")];
    lines.push(...tableRow(header, widths, style, (text) => ctx.theme.bold(text)));
    lines.push(separator);
    rows.forEach((row, rowIndex) => {
        lines.push(...tableRow(row, widths, style, (text) => text));
        if (rowIndex < rows.length - 1) lines.push(separator);
    });
    lines.push(rule("└", "┴", "┘"));
    return [...lines, ...spacingAfter(nextTokenType)];
}

/** Natural and minimum widths from every cell, then fitted to the space. */
function columnWidths(header: string[], rows: string[][], availableWidth: number, borderOverhead: number): number[] {
    const naturalWidths: number[] = [];
    const minWordWidths: number[] = [];
    header.forEach((text, i) => {
        naturalWidths[i] = visibleWidth(text);
        minWordWidths[i] = Math.max(1, longestWordWidth(text, MAX_UNBROKEN_WORD_WIDTH));
    });
    for (const row of rows) {
        row.forEach((text, i) => {
            naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(text));
            minWordWidths[i] = Math.max(minWordWidths[i] || 1, longestWordWidth(text, MAX_UNBROKEN_WORD_WIDTH));
        });
    }
    return fitColumnWidths(naturalWidths, minWordWidths, availableWidth, borderOverhead);
}

/** One table row, as many terminal lines as its tallest wrapped cell. */
function tableRow(
    cells: string[],
    widths: number[],
    style: InlineStyleContext | undefined,
    cellStyle: (text: string) => string,
): string[] {
    const cellLines = cells.map((text, i) => wrapCell(text, widths[i], style?.stylePrefix));
    const lineCount = Math.max(...cellLines.map((c) => c.length));
    const lines: string[] = [];
    for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
        const parts = cellLines.map((lines, colIdx) => {
            const text = lines[lineIdx] || "";
            return cellStyle(text + " ".repeat(Math.max(0, widths[colIdx] - visibleWidth(text))));
        });
        lines.push(`│ ${parts.join(" │ ")} │`);
    }
    return lines;
}

/**
 * Wrap a table cell to fit into a column. Delegates to wrapTextWithAnsi() so
 * ANSI codes + long tokens are handled consistently with the rest of the
 * renderer. Text styles are reset after each non-final fragment, then the
 * surrounding style is restored before padding and borders.
 */
function wrapCell(text: string, maxWidth: number, stylePrefix = ""): string[] {
    const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
    return lines.map((line, index) => `${line}${index < lines.length - 1 ? RESET_TEXT_STYLES : ""}${stylePrefix}`);
}
