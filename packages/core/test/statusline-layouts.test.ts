import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusLineContext } from "../src/extensions/api";
import { LAYOUTS, track } from "../src/extensions/builtin/statusline-themes/layouts";
import { SystemSampler } from "../src/extensions/builtin/statusline-themes/system";
import { THEMES } from "../src/extensions/builtin/statusline-themes/themes";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const SYS = { cpu: 0.25, memUsed: 8e9, memTotal: 16e9 };

const BASE: StatusLineContext = {
    agent: "plan",
    modelId: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    model: "claude-opus-4-8",
    sessionId: "s1",
    cwd: "/tmp/project",
    cost: { usd: 0.0042, inputTokens: 3200, outputTokens: 98, cachedInputTokens: 21600 },
    context: { used: 61000, max: 200000 },
    thinking: "high",
    reasoning: true,
    width: 120,
};

const render = (id: string, ctx: StatusLineContext = BASE) => {
    const layout = LAYOUTS.find((l) => l.id === id)!;
    return (layout.render?.(ctx, SYS) ?? []).map(strip);
};

// Layouts that promise to fit the width (the older dashboard ones wrap or clip by design).
const FITTING = [
    "plain",
    "ascii",
    "dot",
    "emoji",
    "path",
    "git",
    "split",
    "session",
    "spark",
    "meter",
    "boxed",
    "rounded",
];

describe("statusline layouts", () => {
    test("picker runs simplest to fanciest, with every id unique", () => {
        const ids = LAYOUTS.map((l) => l.id);
        expect(ids[0]).toBe("native");
        expect(ids[1]).toBe("plain");
        expect(ids.at(-1)).toBe("flex");
        expect(new Set(ids).size).toBe(ids.length);
        expect(LAYOUTS.every(Boolean)).toBe(true);
    });

    for (const id of FITTING) {
        test(`"${id}" stays within the width`, () => {
            for (const width of [60, 120]) {
                for (const row of render(id, { ...BASE, width })) {
                    // Emoji are two columns wide; count them that way.
                    const cols = [...row].reduce((n, ch) => n + (/\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0);
                    expect(cols).toBeLessThanOrEqual(width);
                }
            }
        });
    }

    test("plain carries no color at all", () => {
        const layout = LAYOUTS.find((l) => l.id === "plain")!;
        const [row] = layout.render!(BASE, SYS)!;
        expect(row).toBe("Opus 4.8 high 31%");
    });

    test("split pushes the numbers to the right edge", () => {
        const [row] = render("split");
        expect(row.length).toBe(BASE.width);
        expect(row.trimEnd().endsWith("$0.0042")).toBe(true);
    });

    test("boxed draws a closed box around one row", () => {
        const rows = render("boxed");
        expect(rows).toHaveLength(3);
        expect(rows[0].startsWith("╭") && rows[0].endsWith("╮")).toBe(true);
        expect(rows[2].startsWith("╰") && rows[2].endsWith("╯")).toBe(true);
        expect(rows[0].length).toBe(rows[1].length);
    });

    test("rounded caps both ends", () => {
        const [row] = render("rounded");
        expect(row.startsWith("")).toBe(true);
        expect(row.endsWith("")).toBe(true);
    });

    test("spark draws the context history once it moves", () => {
        const ctx = { ...BASE, sessionId: "spark" };
        for (const used of [10000, 40000, 90000, 160000]) track({ ...ctx, context: { used, max: 200000 } });
        const [row] = render("spark", { ...ctx, context: { used: 160000, max: 200000 } });
        expect(row).toMatch(/[▁▂▃▄▅▆▇█]{4}/);
    });

    test("a new session resets the sparkline", () => {
        track({ ...BASE, sessionId: "a", context: { used: 10000, max: 200000 } });
        track({ ...BASE, sessionId: "a", context: { used: 50000, max: 200000 } });
        track({ ...BASE, sessionId: "b", context: { used: 50000, max: 200000 } });
        const [row] = render("spark", { ...BASE, sessionId: "b" });
        expect(row).not.toMatch(/[▁▂▃▄▅▆▇█]{2}/);
    });

    describe("git", () => {
        let dir = "";
        const setup = (head: string) => {
            dir = mkdtempSync(join(tmpdir(), "statusline-git-"));
            mkdirSync(join(dir, ".git"));
            writeFileSync(join(dir, ".git", "HEAD"), head);
            mkdirSync(join(dir, "sub"));
        };

        test("reads the branch from .git/HEAD, from a subdirectory too", () => {
            setup("ref: refs/heads/feature/x\n");
            try {
                expect(render("git", { ...BASE, cwd: join(dir, "sub") })[0]).toContain("feature/x");
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test("shows a short sha when HEAD is detached", () => {
            setup("0123456789abcdef0123456789abcdef01234567\n");
            try {
                expect(render("git", { ...BASE, cwd: dir })[0]).toContain("0123456");
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});

describe("statusline themes", () => {
    test("every theme id is unique", () => {
        expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    });
});

describe("SystemSampler", () => {
    test("a vitals layout can take over from a clock-only one", () => {
        const sys = new SystemSampler();
        try {
            sys.startClock(() => {});
            sys.start();
            // start() primes memory immediately — it would not have if the clock blocked it.
            expect(sys.get().memUsed).toBeGreaterThan(0);
        } finally {
            sys.stop();
        }
    });
});
