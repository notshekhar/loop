import { describe, expect, test } from "bun:test";
import { ClipboardImageTip } from "../src/interactive/clipboard-tip";

/** A status line that just records what the tip put on it. */
function surface() {
    const hints: (string | null)[] = [];
    return { hints, setHint: (h: string | null) => hints.push(h) };
}

/** Fake clock + counting probe, so every transition is drivable. */
function harness(signatures: (string | null)[]) {
    let t = 0;
    let calls = 0;
    const tip = new ClipboardImageTip({
        now: () => t,
        probe: () => {
            const s = signatures[Math.min(calls, signatures.length - 1)];
            calls += 1;
            return Promise.resolve(s);
        },
    });
    return {
        tip,
        probeCalls: () => calls,
        advance: (ms: number) => {
            t += ms;
        },
    };
}

/** Let the probe's promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("ClipboardImageTip", () => {
    test("fires once an image is on the board", async () => {
        const { tip } = harness(["«class PNGf», 75"]);
        const s = surface();
        tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        expect(tip.visible).toBe(true);
        expect(s.hints.at(-1)).toContain("Ctrl+V");
    });

    test("ineligible callers never spend a probe", async () => {
        const h = harness(["«class PNGf», 75"]);
        h.tip.check(
            surface(),
            () => false,
            () => {},
        );
        await settle();
        expect(h.probeCalls()).toBe(0);
    });

    test("keystrokes inside the throttle window don't re-probe", async () => {
        const h = harness(["«class PNGf», 75"]);
        const s = surface();
        for (let i = 0; i < 5; i++) {
            h.tip.check(
                s,
                () => true,
                () => {},
            );
            await settle();
            h.advance(100);
        }
        expect(h.probeCalls()).toBe(1);
    });

    test("the same copied image never nags twice", async () => {
        const h = harness(["«class PNGf», 75"]);
        const s = surface();
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        expect(s.hints.filter(Boolean)).toHaveLength(1);
        // Well past both the throttle and the cooldown, same clipboard.
        h.advance(60_000);
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        expect(h.probeCalls()).toBe(2);
        expect(s.hints.filter(Boolean)).toHaveLength(1);
    });

    test("a new image after the cooldown fires again", async () => {
        const h = harness(["«class PNGf», 75", "«class PNGf», 4096"]);
        const s = surface();
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        h.advance(60_000);
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        expect(s.hints.filter(Boolean)).toHaveLength(2);
    });

    test("a new image inside the cooldown is held back", async () => {
        const h = harness(["«class PNGf», 75", "«class PNGf», 4096"]);
        const s = surface();
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        h.advance(2_000); // past the throttle, inside the 30s cooldown
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        expect(s.hints.filter(Boolean)).toHaveLength(1);
    });

    test("the next keystroke takes the hint back down", async () => {
        const h = harness(["«class PNGf», 75"]);
        const s = surface();
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        h.advance(2_000);
        h.tip.onKey(s);
        expect(s.hints.at(-1)).toBeNull();
        expect(h.tip.visible).toBe(false);
    });

    test("keystrokes never probe the pasteboard", () => {
        const h = harness(["«class PNGf», 75"]);
        const s = surface();
        for (let i = 0; i < 20; i++) {
            h.tip.onKey(s);
            h.advance(2_000);
        }
        expect(h.probeCalls()).toBe(0);
        expect(s.hints).toHaveLength(0);
    });

    test("dismiss leaves the status line alone when nothing is showing", () => {
        const { tip } = harness([null]);
        const s = surface();
        tip.dismiss(s);
        expect(s.hints).toHaveLength(0);
    });

    test("a board that stops holding an image re-arms the fire", async () => {
        const h = harness(["«class PNGf», 75", null, "«class PNGf», 75"]);
        const s = surface();
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        h.advance(60_000);
        h.tip.check(
            s,
            () => true,
            () => {},
        ); // probes null — clears the dedup
        await settle();
        h.advance(60_000);
        h.tip.check(
            s,
            () => true,
            () => {},
        );
        await settle();
        expect(s.hints.filter(Boolean)).toHaveLength(2);
    });

    test("eligibility is re-checked after the probe returns", async () => {
        let eligible = true;
        const { tip } = harness(["«class PNGf», 75"]);
        const s = surface();
        tip.check(
            s,
            () => eligible,
            () => {},
        );
        eligible = false; // a selector opened while the probe was in flight
        await settle();
        expect(tip.visible).toBe(false);
        expect(s.hints.filter(Boolean)).toHaveLength(0);
    });
});
