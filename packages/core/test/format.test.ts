import { describe, expect, test } from "bun:test";
import { formatTokens } from "../src/format";

describe("formatTokens", () => {
    test("crossing a billion reads as B, not four digits of M", () => {
        // The bug: every copy of this formatter stopped at M, so a billion
        // tokens rendered as "1000M" and kept counting up from there.
        expect(formatTokens(999_999_999)).toBe("1.0B");
        expect(formatTokens(1_000_000_000)).toBe("1.0B");
        expect(formatTokens(1_400_000_000)).toBe("1.4B");
        expect(formatTokens(12_000_000_000)).toBe("12B");
    });

    test("past a thousand billion it reads as T", () => {
        expect(formatTokens(999_400_000_000)).toBe("999B");
        expect(formatTokens(999_600_000_000)).toBe("1.0T");
        expect(formatTokens(2_100_000_000_000)).toBe("2.1T");
        expect(formatTokens(45_000_000_000_000)).toBe("45T");
    });

    test("each magnitude keeps one decimal only where it means something", () => {
        expect(formatTokens(842)).toBe("842");
        expect(formatTokens(9_400)).toBe("9.4k");
        expect(formatTokens(183_000)).toBe("183k");
        expect(formatTokens(2_300_000)).toBe("2.3M");
        expect(formatTokens(412_000_000)).toBe("412M");
    });

    test("boundaries land on the tier above, never below", () => {
        expect(formatTokens(999)).toBe("999");
        expect(formatTokens(1_000)).toBe("1.0k");
        expect(formatTokens(10_000)).toBe("10k");
        expect(formatTokens(1_000_000)).toBe("1.0M");
        expect(formatTokens(10_000_000)).toBe("10M");
    });

    test("a tier carries instead of rendering 1000 of the unit below", () => {
        // Rounding used to push these to "1000k" / "1000M" — a number that
        // reads as the wrong magnitude and is a character wider than the
        // column it sits in.
        expect(formatTokens(999_600)).toBe("1.0M");
        expect(formatTokens(999_900_000)).toBe("1.0B");
    });

    test("never wider than four characters, so a status line cannot shift", () => {
        for (const n of [0, 999, 1_000, 999_999, 9_900_000, 999_999_999, 1_000_000_000, 999_000_000_000, 999_600_000_000, 999_000_000_000_000]) {
            expect(formatTokens(n).length).toBeLessThanOrEqual(4);
        }
    });

    test("junk in never renders as junk out", () => {
        expect(formatTokens(-5)).toBe("0");
        expect(formatTokens(Number.NaN)).toBe("0");
        expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
    });
});
