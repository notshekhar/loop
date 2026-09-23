import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { TUI } from "@notshekhar/loop-tui";
import { resetRenderErrorLogForTest } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";
// Render failures are logged; keep this suite's out of the real agent dir.
process.env.LOOP_AGENT_DIR = `/tmp/loop-render-resilience-${process.pid}`;

import { initTheme } from "../src/interactive/ui/theme";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { AssistantMessageComponent } from "../src/interactive/ui/messages";
import { createErrorSurface } from "../src/interactive/console-bridge";
import { renderSessionBranch } from "../src/interactive/replay";

/**
 * The freeze: one entry that threw while rendering took the whole frame down
 * with it, the uncaught-exception handler surfaced the error and asked for a
 * repaint, and the repaint threw again. Nothing painted, and the chat grew by
 * an error line per frame. Each layer of the fix is pinned here; the frame
 * guard itself is in packages/tui/test/render-failure.test.ts.
 */

const tui = { requestRender() {}, resetFrame() {}, terminal: { rows: 40, columns: 80 } } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const W = 80;

beforeEach(() => {
    initTheme("night");
    resetRenderErrorLogForTest();
});

afterAll(() => {
    rmSync(process.env.LOOP_AGENT_DIR!, { recursive: true, force: true });
});

/** Make the next render of `target` throw, whatever it is. */
function poison(target: { render(width: number): string[] }, message = "poisoned entry"): void {
    target.render = () => {
        throw new Error(message);
    };
}

describe("one entry cannot take the transcript down", () => {
    test("a tool row that throws draws one line in its place", () => {
        const h = new ChatHistory(tui, "/repo");
        h.addUser("before");
        h.addToolCall("bash", "a", { command: "echo ok" });
        h.addToolResult("a", "ok");
        h.addToolCall("bash", "b", { command: "echo broken" });
        h.addToolResult("b", "x");
        h.addUser("after");
        const broken = h.children
            .flatMap((c) => ("children" in c ? [c, ...(c as { children: unknown[] }).children] : [c]))
            .find((c) => c instanceof ToolExecutionComponent && c.copyText().includes("broken"));
        poison(broken as ToolExecutionComponent);
        // Finished calls fold into a header; open the run so the row is drawn.
        h.moveSelection(-1);
        h.moveSelection(-1);
        h.setSelectedExpanded(true);

        const out = h.render(W).map(strip).join("\n");
        expect(out).toContain("could not draw this tool call: poisoned entry");
        // Everything around it still renders.
        expect(out).toContain("before");
        expect(out).toContain("echo ok");
        expect(out).toContain("after");
    });

    test("an assistant message that throws draws one line in its place", () => {
        const h = new ChatHistory(tui, "/repo");
        h.addUser("question");
        h.appendAssistantDelta("an answer", "p", "m");
        h.finishAssistant();
        h.addUser("follow-up");
        const message = h.children
            .flatMap((c) => ("children" in c ? [c, ...(c as { children: unknown[] }).children] : [c]))
            .find((c) => c instanceof AssistantMessageComponent) as AssistantMessageComponent;
        message.renderTracked = () => {
            throw new Error("bad message");
        };

        const out = h.render(W).map(strip).join("\n");
        expect(out).toContain("could not draw this message: bad message");
        expect(out).toContain("question");
        expect(out).toContain("follow-up");
    });

    test("the failure line fits the terminal, however long the error", () => {
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "a", { command: "x" });
        h.addToolResult("a", "x");
        const row = h.children.find((c) => c instanceof ToolExecutionComponent) as ToolExecutionComponent;
        poison(row, "e".repeat(500));
        h.selectLast();
        h.setSelectedExpanded(true); // open the run so the row is drawn
        for (const width of [30, 80, 120]) {
            for (const line of h.render(width).map(strip)) expect(line.length).toBeLessThanOrEqual(width);
        }
    });
});

describe("the error surface does not amplify", () => {
    test("the same error, over and over, is one line", () => {
        const added: string[] = [];
        let renders = 0;
        let clock = 0;
        const surface = createErrorSurface(
            { addError: (t: string) => added.push(t) },
            { requestRender: () => renders++ },
            () => clock,
        );
        for (let i = 0; i < 500; i++) {
            clock += 16; // one frame apart — the storm the freeze produced
            surface("uncaught", new Error("boom"));
        }
        expect(added).toEqual(["uncaught: boom"]);
        expect(renders).toBe(1);
    });

    test("the count is reported when a different error arrives", () => {
        const added: string[] = [];
        let clock = 0;
        const surface = createErrorSurface(
            { addError: (t: string) => added.push(t) },
            { requestRender: () => {} },
            () => clock,
        );
        for (let i = 0; i < 3; i++) surface("uncaught", new Error("boom"));
        surface("uncaught", new Error("different"));
        expect(added).toEqual(["uncaught: boom", "uncaught: boom (repeated 2×)", "uncaught: different"]);
    });

    test("the same error after a quiet spell is shown again", () => {
        const added: string[] = [];
        let clock = 0;
        const surface = createErrorSurface(
            { addError: (t: string) => added.push(t) },
            { requestRender: () => {} },
            () => clock,
        );
        surface("uncaught", new Error("boom"));
        clock += 60_000;
        surface("uncaught", new Error("boom"));
        expect(added).toEqual(["uncaught: boom", "uncaught: boom"]);
    });
});

describe("replay reads history, whatever model it names", () => {
    // Twelve of one user's sessions could not be reopened: older versions
    // stored bare model ids ("grok-4") or none, and replay parsed them as if
    // they were a request to CALL a model.
    const session = (entries: unknown[]) =>
        ({ id: "s", getBranch: () => entries }) as unknown as import("@notshekhar/loop-core").Session;
    const entries = [
        { type: "message", role: "user", content: "hi", ts: 1, id: "u1", parentId: null },
        { type: "message", role: "assistant", content: [{ type: "text", text: "hello" }], ts: 2, id: "a1", parentId: "u1" },
    ];

    for (const modelId of ["", "grok-4"]) {
        test(`a session opened with model id ${JSON.stringify(modelId)} replays`, () => {
            const h = new ChatHistory(tui, "/repo");
            expect(() => renderSessionBranch(session(entries), h, modelId)).not.toThrow();
            expect(h.render(W).map(strip).join("\n")).toContain("hello");
        });
    }
});
