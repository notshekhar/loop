import { describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";
import { CostTracker } from "@notshekhar/loop-core";

process.env.COLORTERM = "truecolor";

import { initTheme } from "../src/interactive/ui/theme";
import { StatusLine } from "../src/interactive/components/status-line";
import { createStatusLineRefresher } from "../src/interactive/status-line-refresh";
import type { AppState } from "../src/interactive/state";

initTheme("night");

/**
 * `loop --session <id>` used to come up with an empty context gauge while
 * `/resume` inside a session filled it in.
 *
 * Nothing was wrong with the seeding: the tokens are restored from the
 * transcript either way. What differed was the DENOMINATOR — the model's
 * context window, which `refreshStatusLineCtx` reads out of the catalog. At
 * boot the merged catalog has not been built yet, so a model that cannot be
 * resolved synchronously (a custom-provider or gateway id) answers `undefined`
 * and the gauge gets a max of zero. The async warm-up landed a moment later
 * and re-applied only the model, never the gauge, so the meter stayed empty
 * until the first turn of the session. `/resume` never showed it because by
 * the time you run it the catalog is long warm.
 *
 * This pins the contract that fixed it: the refresher re-reads the catalog
 * every time it runs, so calling it once the catalog has landed is enough.
 */
describe("the context gauge after the catalog lands", () => {
    const tui = { requestRender() {} } as unknown as TUI;

    /** The status line's own view of the gauge: used, and out of how much. */
    const gauge = (line: StatusLine) => (line as unknown as { ctxUsed: number; ctxMax: number }).ctxMax;

    const stateWith = (modelId: string): AppState =>
        ({ modelId, latestContextTokens: 42_000, session: null }) as unknown as AppState;

    test("an unresolvable model leaves the gauge with no window to measure against", () => {
        const line = new StatusLine();
        const state = stateWith("custom:gateway/not-in-any-catalog");
        const { refreshStatusLine } = createStatusLineRefresher(line, new CostTracker(), tui, state);
        refreshStatusLine();
        expect(gauge(line)).toBe(0);
    });

    test("a model the catalog knows fills it in — the same call, run again", () => {
        const line = new StatusLine();
        // A builtin id resolves synchronously (the generated catalog is
        // compiled in), which is exactly the state the async warm-up puts a
        // custom-provider id into.
        const state = stateWith("anthropic/claude-sonnet-4-5");
        const { refreshStatusLine } = createStatusLineRefresher(line, new CostTracker(), tui, state);
        refreshStatusLine();
        expect(gauge(line)).toBeGreaterThan(0);
    });

    test("startup asks for the WHOLE line, so nothing else drifts from /resume", async () => {
        // The bug was one field of the status line being re-applied on its
        // own. Both doors into a session now call the same refresher, which is
        // the property worth pinning — a future field added to it is restored
        // by both without anybody remembering to.
        const app = await Bun.file(new URL("../src/interactive/app.ts", import.meta.url)).text();
        const warmup = app.slice(app.indexOf("void getCatalog({ refresh: true })"));
        expect(warmup.slice(0, warmup.indexOf("});"))).toContain("refreshStatusLine()");
    });
});
