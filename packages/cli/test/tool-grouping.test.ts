import { afterEach, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";
import { truncateToWidth, visibleWidth } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { initTheme, theme } from "../src/interactive/ui/theme";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { highlightToolSummary } from "../src/interactive/ui/tool-summary";

afterEach(() => {
    initTheme("night");
});

/** The transcript's one look — the tests below were written when it was
 * reachable only through the `live` variant, hence the name. */
const liveOn = () => initTheme("night");

/** Open the run the selection is on (→ once opens the group, not a call). */
const openRun = (h: ChatHistory): void => {
    h.selectLast();
    h.setSelectedExpanded(true);
    h.clearSelection();
};

const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const W = 70;

/** A history with `n` finished read calls in a row. */
function withReads(n: number, tool = "read"): ChatHistory {
    const h = new ChatHistory(tui, "/repo");
    for (let i = 0; i < n; i++) {
        h.addToolCall(tool, `c${i}`, { path: `/repo/f${i}.ts` });
        h.addToolResult(`c${i}`, "body");
    }
    return h;
}

const text = (h: ChatHistory) => h.render(W).map(strip).join("\n");

/** The truecolor SGR the active theme emits for a slot — so a colour assertion
 * says "this uses the error slot" rather than naming a hex. */
const sgr = (slot: Parameters<typeof theme.fg>[0]) => {
    const hex = theme.raw(slot) as string;
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `\x1b[38;2;${rgb.join(";")}m`;
};

describe("verb groups", () => {
    // A run of finished calls folds into ONE row, and opening it gives the
    // calls back in full under the same header. That is grok's own layout
    // (`state/groups.rs::project_verb_run`: a collapsed header is height 1 and
    // every other member is height 0; an open run keeps the header above the
    // rows it stops hiding), and it is what makes a fold worth having — three
    // calls cost a line, not four.

    test("a run of finished tool rows folds into one header row", () => {
        liveOn();
        const out = text(withReads(3));
        expect(out).toContain("◈ Read 3 files");
        // Nothing of the calls themselves: no row, no path, no output. They
        // are one → away, which is the whole bargain.
        expect(out).not.toContain("◆");
        expect(out).not.toContain("f0.ts");
        expect(out).not.toContain("body");
        expect(out.split("\n").filter((l) => l.trim()).length).toBe(1);
    });

    test("one member is enough to fold", () => {
        // grok folds from the first call (RunScan::folds), so a second one
        // joins an existing header instead of the row collapsing under you.
        liveOn();
        const out = text(withReads(1));
        expect(out).toContain("◈ Read 1 file");
        expect(out).not.toContain("f0.ts");
    });

    test("the label is a sentence about the turn, per kind", () => {
        liveOn();
        expect(text(withReads(3))).toContain("◈ Read 3 files");

        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("ls", "a", { path: "/repo" });
        h.addToolResult("a", "x");
        h.addToolCall("ls", "b", { path: "/repo/src" });
        h.addToolResult("b", "x");
        h.addToolCall("read", "c", { path: "/repo/a.ts" });
        h.addToolResult("c", "x");
        // A bare "3 calls" would say how many and never what.
        expect(text(h)).toContain("◈ Listed 2 dirs, Read 1 file");
    });

    test("a hidden failure is reported on the header", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "a", { path: "/repo/a.ts" });
        h.addToolResult("a", "x");
        h.addToolCall("read", "b", { path: "/repo/gone.ts" });
        h.addToolResult("b", "ENOENT", true);
        // Folding must never be a way to lose bad news.
        const out = text(h);
        expect(out).toContain("· 1 failed");
        expect(h.render(W).join("\n")).toContain(sgr("toolError"));
        expect(out).not.toContain("ENOENT");
    });

    test("the header row fits the terminal, however long the label", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        for (const [i, tool] of ["read", "ls", "grep", "websearch"].entries()) {
            h.addToolCall(tool, `c${i}`, { path: "/repo/some/deep/path.ts", pattern: "x", query: "y" });
            h.addToolResult(`c${i}`, "x");
        }
        for (let width = 24; width <= 90; width++) {
            for (const line of h.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
    });

    test("the selected header says which way the fold goes", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        const closed = text(h);
        expect(closed).toContain("› Read 3 files");
        expect(closed).toContain("(→ to open)");

        h.setSelectedExpanded(true);
        const open = text(h);
        expect(open).toContain("⌄ Read 3 files");
        expect(open).not.toContain("(→ to open)");
    });

    test("opening the run keeps the header and gives the calls back", () => {
        liveOn();
        const h = withReads(3);
        openRun(h);
        const lines = text(h).split("\n");
        const header = lines.findIndex((l) => l.includes("◈ Read 3 files"));
        expect(header).toBeGreaterThan(-1);
        // The rows follow immediately: the header opened the block, so the
        // first call must not open it again with a second blank line.
        expect(lines[header + 1]).toContain("◆ read f0.ts");
        expect(text(h)).toContain("f2.ts");
    });

    test("a member row is a full row again once the run is open", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "a", { command: "git status" });
        h.addToolResult("a", "one\ntwo\nthree");
        h.addToolCall("bash", "b", { command: "true" });
        h.addToolResult("b", "");
        openRun(h);
        const out = text(h);
        // Receipts and peeks are the ROW's, and they come back with it.
        expect(out).toContain("ok · 3 lines");
        expect(out).toContain("ok · no output");
        expect(out).toContain("three");
    });

    test("a non-folding call breaks the run around it", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "a", { path: "/repo/a.ts" });
        h.addToolResult("a", "x");
        // `plan` is the surface that never folds — a document the user reads
        // the rest of the turn against — which makes it what splits a run.
        h.addToolCall("plan", "b", { plan: "# Do it" });
        h.addToolResult("b", "x");
        h.addToolCall("read", "c", { path: "/repo/c.ts" });
        h.addToolResult("c", "x");
        const out = text(h).split("\n").filter(Boolean);
        expect(out.filter((l) => l.includes("◈ Read 1 file"))).toHaveLength(2);
    });

    test("a running call folds live — the header reads in the present tense", () => {
        // grok folds a run while it executes: the header counts calls as they
        // land ("Reading 3 files"), and the transcript holds still instead of
        // growing a row per call and then collapsing them all at once.
        liveOn();
        const h = withReads(2);
        h.addToolCall("read", "live", { path: "/repo/slow.ts" }); // no result → running
        const out = text(h);
        expect(out).toContain("Reading 3 files");
        expect(out).not.toContain("slow.ts");
    });

    test("a call joins the group in front of it the moment it finishes", () => {
        liveOn();
        const h = withReads(2);
        h.addToolCall("read", "live", { path: "/repo/slow.ts" });
        h.addToolResult("live", "body");
        const out = text(h);
        expect(out).toContain("◈ Read 3 files");
        // it joins the fold: no longer a row of its own
        expect(out).not.toContain("slow.ts");
        expect(out).not.toContain("◆ read");
    });

    test("a running action stays a row between two runs", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("read", "done", { path: "/repo/a.ts" });
        h.addToolResult("done", "x");
        h.addToolCall("bash", "live", { command: "bun test" }); // running
        const out = text(h);
        expect(out).toContain("◈ Read 1 file");
        expect(out).toContain("◆ bash bun test");
    });
});

describe("live hierarchical navigation", () => {
    test("selection lands on the group header, not on a row that isn't drawn", () => {
        liveOn();
        const h = withReads(3);
        expect(h.selectLast()).toBe(true);
        expect(text(h)).toContain("› Read 3 files");
    });

    test("→ opens the group first, then the call's output", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();

        h.setSelectedExpanded(true); // level 1: the group
        const opened = text(h);
        expect(opened).toContain("⌄ Read 3 files"); // the header stays
        expect(opened).toContain("f0.ts");
        expect(opened).toContain("f2.ts");
        expect(opened).not.toContain("body"); // contents still folded

        h.setSelectedExpanded(true); // level 2: the selected call
        expect(text(h)).toContain("body");
    });

    test("opening a member does not re-collapse its siblings", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        h.setSelectedExpanded(true); // open the run
        h.moveSelection(1); // f1
        h.setSelectedExpanded(true); // open f1's output
        // An opened member is transparent: it keeps its rows without
        // splitting the run, so its siblings stay shown under the header.
        const out = text(h);
        expect(out).toContain("Read 2 files");
        expect(out).toContain("f0.ts");
        expect(out).toContain("f2.ts");
        expect(out).toContain("body");
    });

    test("← walks back out: fold the call, then close the group", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        h.setSelectedExpanded(true); // open the run
        h.moveSelection(1); // f1
        h.setSelectedExpanded(true); // open f1
        expect(text(h)).toContain("body");

        h.setSelectedExpanded(false);
        expect(text(h)).not.toContain("body"); // call folded, group still open
        expect(text(h)).toContain("f1.ts");

        h.setSelectedExpanded(false);
        // Closed, with the selection moved to the header that now stands for
        // what just disappeared.
        expect(text(h)).toContain("› Read 3 files");
        expect(text(h)).not.toContain("f1.ts");
    });

    test("Enter opens a closed group — same first step as →", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        expect(h.toggleSelected()).toBe(true);
        expect(text(h)).not.toContain("◈ Read 3 files");
    });

    test("leaving navigation puts every fold back the way it was", () => {
        // Navigating is a visit, not an edit: whatever you opened to read,
        // Esc closes again.
        liveOn();
        const h = withReads(3);
        const before = text(h);
        h.selectLast();
        h.setSelectedExpanded(true); // open the group
        h.moveSelection(1);
        h.setSelectedExpanded(true); // open a call's output
        expect(text(h)).toContain("body");

        h.clearSelection();
        h.resetFolds(); // what Esc does
        expect(text(h)).toBe(before);
    });

    test("expand-all is undone too, and `e` still toggles from closed", () => {
        liveOn();
        const h = withReads(3);
        h.selectLast();
        h.toggleToolsExpanded(); // `e`
        expect(text(h)).toContain("body");

        h.resetFolds();
        expect(text(h)).not.toContain("body");
        expect(h.toggleToolsExpanded()).toBe(true);
    });

    test("moveSelection never stops on an entry hidden in a group", () => {
        liveOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("go");
        for (let i = 0; i < 3; i++) {
            h.addToolCall("read", `c${i}`, { path: `/repo/f${i}.ts` });
            h.addToolResult(`c${i}`, "body");
        }
        h.selectLast(); // group header
        // Walking up from the header reaches the user prompt, never a hidden row.
        expect(h.moveSelection(-1)).toBe(true);
        const out = text(h);
        expect(out).toContain("◈ Read 3 files");
        expect(out).toContain("go");
    });
});
