import { describe, expect, test } from "bun:test";
import { scrollTopFor } from "../src/interactive/transcript-scroll";

/**
 * The rule that puts the selected entry back on screen. It is arithmetic, so
 * it is tested as arithmetic — the frame that applies it (app.ts) then has
 * nothing left to get wrong but which window it asked about.
 */
describe("scrollTopFor", () => {
    const view = (top: number, height = 10) => ({ top, height });

    test("an entry already on screen does not move the page", () => {
        expect(scrollTopFor({ start: 3, end: 6 }, view(0))).toBe(0);
        expect(scrollTopFor({ start: 20, end: 24 }, view(20))).toBe(20);
        // Exactly filling the window is still "on screen".
        expect(scrollTopFor({ start: 20, end: 29 }, view(20))).toBe(20);
    });

    test("an entry above the window scrolls up to its first line", () => {
        expect(scrollTopFor({ start: 4, end: 7 }, view(10))).toBe(4);
    });

    test("an entry below the window scrolls down by the least it can", () => {
        // Its last line lands on the window's last row; everything above it
        // that still fits stays visible.
        expect(scrollTopFor({ start: 18, end: 22 }, view(10))).toBe(13);
    });

    test("an entry taller than the window pins to its TOP", () => {
        // Both ends cannot be shown, and choosing a different end per render
        // is what made the page judder. The top wins: an entry starts by
        // saying what it is.
        expect(scrollTopFor({ start: 30, end: 80 }, view(0))).toBe(30);
        expect(scrollTopFor({ start: 30, end: 80 }, view(60))).toBe(30);
    });

    test("the page never scrolls above its first line", () => {
        expect(scrollTopFor({ start: 0, end: 40 }, view(5))).toBe(0);
    });

    test("a window with no rows asks for no movement", () => {
        expect(scrollTopFor({ start: 50, end: 60 }, view(7, 0))).toBe(7);
    });
});
