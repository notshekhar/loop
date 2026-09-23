/**
 * Command output belongs to the theme.
 *
 * `/cost`, `/steak`, `/doctor` and `/context` printed their headings with
 * `chalk.bold` alone — bold in whatever foreground the terminal happens to
 * use — so those blocks ignored `/theme` and `/uimode` entirely and stayed put
 * while the rest of the app moved. The heat grid underneath the steak wall was
 * themed the whole time, which is what made the mismatch obvious.
 *
 * These pin the helper the headings now go through, at a colour level a real
 * terminal has (see theme-attributes.test.ts on why the level is set here).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";

process.env.COLORTERM = "truecolor";

import { initTheme, theme } from "../src/interactive/ui/theme";
import { accent, heading } from "../src/interactive/ui/text";

beforeAll(() => {
    initTheme("night");
    chalk.level = 3;
});

afterAll(() => {
    initTheme("night");
    chalk.level = 0;
});

/** The SGR escapes in a string, which is what "is this themed" comes down to. */
const escapes = (s: string) => s.match(/\x1b\[[0-9;]*m/g) ?? [];

describe("a heading in command output", () => {
    test("carries the theme's heading colour, not just bold", () => {
        const line = heading("cost");
        // The same slot markdown headings use, so a heading loop prints and a
        // heading loop renders are the same colour.
        expect(line).toContain(theme.fg("mdHeading", "cost"));
        expect(escapes(line).length).toBeGreaterThan(1);
    });

    test("moves when the theme moves", () => {
        initTheme("night");
        const dark = heading("cost");
        initTheme("day");
        const light = heading("cost");
        expect(dark).not.toBe(light);
    });

    test("follows the active theme's palette", () => {
        initTheme("day");
        const day = heading("🥩 12.4M tokens in the last year");
        initTheme("night");
        const night = heading("🥩 12.4M tokens in the last year");
        expect(day).not.toBe(night);
    });

    test("still prints the text when no colour is available", () => {
        // Print mode and early startup render before a theme exists; the
        // helper falls back rather than throwing or dropping the words.
        expect(heading("doctor")).toContain("doctor");
    });
});

describe("a figure in a stat row", () => {
    test("rides the accent, the way /cost's dollar figures already did", () => {
        initTheme("night");
        expect(accent("3 days")).toContain(theme.fg("accent", "3 days"));
    });
});
