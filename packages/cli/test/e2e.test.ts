import { describe, expect, test } from "bun:test";

/**
 * The screen tests, hung off `bun test` so they are not a thing you have to
 * remember exists.
 *
 * They are opt-in (`LOOP_E2E=1 bun test`) for one honest reason: each scenario
 * boots a real loop in a real pty and waits on real timings, so the suite costs
 * minutes where the rest of the tests cost seconds. Run them when the renderer
 * changes — they are the only tests that can see the bugs it actually has,
 * because those bugs are all correct frames drawn in the wrong place.
 *
 * `bun packages/cli/test/e2e/run.ts [scenario ...]` runs them directly, and
 * prints the screen when something fails.
 */
const enabled = process.env.LOOP_E2E === "1";

describe.skipIf(!enabled)("TUI end-to-end screens", () => {
    test(
        "every scenario passes",
        async () => {
            const proc = Bun.spawn(["bun", `${import.meta.dir}/e2e/run.ts`], {
                stdout: "pipe",
                stderr: "pipe",
                cwd: `${import.meta.dir}/../../..`,
            });
            const [out, err, code] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);
            if (code !== 0) {
                // The scenario output IS the failure report: it prints the
                // screen rows that differed.
                console.log(out);
                console.log(err);
            }
            expect(code).toBe(0);
        },
        15 * 60 * 1000,
    );
});
