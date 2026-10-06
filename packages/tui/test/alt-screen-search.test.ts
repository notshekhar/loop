import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { AltScreenSearchComponent, AltScreenSearchIndex, findAltScreenSearchMatches } from "../src/alt-screen-search";
import { Text } from "../src/components/text";
import { TuiAltScreen } from "../src/tui-alt-screen";
import { stripTerminalSequences, visibleWidth } from "../src/utils";
import { VirtualTerminal } from "./virtual-terminal";

describe("fullscreen transcript search", () => {
    it("searches normalized rendered transcript text across rows", () => {
        assert.deepEqual(findAltScreenSearchMatches(["alpha QUICK", "brown fox"], "quick brown"), [
            {
                segments: [
                    { row: 0, startCol: 6, endCol: 11 },
                    { row: 1, startCol: 0, endCol: 5 },
                ],
            },
        ]);
    });

    it("maps normalized ASCII and Unicode search matches back to rendered columns", () => {
        assert.deepEqual(findAltScreenSearchMatches(["\x1b[31mfoo  bar\x1b[0m", "A界🙂éZ"], "oo   bar\nA界🙂é"), [
            {
                segments: [
                    { row: 0, startCol: 1, endCol: 3 },
                    { row: 0, startCol: 5, endCol: 8 },
                    { row: 1, startCol: 0, endCol: 6 },
                ],
            },
        ]);
    });

    it("reuses indexed transcript matches until the query or rendered lines change", () => {
        const index = new AltScreenSearchIndex();
        const initial = index.search(["alpha needle", "omega"], "needle");
        assert.equal(initial.changed, true);
        assert.equal(initial.matches.length, 1);

        const cached = index.search(["alpha needle", "omega"], "needle");
        assert.equal(cached.changed, false);
        assert.equal(cached.matches, initial.matches);

        const changedQuery = index.search(["alpha needle", "omega"], "omega");
        assert.equal(changedQuery.changed, true);
        assert.notEqual(changedQuery.matches, initial.matches);
        assert.deepEqual(changedQuery.matches[0]?.segments, [{ row: 1, startCol: 0, endCol: 5 }]);

        const changedLines = index.search(["alpha needle", "no match"], "omega");
        assert.equal(changedLines.changed, true);
        assert.deepEqual(changedLines.matches, []);
    });

    it("renders transcript search with a muted placeholder and right-aligned controls", () => {
        const component = new AltScreenSearchComponent(() => {});
        const rendered = component.render(48);
        const lines = rendered.map((line) => stripTerminalSequences(line));

        assert.equal(lines.length, 3);
        assert.ok(lines.every((line) => visibleWidth(line) === 48));
        assert.match(lines[0] ?? "", /^┌─+┐$/);
        assert.match(lines[1] ?? "", /^│ Find in transcript +│$/);
        assert.ok(rendered[1]?.includes("\x1b[2m"));
        assert.match(lines[2] ?? "", /^└─+ ↑ Shift\+Enter · ↓ Enter ─┘$/);
        const controls = lines[2] ?? "";
        assert.equal(component.getNavigationDirectionAt(2, controls.indexOf("↑")), -1);
        assert.equal(component.getNavigationDirectionAt(2, controls.indexOf("Shift+Enter") + 5), -1);
        assert.equal(component.getNavigationDirectionAt(2, controls.indexOf("·")), undefined);
        assert.equal(component.getNavigationDirectionAt(2, controls.indexOf("↓")), 1);
        assert.equal(component.getNavigationDirectionAt(2, controls.lastIndexOf("Enter") + 2), 1);

        component.handleInput("n");
        component.setResult(0, 2);
        const populatedRender = component.render(48);
        const populated = populatedRender.map((line) => stripTerminalSequences(line));
        assert.ok(populated[1]?.includes("n"));
        assert.ok(populated[1]?.includes("1/2"));
        assert.ok(populatedRender[1]?.includes("\x1b[2m 1/2 \x1b[22m"));
        assert.ok(!populated.some((line) => line.includes("Find in transcript")));
    });

    it("does not treat transcript box drawing as search navigation buttons", async () => {
        const terminal = new VirtualTerminal(80, 10);
        const tui = new TuiAltScreen(terminal);
        tui.addChild(
            new Text(
                [
                    "needle one",
                    "middle",
                    "needle two",
                    "filler",
                    "┌────────────────────────────────────────┐",
                    "│ box                                    │",
                    "└────────────────────────────────────────┘",
                    "end",
                ].join("\n"),
                0,
                0,
            ),
        );
        tui.start();
        await terminal.waitForRender();

        terminal.sendInput("\x1b[102;6u");
        terminal.sendInput("needle");
        await terminal.waitForRender();
        let viewport = terminal.getViewport();
        assert.ok(viewport.some((line) => line.includes("1/2")));
        assert.ok(!viewport.some((line) => line.includes("2/2")));

        const boxBottomRow = viewport.findIndex((line) => line.startsWith("└"));
        assert.ok(boxBottomRow >= 0);
        terminal.sendInput(`\x1b[<0;24;${boxBottomRow + 1}M`);
        await terminal.waitForRender();

        viewport = terminal.getViewport();
        assert.ok(viewport.some((line) => line.includes("1/2")));
        assert.ok(!viewport.some((line) => line.includes("2/2")));
        tui.stop();
    });

    it("keeps viewport scrolling while transcript search is focused", async () => {
        const terminal = new VirtualTerminal(20, 6);
        const tui = new TuiAltScreen(terminal);
        tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
        tui.start();
        await terminal.waitForRender();
        const topBefore = tui.viewportTop;

        terminal.sendInput("\x1b[102;6u");
        await terminal.waitForRender();
        assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));

        terminal.sendInput("\x1b[5~");
        terminal.sendInput("\x1b[<64;1;4M");
        await terminal.waitForRender();
        assert.ok(tui.viewportTop < topBefore);
        assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));
        tui.stop();
    });
});
