/**
 * TodoPanel — the pinned checklist the todo tool maintains. Mounted in the
 * app's fixed bottom region (below the loader slot, above queued messages and
 * the editor) so progress stays visible while the conversation scrolls.
 * Renders zero rows when there's no list, so it costs no space until the
 * agent actually starts one.
 */
import { truncateToWidth, visibleWidth, type Component } from "@notshekhar/loop-tui";
import type { TodoItem } from "@notshekhar/loop-core";
import { accentTitle, dim, dimStruck, ok } from "../ui/text";

const MAX_BODY_ROWS = 6;

function clip(s: string, width: number): string {
    // ANSI- and grapheme-aware: the clipped row keeps its styling
    // (truncateToWidth resets before the ellipsis) and wide characters
    // (CJK, Devanagari, emoji) count by display cells, never split mid-pair.
    return visibleWidth(s) <= width ? s : truncateToWidth(s, width, "…");
}

/**
 * One mark per status, the same family fx's /status uses: ○ still to do, ◌
 * on its way (the dotted ring is the half-drawn one), ✓ done, · dropped.
 * Only the tick is coloured, so a finished step reads as finished at a
 * glance while its text recedes with the rest of the done work.
 */
function row(item: TodoItem): string {
    if (item.status === "completed") return `${ok("✓")} ${dim(item.content)}`;
    if (item.status === "cancelled") return dimStruck(`· ${item.content}`);
    if (item.status === "in_progress") return accentTitle(`◌ ${item.activeForm?.trim() || item.content}`);
    return dim(`○ ${item.content}`);
}

/** Completed and cancelled are both terminal — no work left on the item. */
function isTerminal(item: TodoItem): boolean {
    return item.status === "completed" || item.status === "cancelled";
}

/**
 * Pick which items stay visible when the list exceeds maxRows: the
 * in_progress item always, then pending in list order, then the most recent
 * completed — rendered in their original order, with a trailing "+N more".
 */
function visibleSubset(items: TodoItem[], maxItems: number): { shown: TodoItem[]; hidden: number } {
    if (items.length <= maxItems) return { shown: items, hidden: 0 };
    const keep = new Set<TodoItem>();
    const byPriority = [
        ...items.filter((t) => t.status === "in_progress"),
        ...items.filter((t) => t.status === "pending"),
        ...items.filter(isTerminal).reverse(),
    ];
    for (const t of byPriority) {
        if (keep.size >= maxItems) break;
        keep.add(t);
    }
    return { shown: items.filter((t) => keep.has(t)), hidden: items.length - keep.size };
}

/**
 * One-line scrollback summary for a retiring panel: a fully-terminal list
 * reads "all 5 done", one with work left reads "3 of 7 open". Only the pinned
 * rows retire — the list itself stays in session state for nudges and resume.
 */
export function formatRetireLine(items: TodoItem[]): string {
    const open = items.filter((t) => !isTerminal(t)).length;
    return open === 0 ? `todos: all ${items.length} done` : `todos: ${open} of ${items.length} open`;
}

/** Pure layout — exported for tests. Empty list renders as no rows at all. */
export function formatTodoPanel(items: TodoItem[], width: number, maxRows = MAX_BODY_ROWS): string[] {
    if (items.length === 0) return [];
    const done = items.filter((t) => t.status === "completed").length;
    const title = `─ todos (${done}/${items.length}) `;
    const header = dim(title.length < width ? title + "─".repeat(width - title.length) : title.slice(0, width));
    // Reserve the last row for "+N more" when clipping.
    const { shown, hidden } = visibleSubset(items, maxRows);
    const clipped = hidden > 0 ? visibleSubset(items, maxRows - 1) : { shown, hidden };
    const lines = [header, ...clipped.shown.map((t) => clip(row(t), width))];
    if (clipped.hidden > 0) lines.push(dim(`    +${clipped.hidden} more`));
    return lines;
}

export class TodoPanel implements Component {
    private items: TodoItem[] = [];

    setItems(items: TodoItem[]): void {
        this.items = [...items];
    }

    clear(): void {
        this.items = [];
    }

    isEmpty(): boolean {
        return this.items.length === 0;
    }

    allCompleted(): boolean {
        return this.items.length > 0 && this.items.every(isTerminal);
    }

    retireLine(): string {
        return formatRetireLine(this.items);
    }

    count(): number {
        return this.items.length;
    }

    invalidate(): void {}

    render(width: number): string[] {
        return formatTodoPanel(this.items, width);
    }
}
