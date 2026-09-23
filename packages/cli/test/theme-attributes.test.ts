/**
 * The theme's text attributes, at a colour level a real terminal has.
 *
 * `transcript-snapshot.test.ts` pins `chalk.level = 0` so its byte-identity
 * baseline does not depend on whoever's shell exports `FORCE_COLOR`. That pin
 * has a cost: at level 0 chalk emits nothing, so `bold`/`italic`/`underline`
 * render as plain text there and the snapshots assert nothing about them.
 *
 * This covers that hole from the other side. It is deliberately about the
 * attributes ONLY — colour comes from `fg`/`bg`, which build their escapes by
 * hand and are exercised everywhere else.
 *
 * Worth having beyond the bookkeeping: the two halves of "colour" in this
 * theme come from different places, and a change that moved `fg` off its
 * hand-built escapes onto chalk would make every colour in the app disappear
 * whenever stdout is not a TTY — a failure nobody would see in a test run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";

process.env.COLORTERM = "truecolor";

import { initTheme, theme } from "../src/interactive/ui/theme";

// Level 3 = truecolor, matching what `fg`/`bg` emit unconditionally. Set on
// the instance because chalk reads FORCE_COLOR at import time and imports
// hoist — see the note in transcript-snapshot.test.ts.
beforeAll(() => {
    initTheme("dark");
    chalk.level = 3;
});

// Put it back where the snapshot baseline needs it. chalk is a singleton bun
// shares across every test file in the process, so raising the level and
// leaving it raised would break transcript-snapshot.test.ts from the outside.
afterAll(() => {
    chalk.level = 0;
});

describe("theme text attributes", () => {
    test("bold, italic and underline emit their SGR pairs", () => {
        // Asserted as bytes, because that is the whole contract: these strings
        // go straight to a terminal.
        expect(theme.bold("x")).toBe("\x1b[1mx\x1b[22m");
        expect(theme.italic("x")).toBe("\x1b[3mx\x1b[23m");
        expect(theme.underline("x")).toBe("\x1b[4mx\x1b[24m");
    });

    test("attributes nest inside a colour without swallowing it", () => {
        // The thinking row is exactly this shape — `fg(..., italic(...))` —
        // and a reset in the wrong order would drop the colour for the rest
        // of the line.
        const styled = theme.fg("thinkingText", theme.italic("thinking"));
        expect(styled).toContain("\x1b[3mthinking\x1b[23m");
        expect(styled.endsWith("\x1b[39m")).toBe(true);
    });

    test("they degrade to plain text when the sink has no colour", () => {
        // Level 0 is what `bun test` sees by default (stdout is not a TTY),
        // and what the snapshot baseline was captured at.
        chalk.level = 0;
        try {
            expect(theme.bold("x")).toBe("x");
            expect(theme.italic("x")).toBe("x");
            // fg does NOT go through chalk, so it keeps its colour either way.
            expect(theme.fg("thinkingText", "x")).toContain("\x1b[");
        } finally {
            chalk.level = 3;
        }
    });
});
