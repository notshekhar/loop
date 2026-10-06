import assert from "node:assert/strict";
import { describe, expect, it } from "bun:test";
import { ScrollView } from "../src/components/scroll-view";
import { Text } from "../src/components/text";
import { VStack } from "../src/components/v-stack";
import { TuiAltScreen } from "../src/tui-alt-screen";
import { VirtualTerminal } from "./virtual-terminal";

const lines = (n: number) => Array.from({ length: n }, (_, index) => `line ${index + 1}`).join("\n");

describe("jump-to-end indicator", () => {
    it("shows a clickable label on the transcript's last row while scrolled up", async () => {
        const terminal = new VirtualTerminal(30, 6);
        const tui = new TuiAltScreen(terminal, undefined, undefined, {
            scrollToEndIndicator: () => "\x1b[7m ↓ Jump to end \x1b[27m",
        });
        const transcript = new ScrollView(new Text(lines(8), 0, 0), { follow: "end", primary: true });
        tui.setLayoutRoot(
            new VStack([
                { component: transcript, basis: 0, grow: 1, minSize: 1 },
                { component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
            ]),
        );
        tui.start();
        try {
            await terminal.waitForRender();
            assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));

            terminal.sendInput("\x1b[<64;1;1M");
            await terminal.waitForRender();
            assert.equal(transcript.isFollowingEnd, false);
            assert.ok(terminal.getViewport()[3]?.includes("↓ Jump to end"));

            // Pressing beside the label starts a selection instead of jumping.
            terminal.sendInput("\x1b[<0;2;4M");
            terminal.sendInput("\x1b[<0;2;4m");
            await terminal.waitForRender();
            assert.equal(transcript.isFollowingEnd, false);

            terminal.sendInput("\x1b[<0;15;4M");
            terminal.sendInput("\x1b[<0;15;4m");
            await terminal.waitForRender();
            assert.equal(transcript.isFollowingEnd, true);
            assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));
        } finally {
            tui.stop();
        }
    });

    it("never shows for a primary scroll view without follow-end", async () => {
        const terminal = new VirtualTerminal(30, 3);
        const tui = new TuiAltScreen(terminal, undefined, undefined, {
            scrollToEndIndicator: () => " ↓ Jump to end ",
        });
        const transcript = new ScrollView(new Text("one\ntwo\nthree\nfour\nfive", 0, 0), { primary: true });
        tui.setLayoutRoot(transcript);
        tui.start();
        try {
            await terminal.waitForRender();
            assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));
        } finally {
            tui.stop();
        }
    });
});

describe("wheel scrolling", () => {
    it("scrolls five times as far while Alt is held", async () => {
        const terminal = new VirtualTerminal(20, 4);
        const tui = new TuiAltScreen(terminal);
        tui.addChild(new Text(lines(12), 0, 0));
        tui.start();
        try {
            await terminal.waitForRender();
            assert.equal(tui.viewportTop, 8);
            // Alt sets bit 8 on the wheel button (72 = 64 + 8).
            terminal.sendInput("\x1b[<72;1;1M");
            await terminal.waitForRender();
            assert.equal(tui.viewportTop, 3);
        } finally {
            tui.stop();
        }
    });
});

describe("terminal focus", () => {
    it("tells onFocusIn when the terminal regains focus, and only then", async () => {
        const terminal = new VirtualTerminal(20, 4);
        const tui = new TuiAltScreen(terminal);
        let focusIns = 0;
        tui.onFocusIn = () => focusIns++;
        tui.addChild(new Text("hello", 0, 0));
        tui.start();
        try {
            await terminal.waitForRender();
            terminal.sendInput("abc");
            terminal.sendInput("\x1b[O");
            expect(focusIns).toBe(0);
            terminal.sendInput("\x1b[I");
            expect(focusIns).toBe(1);
        } finally {
            tui.stop();
        }
    });
});
