import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import { visibleWidth } from "@notshekhar/loop-tui";
import type { TodoItem } from "@notshekhar/loop-core";
import { formatRetireLine, formatTodoPanel, TodoPanel } from "../src/interactive/components/todo-panel";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]): string[] => lines.map((l) => l.replace(ANSI_RE, ""));

const item = (content: string, status: TodoItem["status"] = "pending", activeForm?: string): TodoItem => ({
    content,
    status,
    ...(activeForm ? { activeForm } : {}),
});

describe("formatTodoPanel", () => {
    test("empty list renders no rows", () => {
        expect(formatTodoPanel([], 80)).toEqual([]);
    });

    test("header carries the done/total count and fills the width with a rule", () => {
        const lines = plain(formatTodoPanel([item("a", "completed"), item("b")], 40));
        expect(lines[0]).toStartWith("─ todos (1/2) ");
        expect(lines[0].length).toBe(40);
        expect(lines[0].endsWith("─")).toBe(true);
    });

    test("status markers: ○ pending, ◌ in_progress, ✓ completed", () => {
        const lines = plain(
            formatTodoPanel([item("read", "completed"), item("wire", "in_progress"), item("test")], 60),
        );
        expect(lines[1]).toBe("✓ read");
        expect(lines[2]).toBe("◌ wire");
        expect(lines[3]).toBe("○ test");
    });

    test("cancelled renders as a · row", () => {
        const lines = plain(formatTodoPanel([item("dropped", "cancelled"), item("next")], 60));
        expect(lines[1]).toBe("· dropped");
        expect(lines[2]).toBe("○ next");
    });

    test("in_progress shows activeForm when present", () => {
        const lines = plain(formatTodoPanel([item("wire handler", "in_progress", "wiring handler")], 60));
        expect(lines[1]).toBe("◌ wiring handler");
    });

    test("long rows clip to width with an ellipsis", () => {
        const lines = plain(formatTodoPanel([item("x".repeat(100))], 20));
        expect(lines[1].length).toBeLessThanOrEqual(20);
        expect(lines[1].endsWith("…")).toBe(true);
    });

    test("clipped rows keep their styling", () => {
        const prev = chalk.level;
        chalk.level = 2;
        try {
            const lines = formatTodoPanel([item("x".repeat(100), "in_progress")], 20);
            // The clip used to return the ANSI-stripped slice, so an overlong
            // in_progress row lost its cyan while short rows stayed styled.
            expect(lines[1]).toContain("\x1b[");
            const stripped = lines[1].replace(ANSI_RE, "");
            expect(stripped.endsWith("…")).toBe(true);
            expect(stripped.length).toBeLessThanOrEqual(20);
        } finally {
            chalk.level = prev;
        }
    });

    test("wide characters clip by display cells, not code units", () => {
        const lines = plain(formatTodoPanel([item("宽".repeat(40))], 20));
        expect(visibleWidth(lines[1])).toBeLessThanOrEqual(20);
        expect(lines[1].endsWith("…")).toBe(true);
    });

    test("emoji rows never split a surrogate pair at the clip point", () => {
        const lines = plain(formatTodoPanel([item("🙂".repeat(40))], 20));
        expect(visibleWidth(lines[1])).toBeLessThanOrEqual(20);
        // Whole emoji + ellipsis only — a code-unit slice leaves a lone surrogate.
        expect(lines[1]).toMatch(/^○ (?:🙂)+…$/u);
    });

    test("overflow keeps in_progress + pending and adds a +N more row", () => {
        const items = [
            ...Array.from({ length: 5 }, (_, i) => item(`done ${i}`, "completed")),
            item("active", "in_progress"),
            ...Array.from({ length: 4 }, (_, i) => item(`next ${i}`)),
        ];
        const lines = plain(formatTodoPanel(items, 60, 6));
        expect(lines.length).toBe(1 + 6); // header + 5 items + "+N more"
        expect(lines.some((l) => l.includes("◌ active"))).toBe(true);
        expect(lines.at(-1)).toBe("    +5 more");
        // Every pending item beats older completed ones into the panel.
        expect(lines.filter((l) => l.includes("○ next")).length).toBe(4);
    });

    test("small lists render every item with no more-row", () => {
        const lines = plain(formatTodoPanel([item("a"), item("b")], 60, 6));
        expect(lines.length).toBe(3);
        expect(lines.some((l) => l.includes("more"))).toBe(false);
    });
});

describe("formatRetireLine", () => {
    test("fully-terminal list celebrates, counting cancelled as done", () => {
        expect(formatRetireLine([item("a", "completed"), item("b", "cancelled")])).toBe("todos: all 2 done");
    });

    test("open work reports what's left", () => {
        expect(formatRetireLine([item("a", "completed"), item("b", "in_progress"), item("c")])).toBe(
            "todos: 2 of 3 open",
        );
    });
});

describe("TodoPanel", () => {
    test("retireLine reflects the current items", () => {
        const p = new TodoPanel();
        p.setItems([item("a", "completed"), item("b")]);
        expect(p.retireLine()).toBe("todos: 1 of 2 open");
    });

    test("allCompleted treats cancelled as terminal", () => {
        const p = new TodoPanel();
        p.setItems([item("a", "completed"), item("b", "cancelled")]);
        expect(p.allCompleted()).toBe(true);
        p.setItems([item("a", "completed"), item("b", "cancelled"), item("c")]);
        expect(p.allCompleted()).toBe(false);
    });

    test("setItems/clear drive render and allCompleted", () => {
        const p = new TodoPanel();
        expect(p.render(80)).toEqual([]);
        expect(p.allCompleted()).toBe(false);
        p.setItems([item("a", "completed"), item("b", "completed")]);
        expect(p.allCompleted()).toBe(true);
        expect(p.count()).toBe(2);
        expect(p.render(80).length).toBe(3);
        p.clear();
        expect(p.render(80)).toEqual([]);
        expect(p.isEmpty()).toBe(true);
    });
});
