import { describe, expect, test } from "bun:test";
import { computeFolds, type RunStep } from "../src/interactive/transcript-folds";

/**
 * The run scan is grok-build's (`state/groups.rs`, `verb_group.rs`), kept to
 * what loop uses, so these read as its rules: steps in, one role per entry out.
 */

const member = (opts: { running?: boolean; failed?: boolean } = {}): RunStep => ({
    kind: "member",
    running: opts.running ?? false,
    failed: opts.failed ?? false,
});
const transparent: RunStep = { kind: "transparent" };
const brk: RunStep = { kind: "break" };

const closed = () => false;
const open = () => true;
const roles = (steps: RunStep[], isOpen = closed): string[] => computeFolds(steps, isOpen).roles.map((r) => r.kind);

describe("runs of tool calls", () => {
    test("a run of members folds behind its first entry", () => {
        expect(computeFolds([member(), member(), member()], closed).spans).toEqual([
            { start: 0, end: 3, members: 3, running: false, failed: 0, open: false },
        ]);
        expect(roles([member(), member(), member()])).toEqual(["header", "hidden", "hidden"]);
    });

    test("one member is enough to fold", () => {
        expect(roles([member()])).toEqual(["header"]);
    });

    test("anything that is not a call breaks the run", () => {
        // A prompt, a response, a thought, a system line.
        expect(roles([member(), brk, member()])).toEqual(["header", "self", "header"]);
    });

    test("a transparent call keeps its rows without splitting the run", () => {
        // Opening one call must never dissolve the group around it.
        const { spans } = computeFolds([member(), transparent, member()], closed);
        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({ start: 0, end: 3, members: 2 });
        expect(roles([member(), transparent, member()])).toEqual(["header", "self", "hidden"]);
    });

    test("a transparent call after the last member stays outside the run", () => {
        // An action still running at the end of a turn is its own row.
        expect(computeFolds([member(), transparent], closed).spans[0]).toMatchObject({ start: 0, end: 1 });
        expect(roles([member(), transparent])).toEqual(["header", "self"]);
    });

    test("a transparent call cannot start a run", () => {
        expect(roles([transparent, member()])).toEqual(["self", "header"]);
    });

    test("running members fold too, and say so", () => {
        expect(computeFolds([member(), member({ running: true })], closed).spans[0]).toMatchObject({
            running: true,
            members: 2,
        });
    });

    test("failures are counted on the header", () => {
        const steps = [member({ failed: true }), member(), member({ failed: true })];
        expect(computeFolds(steps, closed).spans[0]).toMatchObject({ failed: 2 });
    });

    test("an open run keeps its header and shows everything under it", () => {
        expect(roles([member(), transparent, member()], open)).toEqual(["header", "self", "self"]);
    });

    test("openness is asked of exactly the run's range", () => {
        const asked: Array<[number, number]> = [];
        computeFolds([brk, member(), member(), brk, member()], (start, end) => {
            asked.push([start, end]);
            return false;
        });
        expect(asked).toEqual([
            [1, 3],
            [4, 5],
        ]);
    });
});
