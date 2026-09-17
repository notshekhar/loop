import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { TuiAltScreen } from "../src/tui-alt-screen";
import { CURSOR_MARKER } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("fullscreen resize recovery", () => {
    for (const [name, columns, rows] of [
        ["width", 12, 6],
        ["height", 30, 3],
    ] as const) {
        it(`repaints after ${name} shrinks and returns between frames`, async () => {
            const terminal = new VirtualTerminal(30, 6);
            const tui = new TuiAltScreen(terminal);
            tui.addChild({
                render: () => [
                    "Header with text at the right",
                    "First transcript line",
                    "Second transcript line",
                    "Third transcript line",
                    "Status: ready",
                    `> draft${CURSOR_MARKER}`,
                ],
                invalidate() {},
            });
            try {
                tui.start();
                await terminal.waitForRender();
                const expected = terminal.getViewport();
                const expectedCursor = terminal.getCursorPosition();

                terminal.resize(columns, rows);
                terminal.resize(30, 6);
                await terminal.waitForRender();

                assert.deepEqual(terminal.getViewport(), expected);
                assert.deepEqual(terminal.getCursorPosition(), expectedCursor);
            } finally {
                tui.stop({ preserveScreen: true });
            }
        });
    }
});
