import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { initTheme } from "../src/interactive/ui/theme";
import { ChatHistory } from "../src/interactive/components/chat-history";

const ROWS = 24;
const W = 70;

let terminal = { rows: ROWS, columns: 80 };
const tui = {
    requestRender() {},
    get terminal() {
        return terminal;
    },
} as unknown as TUI;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const lines = (h: ChatHistory) => h.render(W).map(strip);

beforeEach(() => {
    terminal = { rows: ROWS, columns: 80 };
    initTheme("night");
});

afterEach(() => {
    initTheme("night");
});

function history(messages: number): ChatHistory {
    const h = new ChatHistory(tui, "/repo");
    for (let i = 0; i < messages; i++) h.addSystem(`line ${i}`);
    return h;
}

describe("who owns the mouse", () => {
    // Mouse reporting is the TUI's, declared once when the alt screen opens
    // and handed back when it closes — it is what makes the wheel scroll and
    // what lets a drag select text inside the frame. What must NOT happen is
    // the app or the input handler grabbing and releasing it underneath that:
    // a mode that takes the mouse on entry and gives it back on exit is a mode
    // whose text selection works or not depending on where the keyboard is.
    const appSource = readFileSync(join(import.meta.dir, "..", "src", "interactive", "app.ts"), "utf8");
    const inputSource = readFileSync(join(import.meta.dir, "..", "src", "interactive", "input-handler.ts"), "utf8");

    test("neither the app nor the input handler toggles mouse reporting", () => {
        for (const source of [appSource, inputSource]) {
            for (const mode of ["?1006h", "?1000h", "?1002h", "?1000l", "?1006l"]) {
                expect(source).not.toContain(mode);
            }
        }
    });

    test("a click is handed over by the viewport, not intercepted from it", () => {
        // The gesture is recognised where text selection already recognises
        // it, and reported through `onClick`. Intercepting the press instead
        // would trade "a click selects an entry" for "you can no longer select
        // text", which is the trade this arrangement exists to avoid.
        expect(appSource).toContain("tui.onClick =");
        expect(appSource).not.toContain("setMouseInterceptor");
        expect(inputSource).not.toContain("\\x1b[<");
    });
});

describe("a frame that shrinks pulls its content back down", () => {
    // The general defect behind every version of this bug: a shrinking frame
    // (a menu closing, a panel going away) had its trailing rows cleared where
    // they were, leaving the prompt mid-screen with a gap beneath it. The lines
    // that belong in those rows were never lost — they are in the same array
    // being rendered — so the renderer repaints the visible window from them
    // instead, which needs no per-command patch and clears nothing.
    const settings = readFileSync(
        join(import.meta.dir, "..", "src", "interactive", "handlers", "settings-handlers.ts"),
        "utf8",
    );
    // The differential renderer lives in tui-main-screen.ts since the pi-mono
    // restructure; tui.ts is now the interfaces, Container and TuiBase.
    const tuiSource = readFileSync(join(import.meta.dir, "..", "..", "tui", "src", "tui-main-screen.ts"), "utf8");
    const tuiBaseSource = readFileSync(join(import.meta.dir, "..", "..", "tui", "src", "tui.ts"), "utf8");

    test("no command patches the layout on its way out any more", () => {
        // v0.19.5 fixed /settings alone by repainting on close, which cleared
        // the scrollback to do it (measured: two ESC[3J per toggle).
        expect(settings).not.toContain("repaintOnClose");
    });

    test("the fix lives in the renderer, so every selector gets it", () => {
        expect(tuiSource).toContain("newLines.length < this.previousLines.length");
    });

    test("a rebuilt transcript tells the renderer, instead of being detected", () => {
        // /new, /clear, a mode switch: the new transcript shares no lines with
        // the old one, so diffing them by index compares unrelated rows and
        // concludes the top of the screen is fine — leaving the previous
        // conversation sitting there under a fresh prompt. It cannot be
        // detected either, because a line INSERTED above the window looks
        // identical from the renderer's side and must NOT clear the screen.
        // Only the caller knows which it did.
        const chatHistory = readFileSync(
            join(import.meta.dir, "..", "src", "interactive", "components", "chat-history.ts"),
            "utf8",
        );
        const reset = chatHistory.slice(chatHistory.indexOf("    reset(): void {"));
        expect(reset.slice(0, 700)).toContain("this.tui.resetFrame()");
        expect(tuiBaseSource).toContain("resetFrame(): void {");
    });

    test("and it does not reach for the scrollback-clearing redraw", () => {
        // The shrink branch hands off to the shared window repaint...
        const shrink = tuiSource.slice(tuiSource.indexOf("newLines.length < this.previousLines.length"));
        expect(shrink.slice(0, 400)).toContain("this.repaintVisibleWindow(");
        expect(shrink.slice(0, 400)).not.toContain("fullRender(true)");
        // ...and that repaint clears rows, never the screen or the scrollback.
        const repaint = tuiSource.slice(tuiSource.indexOf("private repaintVisibleWindow("));
        const body = repaint.slice(0, repaint.indexOf("\n    }"));
        expect(body).not.toContain("fullRender");
        expect(body).not.toContain("\\x1b[3J");
        expect(body).not.toContain("\\x1b[2J");
    });
});

describe("the transcript renders whole", () => {
    // There is no navigation viewport any more: entries are selectable wherever
    // the keyboard is, and the window onto the transcript is the frame's — the
    // same one the wheel and PgUp move. What the transcript owes the frame is
    // geometry: where the selected entry sits, so the app can scroll to it.
    test("every line is rendered, whatever the terminal height", () => {
        const h = history(60);
        expect(lines(h).length).toBeGreaterThan(ROWS);
        terminal = { rows: 8, columns: 80 };
        expect(lines(h).length).toBeGreaterThan(ROWS);
    });

    test("no clip indicators — nothing is being clipped here", () => {
        const out = lines(history(60)).join("\n");
        expect(out).not.toMatch(/▲ \d+ more lines/);
        expect(out).not.toMatch(/▼ \d+ more lines/);
    });

    test("the selected entry reports where it sits, and only after a move", () => {
        const h = history(60);
        h.addToolCall("bash", "c1", { command: "echo hi" });
        h.addToolResult("c1", "hi");
        expect(h.selectedRange()).toBeNull();
        h.selectLast();
        lines(h); // ranges come from a render
        const range = h.selectedRange()!;
        expect(range.start).toBeGreaterThan(0);
        expect(range.end).toBeGreaterThanOrEqual(range.start);
        // One reveal per user action: the flag is taken, not polled, so a
        // streaming turn re-rendering cannot drag the page around.
        expect(h.takeRevealRequest()).toBe(true);
        expect(h.takeRevealRequest()).toBe(false);
    });
});
