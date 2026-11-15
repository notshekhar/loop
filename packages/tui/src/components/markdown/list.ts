import type { Tokens } from "marked";
import { visibleWidth, wrapTextWithAnsi } from "../../utils";
import type { MarkdownContext } from "./context";
import type { InlineStyleContext } from "./types";

function sourceOrderedMarker(item: Tokens.ListItem): string | undefined {
    const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
    return match ? `${match[1]} ` : undefined;
}

function sourceUnorderedMarker(item: Tokens.ListItem): string | undefined {
    const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
    return match ? `${match[1]} ` : undefined;
}

/** "3. " or "- ", plus "[x] " for a task item. Source markers are kept when the options say so. */
function itemMarker(ctx: MarkdownContext, list: Tokens.List, item: Tokens.ListItem, number: number): string {
    const preserve = ctx.options.preserveOrderedListMarkers;
    const bullet = list.ordered
        ? ((preserve ? sourceOrderedMarker(item) : undefined) ?? `${number}. `)
        : ((preserve ? sourceUnorderedMarker(item) : undefined) ?? "- ");
    return bullet + (item.task ? `[${item.checked ? "x" : " "}] ` : "");
}

/** Render a list with proper nesting support. */
export function renderList(
    ctx: MarkdownContext,
    list: Tokens.List,
    depth: number,
    width: number,
    style?: InlineStyleContext,
): string[] {
    const lines: string[] = [];
    // Use the list's start property (defaults to 1 for ordered lists)
    const startNumber = typeof list.start === "number" ? list.start : 1;
    list.items.forEach((item, i) => {
        lines.push(...renderItem(ctx, item, itemMarker(ctx, list, item, startNumber + i), depth, width, style));
        if (list.loose && i < list.items.length - 1) lines.push("");
    });
    return lines;
}

/** One item: its blocks wrapped under a hanging marker, nested lists indented a level deeper. */
function renderItem(
    ctx: MarkdownContext,
    item: Tokens.ListItem,
    marker: string,
    depth: number,
    width: number,
    style?: InlineStyleContext,
): string[] {
    const indent = "    ".repeat(depth);
    const firstPrefix = indent + ctx.theme.listBullet(marker);
    const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
    const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
    const lines: string[] = [];
    let renderedAnyLine = false;
    for (const itemToken of item.tokens) {
        if (itemToken.type === "list") {
            lines.push(...renderList(ctx, itemToken as Tokens.List, depth + 1, width, style));
            renderedAnyLine = true;
            continue;
        }
        for (const line of ctx.renderBlock(itemToken, itemWidth, undefined, style)) {
            for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
                lines.push((renderedAnyLine ? continuationPrefix : firstPrefix) + wrappedLine);
                renderedAnyLine = true;
            }
        }
    }
    if (!renderedAnyLine) lines.push(firstPrefix);
    return lines;
}
