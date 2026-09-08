/**
 * What gives way when a tool row is too long for the terminal.
 *
 * The row ends in its verdict — a running call's `· running`, a folded
 * member's `2121 bytes`, a read's `:120-179`. Fitting used to cut the row's
 * END, so the verdict was the first thing lost and an ellipsis sat exactly
 * where it had been: a call still running read as one that stopped mid-word.
 * The content is what there is always more of, so the content is what gets cut.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { registerNoirMode } from "../src/interactive/ui/noir-mode";
import { setActiveUiMode, setLiveVariant } from "../src/interactive/ui/ui-mode";
import { initTheme } from "../src/interactive/ui/theme";
import { fitAroundTail } from "../src/interactive/ui/fit";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { ChatHistory } from "../src/interactive/components/chat-history";

beforeAll(() => registerNoirMode());
afterEach(() => {
    setLiveVariant(false);
    setActiveUiMode("loop");
    initTheme("dark");
});

const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const LONG = "git log --oneline -50 | grep -v Merge | awk '{print $1}' | xargs -n1 git show --stat | head -200";
const DEEP = "/repo/packages/core/src/interactive/handlers/very/deeply/nested/module-name-here.ts";

describe("fitAroundTail", () => {
    test("leaves a row that fits exactly alone", () => {
        expect(fitAroundTail("ab", "cd", "ef", 6)).toBe("abcdef");
    });

    test("cuts the middle and keeps the tail whole", () => {
        const out = fitAroundTail("|", "0123456789", "|END", 10);
        expect(out.endsWith("|END")).toBe(true);
        expect(strip(out).length).toBeLessThanOrEqual(10);
        expect(out).toContain("…");
    });

    test("falls back rather than emitting a row wider than the terminal", () => {
        // No room for head + tail, let alone anything between them. An
        // overflowing line trips the TUI's crash guard, so the rule that must
        // never break is the width one.
        for (const w of [1, 2, 3, 4, 5]) {
            expect(strip(fitAroundTail("head", "middle", "tail", w)).length).toBeLessThanOrEqual(w);
        }
    });
});

describe("a single tool row", () => {
    const row = (width: number, args: Record<string, unknown>, tool = "bash", finish = false) => {
        setActiveUiMode("noir");
        initTheme("dark");
        const c = new ToolExecutionComponent(tool, args, tui, "/repo");
        if (finish) c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        return c
            .render(width)
            .map(strip)
            .find((l) => l.includes(tool))!;
    };

    test("a running call keeps saying it is running, however long the command", () => {
        for (const w of [100, 80, 60]) {
            const line = row(w, { command: LONG });
            expect(line.endsWith("· running")).toBe(true);
            expect(line).toContain("…");
            expect(line.length).toBeLessThanOrEqual(w);
        }
    });

    test("a read keeps the line range it was asked for", () => {
        const line = row(70, { path: DEEP, offset: 120, limit: 60 }, "read", true);
        expect(line.endsWith(":120-179")).toBe(true);
        expect(line).toContain("…");
    });

    test("the expand hint does not push the status off the row", () => {
        setActiveUiMode("noir");
        initTheme("dark");
        const c = new ToolExecutionComponent("bash", { command: LONG }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "a\n".repeat(40) }], isError: false }, false);
        c.setSelected(true);
        for (const line of c.render(80).map(strip)) expect(line.length).toBeLessThanOrEqual(80);
    });
});

describe("a folded run's member rows", () => {
    test("a mixed run keeps every receipt whole", () => {
        setActiveUiMode("noir");
        initTheme("night");
        setLiveVariant(true);
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "a", { command: LONG });
        h.addToolResult("a", "x");
        h.addToolCall("read", "b", { path: DEEP });
        h.addToolResult("b", "line\n".repeat(30));

        for (const w of [100, 90, 80]) {
            const lines = h.render(w).map(strip);
            // The tool column costs its name PLUS a separator; counting only
            // the name built rows two columns too wide, and the two characters
            // the fit then removed came off the receipt.
            expect(lines.some((l) => l.includes("ok · 1 line"))).toBe(true);
            expect(lines.some((l) => l.includes("30 lines"))).toBe(true);
            for (const l of lines) expect(l.length).toBeLessThanOrEqual(w);
        }
    });

    test("a single-kind run keeps them too", () => {
        setActiveUiMode("noir");
        initTheme("night");
        setLiveVariant(true);
        const h = new ChatHistory(tui, "/repo");
        for (let i = 0; i < 2; i++) {
            h.addToolCall("bash", `c${i}`, { command: `${LONG} # ${i}` });
            h.addToolResult(`c${i}`, "x");
        }
        const lines = h.render(90).map(strip);
        expect(lines.filter((l) => l.includes("ok · 1 line")).length).toBe(2);
        for (const l of lines) expect(l.length).toBeLessThanOrEqual(90);
    });
});

describe("the default mode's box", () => {
    const box = (width: number, args: Record<string, unknown>, tool = "bash") => {
        setActiveUiMode("loop");
        initTheme("dark");
        const c = new ToolExecutionComponent(tool, args, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        return c.render(width).map(strip);
    };

    test("a long title stays ONE line instead of wrapping", () => {
        // A Text child wraps rather than clipping, so once summaries were
        // allowed their real length a single call became a two-line title.
        const lines = box(70, { command: LONG });
        expect(lines.filter((l) => l.includes("git log")).length).toBe(1);
        expect(lines.filter((l) => l.includes("head -200")).length).toBe(0);
    });

    test("and keeps its tail", () => {
        const line = box(70, { path: DEEP, offset: 120, limit: 60 }, "read").find((l) => l.includes("read"))!;
        expect(line).toContain(":120-179");
    });

    test("re-cuts when the terminal is resized", () => {
        setActiveUiMode("loop");
        initTheme("dark");
        const c = new ToolExecutionComponent("bash", { command: LONG }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        // The box is built lazily and cached; width has to be part of what
        // invalidates it, or the first width drawn is the only one ever fitted.
        const narrow = c.render(60).map(strip);
        const wide = c.render(160).map(strip);
        for (const l of narrow) expect(l.length).toBeLessThanOrEqual(60);
        for (const l of wide) expect(l.length).toBeLessThanOrEqual(160);
        expect(wide.some((l) => l.includes("head -200"))).toBe(true);
    });
});
