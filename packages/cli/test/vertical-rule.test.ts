import { afterEach, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { initTheme, verticalRule } from "../src/interactive/ui/theme";
import { markSelectedLines } from "../src/interactive/ui/messages";
import { WelcomeBanner } from "../src/interactive/components/welcome-banner";

/**
 * Vertical bars have to survive macOS Terminal.app, whose default font draws
 * the BLOCK ELEMENT family (`█`, `▌`) short of the cell box — so a column of
 * them renders as dashes with gaps instead of one continuous bar. Bars that
 * are already solid are painted as a background there, which fills the whole
 * cell and cannot gap.
 *
 * Thin RULES (the transcript rails) deliberately do not take that path: they
 * use box-drawing glyphs, which every font tiles, because a full-cell
 * background is far too heavy a mark for a hairline.
 */
const APPLE = "Apple_Terminal";
const prev = process.env.TERM_PROGRAM;
const BG_PAINTED = /\x1b\[48;2;\d+;\d+;\d+m \x1b\[49m/;

afterEach(() => {
    process.env.TERM_PROGRAM = prev;
});

describe("verticalRule", () => {
    test("glyph on a normal terminal, background paint on Terminal.app", () => {
        process.env.TERM_PROGRAM = "ghostty";
        expect(verticalRule("#ff0000", "█")).toContain("█");

        process.env.TERM_PROGRAM = APPLE;
        const apple = verticalRule("#ff0000", "█");
        expect(apple).not.toContain("█");
        expect(apple).toMatch(BG_PAINTED);
    });

    test("both forms occupy exactly one column", () => {
        for (const term of ["ghostty", APPLE]) {
            process.env.TERM_PROGRAM = term;
            const bar = verticalRule("#ff0000", "█").replace(/\x1b\[[0-9;]*m/g, "");
            expect(bar).toHaveLength(1);
        }
    });
});

describe("selection bar", () => {
    test("never renders as gapped block glyphs on Terminal.app", () => {
        initTheme("dark");
        process.env.TERM_PROGRAM = "ghostty";
        expect(markSelectedLines(["  x"])[0]).toContain("▌");

        process.env.TERM_PROGRAM = APPLE;
        const apple = markSelectedLines(["  x"])[0];
        expect(apple).not.toContain("▌");
        expect(apple).toMatch(BG_PAINTED);
    });

    test("the bar replaces the first cell, so the line never changes width", () => {
        initTheme("dark");
        for (const term of ["ghostty", APPLE]) {
            process.env.TERM_PROGRAM = term;
            const out = markSelectedLines(["  hello"])[0].replace(/\x1b\[[0-9;]*m/g, "");
            expect(out).toHaveLength("  hello".length);
        }
    });
});

describe("welcome banner rule", () => {
    const tui = { requestRender() {} } as unknown as TUI;
    const banner = () =>
        new WelcomeBanner(tui, {
            name: "x",
            model: () => "p/m",
            session: "unsaved",
            agent: null,
            branch: "main",
            cwd: "~/repo",
            version: "1.0.0",
        });

    test("the gradient rule is background-painted on Terminal.app", () => {
        initTheme("dark");
        process.env.TERM_PROGRAM = APPLE;
        const out = banner().render(80).join("\n");
        expect(out).not.toContain("█");
        expect(out).toMatch(BG_PAINTED);
    });

    test("and stays a glyph elsewhere", () => {
        initTheme("dark");
        process.env.TERM_PROGRAM = "ghostty";
        expect(banner().render(80).join("\n")).toContain("█");
    });
});
