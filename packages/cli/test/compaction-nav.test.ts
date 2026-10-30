import { beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

// Pin the color pipeline before the theme module reads COLORTERM.
process.env.COLORTERM = "truecolor";

import { ChatHistory } from "../src/interactive/components/chat-history";
import { initTheme } from "../src/interactive/ui/theme";

beforeAll(() => initTheme("dark"));

const tui = { requestRender() {} } as unknown as TUI;
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const text = (history: ChatHistory): string => strip(history.render(120).join("\n"));

/**
 * The [compaction] box is a transcript entry like a thought or a call: the
 * nav selection reaches it, → and Enter open it, and its "→ to expand" hint
 * shows only while it is selected — the only time → does anything.
 */
describe("the compaction box in nav", () => {
    const withCompaction = () => {
        const history = new ChatHistory(tui, "/repo");
        history.addCompactionSummary("## Goal\nSUMMARY_BODY", 84_185);
        return history;
    };

    test("is collapsed, with no nav hint, until selected", () => {
        const out = text(withCompaction());
        expect(out).toContain("Compacted from 84,185 tokens");
        expect(out).not.toContain("SUMMARY_BODY");
        expect(out).not.toContain("→");
    });

    test("is selectable, and opens and closes from the keyboard", () => {
        const history = withCompaction();
        expect(history.moveSelection(-1)).toBe(true);
        expect(text(history)).toContain("→ to expand");
        expect(history.setSelectedExpanded(true)).toBe(true);
        expect(text(history)).toContain("SUMMARY_BODY");
        expect(history.setSelectedExpanded(false)).toBe(true);
        expect(text(history)).not.toContain("SUMMARY_BODY");
        expect(history.toggleSelected()).toBe(true);
        expect(text(history)).toContain("SUMMARY_BODY");
    });
});

describe("the compaction box with /compact instructions", () => {
    test("shows the instructions collapsed and expanded", () => {
        const history = new ChatHistory(tui, "/repo");
        history.addCompactionSummary("SUMMARY_BODY", 1_000, Date.now(), undefined, "keep the API changes");
        expect(text(history)).toContain("Instructions: keep the API changes");
        history.moveSelection(-1);
        history.setSelectedExpanded(true);
        const open = text(history);
        expect(open).toContain("Instructions: keep the API changes");
        expect(open).toContain("SUMMARY_BODY");
    });

    test("says nothing about instructions when none were given", () => {
        const history = new ChatHistory(tui, "/repo");
        history.addCompactionSummary("SUMMARY_BODY", 1_000);
        expect(text(history)).not.toContain("Instructions:");
    });
});
