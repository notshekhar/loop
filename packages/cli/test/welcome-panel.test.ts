/**
 * An app's live panel under the masthead. It repaints when the app says its
 * lines changed, every row fills the width exactly, and it never gets shorter
 * — a shrink would strand rows once the masthead is in the scrollback.
 */
import { describe, expect, test } from "bun:test";
import { visibleWidth, type TUI } from "@notshekhar/loop-tui";
import type { WelcomePanel } from "@notshekhar/loop-core";
import { WelcomePanelView } from "../src/interactive/components/welcome-panel";

function fakePanel(initial: string[]) {
    let lines = initial;
    const listeners = new Set<() => void>();
    const panel: WelcomePanel = {
        lines: () => lines,
        subscribe(onChange) {
            listeners.add(onChange);
            return () => listeners.delete(onChange);
        },
    };
    const change = (next: string[]) => {
        lines = next;
        for (const listener of listeners) listener();
    };
    return { panel, change, listeners };
}

function fakeTui() {
    const tui = { renders: 0, requestRender: () => void tui.renders++ };
    return tui;
}

describe("welcome panel", () => {
    test("repaints on change and stops following once disposed", () => {
        const { panel, change, listeners } = fakePanel(["one"]);
        const tui = fakeTui();
        const view = new WelcomePanelView(tui as unknown as TUI, panel);
        change(["two"]);
        expect(tui.renders).toBe(1);
        expect(view.render(10)[0]!.trim()).toBe("two");
        view.dispose();
        expect(listeners.size).toBe(0);
    });

    test("every row is exactly the width: long ones cut, short ones padded", () => {
        const { panel } = fakePanel(["x".repeat(30), "short"]);
        const rows = new WelcomePanelView(fakeTui() as unknown as TUI, panel).render(12);
        expect(rows.map(visibleWidth)).toEqual([12, 12]);
        expect(rows[0]).toContain("…");
    });

    test("it never gets shorter", () => {
        const { panel, change } = fakePanel(["a", "b", "c"]);
        const view = new WelcomePanelView(fakeTui() as unknown as TUI, panel);
        expect(view.render(8)).toHaveLength(3);
        change(["a"]);
        expect(view.render(8)).toHaveLength(3);
    });
});
