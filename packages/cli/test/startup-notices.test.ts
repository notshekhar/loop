import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { ChatHistory } from "../src/interactive/components/chat-history";
import { addStartupNotice, replayStartupNotices, resetStartupNotices } from "../src/interactive/welcome";
import { initTheme } from "../src/interactive/ui/theme";

const W = 70;
const tui = {
    requestRender() {},
    get terminal() {
        return { rows: 24, columns: 80 };
    },
} as unknown as TUI;

const text = (h: ChatHistory) =>
    h
        .render(W)
        .map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, ""))
        .join("\n");

beforeEach(() => {
    initTheme("night");
    resetStartupNotices();
});

describe("the startup block stays with the masthead", () => {
    test("a notice is shown when it is recorded", () => {
        const h = new ChatHistory(tui, "/repo");
        addStartupNotice(h, "workspace context: none");
        expect(text(h)).toContain("workspace context: none");
    });

    test("a rebuilt transcript can put the whole block back, in order", () => {
        const collected = new ChatHistory(tui, "/repo");
        addStartupNotice(collected, "workspace context (1):");
        addStartupNotice(collected, "  • ~/AGENTS.md");
        addStartupNotice(collected, "extensions: lsp · wayfinder");

        // What /ui and /theme do: throw the transcript away and build it again.
        const rebuilt = new ChatHistory(tui, "/repo");
        replayStartupNotices(rebuilt);
        const out = text(rebuilt);
        expect(out).toContain("workspace context (1):");
        expect(out).toContain("  • ~/AGENTS.md");
        expect(out).toContain("extensions: lsp · wayfinder");
        expect(out.indexOf("workspace context (1):")).toBeLessThan(out.indexOf("extensions:"));
    });

    test("collecting the block again does not stack it up (/new, /clear)", () => {
        const h = new ChatHistory(tui, "/repo");
        addStartupNotice(h, "extensions: lsp");
        resetStartupNotices();
        addStartupNotice(h, "extensions: lsp");

        const rebuilt = new ChatHistory(tui, "/repo");
        replayStartupNotices(rebuilt);
        expect(text(rebuilt).match(/extensions: lsp/g)?.length).toBe(1);
    });
});

describe("the block is emitted before the conversation, not after it", () => {
    // The bug this guards: `loop --session <id>` printed the header's own
    // status lines UNDERNEATH the entire replayed conversation, because both
    // collectors are awaited and used to run after the replay. Nothing is
    // painted until tui.start(), so this is purely a matter of call order.
    const app = readFileSync(join(import.meta.dir, "..", "src", "interactive", "app.ts"), "utf8");

    test("startup banners are collected before the transcript is replayed", () => {
        const banners = app.indexOf("await showWorkspaceBanners(");
        const replay = app.indexOf("renderSessionBranch(initialSession");
        expect(banners).toBeGreaterThan(-1);
        expect(replay).toBeGreaterThan(-1);
        expect(banners).toBeLessThan(replay);
    });

    test("so is the no-model guidance", () => {
        const guidance = app.indexOf("await showNoModelGuidance(");
        const replay = app.indexOf("renderSessionBranch(initialSession");
        expect(guidance).toBeGreaterThan(-1);
        expect(guidance).toBeLessThan(replay);
    });
});
