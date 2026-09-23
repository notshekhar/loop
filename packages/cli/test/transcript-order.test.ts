import { beforeEach, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { initTheme } from "../src/interactive/ui/theme";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { describeTurnFailure } from "../src/interactive/turn-runner";

/**
 * The transcript is read top to bottom, so a line belongs where it HAPPENED.
 *
 * A turn streams into its own container, and errors, hook notes and system
 * lines used to be appended to the root — below the whole turn — so the rest
 * of the turn then streamed in ABOVE them: an error raised halfway through
 * stuck to the bottom of the screen. grok keeps one list in arrival order;
 * these pin the same property here.
 */

const tui = { requestRender() {}, resetFrame() {}, terminal: { rows: 40, columns: 90 } } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const lines = (h: ChatHistory) =>
    h
        .render(90)
        .map(strip)
        .map((l) => l.trim())
        .filter(Boolean);
const order = (h: ChatHistory, ...needles: string[]) =>
    needles.map((n) => lines(h).findIndex((l) => l.includes(n)));

beforeEach(() => initTheme("night"));

describe("lines land where they happened", () => {
    test("an error raised mid-turn stays between what came before and after", () => {
        const h = new ChatHistory(tui, "/repo");
        h.addUser("do the thing");
        h.appendAssistantDelta("Starting.", "p", "m");
        h.addError("mcp server disconnected");
        h.addSystem("hook: formatted 2 files");
        h.addToolCall("bash", "b1", { command: "bun test" });
        h.addToolResult("b1", "3 pass");
        h.appendAssistantDelta("Done.", "p", "m");
        h.finishAssistant();

        const [start, error, note, run, done] = order(
            h,
            "Starting.",
            "error: mcp server disconnected",
            "hook: formatted 2 files",
            "Ran 1 command",
            "Done.",
        );
        expect(start).toBeLessThan(error);
        expect(error).toBeLessThan(note);
        expect(note).toBeLessThan(run);
        expect(run).toBeLessThan(done);
    });

    test("the turn's closing line comes after the turn, and the next turn after that", () => {
        const h = new ChatHistory(tui, "/repo");
        h.addUser("first");
        h.appendAssistantDelta("one", "p", "m");
        h.finishAssistant();
        h.addTurnSummary(3);
        h.addSystem("model switched");
        h.addUser("second");
        h.appendAssistantDelta("two", "p", "m");
        h.addError("late failure");
        h.finishAssistant();

        const [one, summary, switched, second, two, late] = order(
            h,
            "one",
            "Turn completed in 3s.",
            "model switched",
            "second",
            "two",
            "late failure",
        );
        expect([one, summary, switched, second, two, late]).toEqual(
            [one, summary, switched, second, two, late].slice().sort((a, b) => a - b),
        );
        expect(Math.min(one, summary, switched, second, two, late)).toBeGreaterThan(-1);
    });
});

describe("a failed turn closes with one line", () => {
    test("it says it failed, how long it ran, and why", () => {
        const h = new ChatHistory(tui, "/repo");
        h.addUser("go");
        h.appendAssistantDelta("Trying.", "p", "m");
        h.finishAssistant();
        h.addTurnFailed(2.4, "rate limited (429)");
        const out = lines(h).join("\n");
        expect(out).toContain("Turn failed in 2s: rate limited (429)");
        expect(out).not.toContain("Turn completed");
    });

    test("the first error is the cause; repeats are one failure", () => {
        const boom = new Error("connection reset");
        expect(describeTurnFailure([boom])).toBe("connection reset");
        // A stream error and the throw that carries it out are the same failure.
        expect(describeTurnFailure([boom, new Error("connection reset")])).toBe("connection reset");
        expect(describeTurnFailure([boom, new Error("hook failed"), new Error("disk full")])).toBe(
            "connection reset (and 2 more)",
        );
    });
});
