import { afterEach, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import {
    builtinThemes,
    setSystemScheme,
    systemCanvasHex,
    systemTheme,
    DAY_PALETTE,
    DAY_THEME,
    NIGHT_PALETTE,
    NIGHT_THEME,
} from "../src/interactive/ui/themes";
import { contrastRatio } from "../src/interactive/ui/palette";
import { nextToolDetail, setToolDetail } from "../src/interactive/ui/tool-detail";
import {
    resumeSystemSchemeProbesForTest,
    stopSystemSchemeProbes,
    probeSystemScheme,
    resolveScheme,
    syncSystemScheme,
} from "../src/interactive/ui/system-scheme";
import { initTheme, Theme, theme } from "../src/interactive/ui/theme";
import { applyCanvasWash, resetCanvasWash } from "../src/interactive/ui/canvas-wash";
import { AssistantMessageComponent, UserMessageComponent } from "../src/interactive/ui/messages";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { setAnimTickForTest } from "../src/interactive/ui/anim";

afterEach(() => {
    initTheme("night");
    setSystemScheme("dark"); // module state — a light probe must not leak
});

const noirOn = () => initTheme("night");

/** Finished calls fold into a run; tests about ROWS open it first. */
const openLastRun = (h: ChatHistory): void => {
    h.selectLast();
    h.setSelectedExpanded(true);
    h.clearSelection();
};

/** The `system` theme, at the scheme the terminal is pretending to be. */
const noirSystem = (scheme: "dark" | "light" = "dark", canvas?: string) => {
    setSystemScheme(scheme, canvas);
    initTheme("system");
};

/** A TUI stub that answers the two probes however the test wants. */
const fakeTui = (answers: { scheme?: "dark" | "light"; bg?: { r: number; g: number; b: number } }) =>
    ({
        queryTerminalColorScheme: async () => answers.scheme,
        queryTerminalBackgroundColor: async () => answers.bg,
        setTerminalColorSchemeNotifications() {},
        onTerminalColorSchemeChange: () => () => {},
        invalidate() {},
        requestRender() {},
    }) as unknown as TUI;

/**
 * A stub that behaves like a REAL terminal on the one point that mattered:
 * the reply to a colour-scheme query is itself a colour-scheme report, so it
 * reaches every listener — including ours.
 */
const echoingTui = (bg?: { r: number; g: number; b: number }) => {
    const counts = { scheme: 0, background: 0 };
    const listeners: Array<(s: "dark" | "light") => void> = [];
    const tui = {
        queryTerminalColorScheme: async () => {
            counts.scheme++;
            for (const l of [...listeners]) l("light"); // the reply, as a report
            return "light" as const;
        },
        queryTerminalBackgroundColor: async () => {
            counts.background++;
            return bg;
        },
        setTerminalColorSchemeNotifications() {},
        onTerminalColorSchemeChange: (l: (s: "dark" | "light") => void) => {
            listeners.push(l);
            return () => {};
        },
        invalidate() {},
        requestRender() {},
    };
    return { tui: tui as unknown as TUI, counts, flip: (s: "dark" | "light") => listeners.forEach((l) => l(s)) };
};

const tui = { requestRender() {} } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const W = 80;

/** The truecolor SGR the active theme emits for a slot — so colour assertions
 * say "this element uses the warning slot", not "warning is #e5c07b", and
 * survive a repaint of the palette. */
const sgr = (slot: Parameters<typeof theme.fg>[0]) => {
    const hex = theme.raw(slot) as string;
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `\x1b[38;2;${rgb.join(";")}m`;
};

describe("noir mode themes", () => {
    test("night theme resolves the wash color", () => {
        const t = new Theme(NIGHT_THEME);
        expect(t.raw("bgBase")).toBe("#141414");
        expect(t.raw("bgRaised")).toBe("#242424");
    });

    test("initTheme finds night via the active mode's theme set", () => {
        noirOn();
        expect(theme.raw("bgBase")).toBe("#141414");
    });

    test("an unknown theme name falls back to night rather than failing", () => {
        initTheme("no-such-theme");
        expect(theme.name).toBe("night");
    });
});

describe("noir mode rendering", () => {
    test("user message gets the ❯ prefix", () => {
        noirOn();
        const text = new UserMessageComponent("hello").render(W).map(strip).join("\n");
        expect(text).toContain("❯ hello");
    });

    test("thinking streams a 3-line tail with the gutter", () => {
        noirOn();
        const c = new AssistantMessageComponent({
            content: [{ type: "thinking", thinking: "l1\nl2\nl3\nl4\nl5" }],
            stopReason: "stop",
        });
        const lines = c.render(W).map(strip);
        // The rail now runs the full block, header included — the tail is the
        // railed lines that aren't the header.
        const body = lines.filter((l) => l.includes("▎") && !l.includes("Thinking…"));
        expect(body).toHaveLength(3);
        expect(body[0]).toContain("l3");
        expect(body[2]).toContain("l5");
        expect(lines.join("\n")).toContain("Thinking…");
    });

    test("thinking collapses to a Thought-for row once done, reopens on expand", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.appendAssistantThinking("secret reasoning here", "p", "m");
        h.finishAssistant();
        const collapsed = h.render(W).map(strip).join("\n");
        expect(collapsed).toMatch(/◆ Thought for \d/);
        expect(collapsed).not.toContain("secret reasoning here");
        h.setToolsExpanded(true);
        const expanded = h.render(W).map(strip).join("\n");
        expect(expanded).toContain("secret reasoning here");
    });

    test("individual selection expands one thinking block only", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.appendAssistantThinking("first thought", "p", "m");
        h.appendAssistantDelta("interlude", "p", "m");
        h.appendAssistantThinking("second thought", "p", "m");
        h.finishAssistant();
        // select last foldable (second thinking), expand just it
        expect(h.moveSelection(-1)).toBe(true);
        expect(h.toggleSelected()).toBe(true);
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("second thought");
        expect(text).not.toContain("first thought");
        // selection bar present; esc clears it
        expect(h.render(W).join("\n")).toContain("▌");
        expect(h.clearSelection()).toBe(true);
        expect(h.clearSelection()).toBe(false);
    });

    test("individual selection expands one tool call only", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        // Long enough that the folded peek cannot show all of it — otherwise
        // "expanded" and "folded" look the same and the test proves nothing.
        const five = (tag: string) => Array.from({ length: 5 }, (_, i) => `${tag}-${i + 1}`).join("\n");
        h.addToolCall("bash", "c1", { command: "echo one" });
        h.addToolResult("c1", five("OUT-ONE"));
        h.addToolCall("bash", "c2", { command: "echo two" });
        h.addToolResult("c2", five("OUT-TWO"));
        // Finished calls fold into their run first, so opening one is two
        // steps: open the run, then open the call inside it.
        openLastRun(h);
        h.selectLast(); // c2
        h.moveSelection(-1); // c1
        h.toggleSelected();
        const text = h.render(W).map(strip).join("\n");
        // the opened call shows its whole output
        expect(text).toContain("OUT-ONE-1");
        expect(text).toContain("OUT-ONE-5");
        // the folded one shows only its peek — bash's tail — and says so
        expect(text).not.toContain("OUT-TWO-1");
        expect(text).toContain("OUT-TWO-5");
        expect(text).toContain("… +2 lines");
    });

    test("noir tool row is flat: one muted line folded, gutter output expanded", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "seq 10" }, tui, "/repo");
        const ten = Array.from({ length: 10 }, (_, i) => String(i + 1)).join("\n");
        c.updateResult({ content: [{ type: "text", text: ten }], isError: false }, false);
        const folded = c.render(W).map(strip);
        // lead blank (groupLead) + row + receipt + a 3-line peek + its hint
        expect(folded).toHaveLength(7);
        expect(folded[0]).toBe("");
        expect(folded[1]).toContain("◆ bash seq 10");
        expect(folded[2]).toContain("└ ok · 10 lines");
        // a command's peek is its TAIL — the verdict, not the preamble
        expect(folded.slice(3, 6).map((l) => l.replace(/^▎\s*/, ""))).toEqual(["8", "9", "10"]);
        expect(folded[6]).toContain("… +7 lines");
        expect(folded.join("\n")).not.toContain("1\n");
        c.setExpanded(true);
        const open = c.render(W).map(strip).join("\n");
        // expanded: the whole output, at the gutter rather than indented
        expect(open).toContain("▎  1");
        expect(open).toContain("▎  10");
        expect(open).not.toContain("… +7 lines");
    });

    test("tool groups: lead gap after text, tight rows inside the group", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.appendAssistantDelta("Some intro text.", "p", "m");
        h.addToolCall("bash", "g1", { command: "echo a" });
        h.addToolResult("g1", "a");
        h.addToolCall("bash", "g2", { command: "echo b" });
        h.addToolResult("g2", "b");
        openLastRun(h);
        const plain = h.render(W).map(strip);
        const t1 = plain.findIndex((l) => l.includes("◆ bash echo a"));
        const t2 = plain.findIndex((l) => l.includes("◆ bash echo b"));
        // The open run's header sits directly above its first row, with one
        // blank line between the text and the header — the block opens once.
        expect(plain[t1 - 1]).toContain("Ran 2 commands");
        expect(plain[t1 - 2].trim()).toBe("");
        // consecutive tool rows stay adjacent — each call is its row, its
        // receipt and its peek, and no blank opens up between the two calls
        expect(t2).toBe(t1 + 3);
        expect(plain[t1 + 1]).toContain("└ ok · 1 line");
        expect(plain[t1 + 2]).toContain("a");
    });

    test("a failed row shows its error folded — the tail, where errors end", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "false" }, tui, "/repo");
        const trace = ["running suite", "at frame 1", "at frame 2", "boom: it failed"].join("\n");
        c.updateResult({ content: [{ type: "text", text: trace }], isError: true }, false);
        const folded = c.render(W).map(strip).join("\n");
        // the whole point: a red diamond with no text anywhere is the bug
        expect(folded).toContain("failed · 4 lines");
        expect(folded).toContain("boom: it failed");
        // an error peeks its END, so the preamble is what gets left behind
        expect(folded).not.toContain("running suite");
        expect(folded).toContain("… +1 line");
        c.setExpanded(true);
        expect(c.render(W).map(strip).join("\n")).toContain("running suite");
    });

    test("tool diamond carries the state color: done green, failed red", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "x" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        expect(c.render(W).join("\n")).toContain(`${sgr("success")}◆`);
        const f = new ToolExecutionComponent("bash", { command: "x" }, tui, "/repo");
        f.updateResult({ content: [{ type: "text", text: "no" }], isError: true }, false);
        expect(f.render(W).join("\n")).toContain(`${sgr("toolError")}◆`);
    });

    test("a running tool's diamond and rail ride the animation wave", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "x" }, tui, "/repo");
        // Running rows are painted from a computed blend, not a fixed slot, so
        // the bullet can pulse in step with its rail.
        const at = (t: number): string => {
            setAnimTickForTest(t);
            return c.render(W).join("\n");
        };
        // A quarter-cycle of the wave is the brightest→dimmest swing; the two
        // frames must not paint identically or nothing is actually animating.
        expect(at(0)).not.toBe(at(Math.round(Math.PI / 2 / (0.15 * 1.5))));
        expect(at(0)).toContain("◆");
        expect(at(0)).toContain("▎");
        setAnimTickForTest(0);
    });

    test("user turns and responses are selectable; alt jumps between turns", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("first question");
        h.appendAssistantDelta("first answer", "p", "m");
        h.finishAssistant();
        h.addUser("second question");
        h.appendAssistantDelta("second answer", "p", "m");
        h.finishAssistant();
        // Selection renders as a left accent bar on every line of the entry
        // (constant height/width — a border box made the layout shift).
        const markerNear = (needle: string): boolean => {
            const plain = h.render(W).map(strip);
            const at = plain.findIndex((l) => l.includes(needle));
            return at >= 0 && plain[at].trimStart().startsWith("▌");
        };
        // jumpTurn from nothing lands on the latest user turn
        expect(h.jumpTurn(-1)).toBe(true);
        expect(markerNear("second question")).toBe(true);
        // jump again → first user turn
        expect(h.jumpTurn(-1)).toBe(true);
        expect(markerNear("first question")).toBe(true);
        expect(markerNear("second question")).toBe(false);
        // no earlier turn to jump to
        expect(h.jumpTurn(-1)).toBe(false);
    });

    test("responses are selectable but never fold", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("go");
        h.appendAssistantDelta("l1\nl2\nl3\nl4\nl5\nl6", "p", "m");
        h.finishAssistant();
        h.moveSelection(-1); // response is the latest entry
        expect(h.toggleSelected()).toBe(true); // consumed, but a no-op
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("l1");
        expect(text).toContain("l6");
        expect(h.setSelectedExpanded(false)).toBe(true); // also a no-op
        expect(h.render(W).map(strip).join("\n")).toContain("l6");
    });

    test("REGRESSION: a streaming turn must not ask to move the page", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        for (let i = 0; i < 15; i++) {
            h.addToolCall("bash", `c${i}`, { command: `echo ${i}` });
            h.addToolResult(`c${i}`, String(i));
        }
        h.selectLast();
        expect(h.takeRevealRequest()).toBe(true); // the selection moved
        // A turn streams in: growing response text and more entries below.
        // None of it is a user action, so the page stays where the reader
        // left it.
        for (let i = 0; i < 30; i++) h.appendAssistantDelta(`stream line ${i}\n`, "p", "m");
        h.render(W);
        expect(h.takeRevealRequest()).toBe(false);
        // Moving the selection asks again — one reveal per action.
        h.moveSelection(1);
        expect(h.takeRevealRequest()).toBe(true);
    });

    test("a long user message folds the same way", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("q1\nq2\nq3\nq4\nq5\nq6");
        h.jumpTurn(-1);
        h.toggleSelected();
        const folded = h.render(W).map(strip).join("\n");
        expect(folded).not.toContain("q6");
        expect(folded).toMatch(/\+\d+ lines/);
        h.toggleSelected();
        expect(h.render(W).map(strip).join("\n")).toContain("q6");
    });

    test("selection renders as a stable left bar — no height/width change", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "c1", { command: "echo hi" });
        h.addToolResult("c1", "hi");
        const unselectedHeight = h.render(W).length;
        h.selectLast();
        const lines = h.render(W);
        // selecting must not shift the layout
        expect(lines.length).toBe(unselectedHeight);
        const plain = lines.map(strip);
        const row = plain.findIndex((l) => l.includes("Ran 1 command"));
        expect(row).toBeGreaterThan(-1);
        expect(plain[row].trimStart().startsWith("▌")).toBe(true);
        h.clearSelection();
        expect(h.render(W).length).toBe(unselectedHeight);
    });

    test("scrollback-focus primitives: selectLast, left/right fold, y-copy text", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("do it");
        h.addToolCall("bash", "c1", { command: "seq 2" });
        h.addToolResult("c1", "1\n2");
        expect(h.getSelectedText()).toBeNull();
        expect(h.selectLast()).toBe(true);
        expect(h.hasSelection()).toBe(true);
        // Two-level, grok-style: → opens the run first, then the call.
        expect(h.setSelectedExpanded(true)).toBe(true);
        expect(h.setSelectedExpanded(true)).toBe(true);
        // The selection spine and the rail share column 0 — a selected entry
        // wears "▌" where its rail would be, so nothing shifts sideways.
        expect(h.render(W).map(strip).join("\n")).toContain("▌  1");
        expect(h.setSelectedExpanded(false)).toBe(true);
        expect(h.render(W).map(strip).join("\n")).not.toContain("▎ 1");
        // y copies the call + output
        expect(h.getSelectedText()).toBe("bash seq 2\n1\n2");
        // user entry copy
        h.jumpTurn(-1);
        expect(h.getSelectedText()).toBe("do it");
    });

    test("timestamps: user box and finished response carry h:MM AM/PM", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("hello", new Date(2026, 6, 9, 21, 10).getTime());
        h.appendAssistantDelta("world", "p", "m");
        h.finishAssistant();
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("9:10 PM");
        // response line ends with a right-aligned time (component-created, so
        // just assert the format is present on the response line too)
        const respLine = h
            .render(W)
            .map(strip)
            .find((l) => l.includes("world"));
        expect(respLine).toMatch(/\d{1,2}:\d{2} [AP]M\s*$/);
    });

    test("click selects the entry that owns the clicked line", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("question");
        for (let i = 0; i < 6; i++) {
            h.addToolCall("bash", `c${i}`, { command: `echo ${i}` });
            h.addToolResult(`c${i}`, String(i));
        }
        openLastRun(h);
        const plain = h.render(W).map(strip);
        const rowOf = (needle: string) => plain.findIndex((l) => l.includes(needle));
        expect(h.clickAtLocalLine(rowOf("echo 3"))).toBe(true);
        expect(h.getSelectedText()).toBe("bash echo 3\n3");
        // A click lands on the whole entry, its receipt and peek included, not
        // only on the header row.
        expect(h.clickAtLocalLine(rowOf("echo 3") + 1)).toBe(true);
        expect(h.getSelectedText()).toBe("bash echo 3\n3");
        // spacer/gap lines miss cleanly
        expect(h.clickAtLocalLine(0)).toBe(false);
        // so does a line past the end of the transcript
        expect(h.clickAtLocalLine(plain.length + 10)).toBe(false);
    });

    test("a long stretch of commands is one row once they finish", () => {
        // Every finished call folds into its run, so forty commands are one
        // header, not forty rows.
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("run them all");
        for (let i = 0; i < 20; i++) {
            h.addToolCall("bash", `c${i}`, { command: `echo ${i}` });
            h.addToolResult(`c${i}`, String(i));
        }
        const out = h.render(W).map(strip).join("\n");
        expect(out).toContain("◈ Ran 20 commands");
        expect(out).not.toContain("echo 0");
    });

    test("noir spacing invariant: single blank between blocks, never double", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addUser("do the thing");
        h.appendAssistantThinking("plan it", "p", "m");
        h.appendAssistantDelta("Intro text.", "p", "m");
        h.addToolCall("bash", "c1", { command: "echo a" });
        h.addToolResult("c1", "a");
        h.addToolCall("bash", "c2", { command: "echo b" });
        h.addToolResult("c2", "b");
        h.appendAssistantDelta("Outro text.", "p", "m");
        h.finishAssistant();
        h.addTurnSummary(3);
        const plain = h.render(W).map((l) => strip(l).trim());
        // no two consecutive TRULY blank lines after the user box (the box's
        // bg-painted padding rows strip to blank but render colored)
        const afterBox = plain.findIndex((l) => l.includes("◆ Thought"));
        for (let i = afterBox + 1; i < plain.length; i++) {
            expect(`${i}:${plain[i - 1]}|${plain[i]}`).not.toBe(`${i}:|`);
        }
        // exactly one blank between the thought row and the text block
        const thought = plain.findIndex((l) => l.includes("◆ Thought"));
        const intro = plain.findIndex((l) => l.includes("Intro text."));
        expect(intro - thought).toBe(2);
        // The two finished calls fold into one header row, with a single
        // blank before the block.
        const g = plain.findIndex((l) => l.includes("Ran 2 commands"));
        expect(g).toBeGreaterThan(-1);
        expect(plain[g - 1]).toBe("");
    });

    test("replay renders a step's text before its subagent boxes (live order)", async () => {
        noirOn();
        const { renderSessionBranch } = await import("../src/interactive/replay");
        const entries = [
            { type: "message", role: "user", content: "explore it", ts: 1, id: "u1", parentId: null },
            // subagent finished (persisted) BEFORE the step's assistant message
            {
                type: "subagent",
                ts: 2,
                agent: "explore",
                prompt: "look around",
                result: "found things",
                id: "s1",
                parentId: "u1",
            },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Fanning out subagents." }],
                ts: 3,
                id: "a1",
                parentId: "s1",
            },
        ];
        const fakeSession = {
            getBranch: () => entries,
        } as unknown as import("@notshekhar/loop-core").Session;
        const h = new ChatHistory(tui, "/repo");
        renderSessionBranch(fakeSession, h, "xai/grok-4.5");
        const plain = h.render(W).map(strip);
        const text = plain.findIndex((l) => l.includes("Fanning out subagents."));
        // The finished subagent folds into its verb group, so the row to find
        // is the group header rather than the call's own.
        const task = plain.findIndex((l) => l.includes("Ran 1 subagent"));
        expect(text).toBeGreaterThan(-1);
        expect(task).toBeGreaterThan(text); // text first, task boxes after — like live
    });

    test("replay keeps parallel subagents persisted in the same millisecond as separate boxes", async () => {
        noirOn();
        const { renderSessionBranch } = await import("../src/interactive/replay");
        // Two fan-out runs that finished in the same ms share a replay id
        // (ts-keyed). That's safe today only because each box's result is
        // resolved before the next call registers — this pins that invariant.
        const sub = (id: string, agent: string, result: string, parentId: string) => ({
            type: "subagent",
            ts: 2,
            agent,
            prompt: `${agent} it`,
            result,
            id,
            parentId,
        });
        const entries = [
            { type: "message", role: "user", content: "explore it", ts: 1, id: "u1", parentId: null },
            sub("s1", "explore", "found alpha", "u1"),
            sub("s2", "review", "found beta", "s1"),
            {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Done." }],
                ts: 3,
                id: "a1",
                parentId: "s2",
            },
        ];
        const fakeSession = {
            getBranch: () => entries,
        } as unknown as import("@notshekhar/loop-core").Session;
        const h = new ChatHistory(tui, "/repo");
        renderSessionBranch(fakeSession, h, "xai/grok-4.5");
        h.toggleToolsExpanded(); // expand so both reports are visible
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("◆ task explore");
        expect(text).toContain("◆ task review");
        expect(text).toContain("found alpha");
        expect(text).toContain("found beta");
    });

    test("aborting a turn freezes pending tools as interrupted", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addToolCall("bash", "c1", { command: "sleep 100" });
        // no result — turn gets aborted
        h.markPendingToolsInterrupted();
        const text = h.render(W).map(strip).join("\n");
        expect(text).toContain("· interrupted");
        // and the finished-tool path is untouched
        const h2 = new ChatHistory(tui, "/repo");
        h2.addToolCall("bash", "c2", { command: "echo hi" });
        h2.addToolResult("c2", "hi");
        h2.markPendingToolsInterrupted();
        expect(h2.render(W).map(strip).join("\n")).not.toContain("interrupted");
    });

    test("day theme carries the higher-contrast palette", () => {
        const t = new Theme(DAY_THEME);
        expect(t.raw("bgBase")).toBe("#eeeeee");
        expect(t.raw("muted")).toBe("#444444");
        // GrokDay's accents are the night hues deepened until they hold on a
        // light canvas — the same blue, several steps darker.
        expect(t.raw("selectionBorder")).toBe("#2f64d2");
    });

    test("both plan surfaces keep the default box look in noir mode (approval surfaces)", () => {
        noirOn();
        // exit_plan_mode carries the same deliverable as plan — a document the
        // user reads before approving — so it must render the same way.
        for (const name of ["plan", "exit_plan_mode"]) {
            const plan = new ToolExecutionComponent(name, { plan: "# P" }, tui, "/repo");
            plan.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
            // default renderer = multi-line box with bg padding
            expect(plan.render(W).length).toBeGreaterThan(2);
        }
    });

    test("subagent renders as a noir row: live status+tail, stats title, expanded log", () => {
        noirOn();
        const c = new ToolExecutionComponent("task", { agent: "explore", prompt: "find the auth code" }, tui, "/repo");
        // live: status in the title, activity tail under the gutter
        c.updateStatus("read src/auth.ts · step 3 · 12s");
        c.updateResult(
            { content: [{ type: "text", text: "> ls .\n> read src/auth.ts\nfound it" }], isError: false },
            true,
        );
        const live = c.render(W).map(strip);
        expect(live[0]).toBe(""); // lead blank (groupLead)
        expect(live[1]).toContain("◆ task explore");
        expect(live[1]).toContain("read src/auth.ts · step 3 · 12s");
        expect(live[1]).toContain("find the auth code");
        // last-3 tail under the gutter while running
        expect(live.filter((l) => l.includes("▎") && !l.includes("◆"))).toHaveLength(3);
        // done: stats in the title, log hidden until expanded
        c.setTaskStats({ steps: 3, durationMs: 41000, usd: 0.043 });
        c.updateResult(
            { content: [{ type: "text", text: "> ls .\n> read src/auth.ts\nreport line" }], isError: false },
            false,
        );
        const folded = c.render(W).map(strip);
        // lead blank + row + receipt + the 3-line log tail (nothing hidden)
        expect(folded).toHaveLength(6);
        // the run's outcome moves to the receipt; the header keeps the agent
        // and the prompt, which is what a scan of the transcript is looking for
        expect(folded[1]).toContain("◆ task explore");
        expect(folded[1]).toContain("find the auth code");
        expect(folded[1]).not.toContain("done · 3 steps");
        expect(folded[2]).toContain("└ done · 3 steps · 41s · $0.0430");
        expect(folded[5]).toContain("report line");
        c.setExpanded(true);
        const open = c.render(W).map(strip).join("\n");
        expect(open).toContain("▎  > ls .");
        expect(open).toContain("▎  report line");
    });

    test("tool title gets the diamond and greys out when folded-done", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "ls" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        const raw = c.render(W).join("\n");
        expect(strip(raw)).toContain("◆ bash");
        // the muted slot, not the bright toolTitle
        expect(raw).toContain(sgr("muted"));
    });

    test("turn summary line renders through the turnSummary slot", () => {
        noirOn();
        const h = new ChatHistory(tui, "/repo");
        h.addTurnSummary(14.2);
        expect(h.render(W).map(strip).join("\n")).toContain("Turn completed in 14s.");
        h.addTurnSummary(83);
        expect(h.render(W).map(strip).join("\n")).toContain("Turn completed in 1m23s.");
    });

});

describe("canvas wash", () => {
    const fakeOut = () => {
        const writes: string[] = [];
        return { writes, stream: { write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WriteStream };
    };

    test("grok mode washes bg+fg with OSC 11/10 and restores with OSC 111/110", () => {
        noirOn();
        const { writes, stream } = fakeOut();
        applyCanvasWash(stream);
        expect(writes).toEqual(["\x1b]11;#141414\x07", "\x1b]10;#e1e1e1\x07"]);
        resetCanvasWash(stream);
        expect(writes).toEqual(["\x1b]11;#141414\x07", "\x1b]10;#e1e1e1\x07", "\x1b]111\x07", "\x1b]110\x07"]);
    });

    test("a canvas-less theme un-washes a previous wash", () => {
        noirOn();
        const { writes, stream } = fakeOut();
        applyCanvasWash(stream);
        noirSystem("dark"); // `system` has no canvas of its own
        applyCanvasWash(stream); // nothing to wash with now → emits the reset
        expect(writes).toEqual(["\x1b]11;#141414\x07", "\x1b]10;#e1e1e1\x07", "\x1b]111\x07", "\x1b]110\x07"]);
        resetCanvasWash(stream); // already reset → no-op
        expect(writes).toHaveLength(4);
    });
});

describe("noir system theme", () => {
    const fakeOut = () => {
        const writes: string[] = [];
        return { writes, stream: { write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WriteStream };
    };

    test("the built-in set is night, day and system", () => {
        expect(builtinThemes().map((t) => t.name)).toEqual(["night", "day", "system"]);
    });

    test("system carries no canvas but keeps every other surface", () => {
        for (const scheme of ["dark", "light"] as const) {
            setSystemScheme(scheme);
            const t = new Theme(systemTheme());
            expect(t.raw("bgBase")).toBe(""); // nothing to wash the terminal with
            // The tints are still mixed against a canvas, so the surfaces that
            // carry meaning survive — only the full-canvas claim goes.
            for (const slot of ["bgRaised", "selectedBg", "userMessageBg", "toolErrorBg"] as const) {
                expect(t.raw(slot)).toMatch(/^#[0-9a-f]{6}$/);
                expect(t.raw(slot)).not.toBe(systemCanvasHex());
            }
            expect(t.isLight).toBe(scheme === "light");
        }
    });

    test("a reported background rebuilds the ramp to the ratios night holds", () => {
        // The bug this fixes: night's greys dropped ~20% of their contrast when
        // the wash went away on a lighter terminal, and dim (2.9:1 by design)
        // fell to 2.4:1 — the quiet half of the UI went to mush.
        const terminal = "#262626";
        setSystemScheme("dark", terminal);
        const t = new Theme(systemTheme());
        // The ceiling: a lighter canvas cannot reach night's 16.9:1 text even
        // at pure white, so a clamped slot is held to what IS reachable.
        const ceiling = contrastRatio("#ffffff", terminal);
        for (const slot of ["text", "muted", "dim"] as const) {
            const want = Math.min(contrastRatio(NIGHT_PALETTE[slot], NIGHT_PALETTE.bg), ceiling);
            const got = contrastRatio(t.raw(slot) as string, terminal);
            expect(got).toBeGreaterThanOrEqual(want - 0.02); // never quieter than designed
            expect(got).toBeLessThan(want + 0.3); // and no louder — 8-bit rounding only
        }
        // …and the naive reuse it replaces really was worse.
        expect(contrastRatio(NIGHT_PALETTE.dim, terminal)).toBeLessThan(
            contrastRatio(NIGHT_PALETTE.dim, NIGHT_PALETTE.bg) - 0.4,
        );
    });

    test("EVERY slot holds its ratio — hues and syntax, not just the greys", () => {
        // The whole palette sinks together on a background it was not measured
        // against; lifting only the text ramp would leave the accent, the
        // heading, the diff colours and the syntax set behind.
        const nightSlots: Record<string, string> = {
            text: NIGHT_PALETTE.text,
            muted: NIGHT_PALETTE.muted,
            dim: NIGHT_PALETTE.dim,
            accent: NIGHT_PALETTE.accent,
            mdHeading: NIGHT_PALETTE.heading,
            warning: NIGHT_PALETTE.warning,
            error: NIGHT_PALETTE.error,
            success: NIGHT_PALETTE.success,
            mdCode: NIGHT_PALETTE.inlineCode,
            syntaxKeyword: NIGHT_PALETTE.syntax.keyword,
            syntaxString: NIGHT_PALETTE.syntax.string,
            syntaxComment: NIGHT_PALETTE.syntax.comment,
        };
        for (const ground of ["#1e1e1e", "#262626", "#2e2e2e"]) {
            setSystemScheme("dark", ground);
            const colors = systemTheme().colors as Record<string, string>;
            for (const [slot, nightHex] of Object.entries(nightSlots)) {
                const want = Math.min(
                    contrastRatio(nightHex, NIGHT_PALETTE.bg),
                    contrastRatio("#ffffff", ground), // a lighter canvas has a ceiling
                );
                expect(contrastRatio(colors[slot], ground)).toBeGreaterThanOrEqual(want - 0.02);
            }
        }
    });

    test("a darker terminal is left alone — the lift is one-sided", () => {
        // Pure black gives every slot MORE contrast than noir's own canvas.
        // Holding the ratio exactly would mean dimming a screen already right.
        setSystemScheme("dark", "#000000");
        const colors = systemTheme().colors as Record<string, string>;
        expect(colors.dim).toBe(NIGHT_PALETTE.dim);
        expect(colors.accent).toBe(NIGHT_PALETTE.accent);
        expect(colors.text).toBe(NIGHT_PALETTE.text);
    });

    test("the light set solves against a light terminal the same way", () => {
        const terminal = "#eaeaea";
        setSystemScheme("light", terminal);
        const t = new Theme(systemTheme());
        expect(t.isLight).toBe(true);
        const ceiling = contrastRatio("#000000", terminal);
        for (const slot of ["text", "muted", "dim"] as const) {
            const want = Math.min(contrastRatio(DAY_PALETTE[slot], DAY_PALETTE.bg), ceiling);
            const got = contrastRatio(t.raw(slot) as string, terminal);
            expect(got).toBeGreaterThanOrEqual(want - 0.02);
            expect(got).toBeLessThan(want + 0.3);
        }
    });

    test("surfaces lift off the REAL canvas, never below it", () => {
        setSystemScheme("dark", "#2b2b2b");
        const t = new Theme(systemTheme());
        // A user message on a terminal lighter than noir's own canvas must
        // still read as raised — reusing night's #1f1f21 would have sunk it.
        expect(contrastRatio(t.raw("bgRaised") as string, "#2b2b2b")).toBeGreaterThan(1);
        expect(t.raw("bgRaised")).not.toBe(NIGHT_THEME.colors.bgRaised);
        expect(systemCanvasHex()).toBe("#2b2b2b");
    });

    test("a ratio the canvas cannot reach clamps to the pole", () => {
        setSystemScheme("dark", "#808080"); // mid-grey: 16.9:1 is impossible
        const t = new Theme(systemTheme());
        expect(t.raw("text")).toBe("#ffffff");
    });

    test("its ink follows the terminal, and a flip re-resolves it", () => {
        noirSystem("dark");
        expect(theme.name).toBe("system");
        expect(theme.isLight).toBe(false);

        // What a live colour-scheme notification does.
        expect(setSystemScheme("light")).toBe(true);
        initTheme("system");
        expect(theme.isLight).toBe(true);
        expect(setSystemScheme("light")).toBe(false); // no change → no repaint
        expect(setSystemScheme("light", "#ffffff")).toBe(true); // a new canvas is a change
    });

    test("no OSC 11 wash at all, and switching to it un-washes", () => {
        noirOn();
        const { writes, stream } = fakeOut();
        applyCanvasWash(stream);
        expect(writes).toEqual(["\x1b]11;#141414\x07", "\x1b]10;#e1e1e1\x07"]);

        noirSystem();
        applyCanvasWash(stream);
        expect(writes.slice(2)).toEqual(["\x1b]111\x07", "\x1b]110\x07"]);

        const fresh = fakeOut();
        applyCanvasWash(fresh.stream);
        expect(fresh.writes).toEqual([]);
    });

    test("rows keep noir's shape — only the ramp under them moves", () => {
        const row = () => {
            setAnimTickForTest(0);
            const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts" }, tui, "/repo");
            c.updateResult({ content: [{ type: "text", text: "x" }], isError: false }, false);
            return c.render(W).join("\n");
        };
        noirOn();
        const night = row();
        noirSystem("dark");
        const system = row();
        expect(strip(system)).toBe(strip(night)); // same glyphs, same layout
        expect(system).not.toBe(night); // …drawn in the rebuilt ramp
    });

    test("the probe: the measured background outranks the scheme report", async () => {
        // Report says light, and the colour agrees → both are used.
        expect(await syncSystemScheme(fakeTui({ scheme: "light", bg: { r: 234, g: 234, b: 234 } }))).toBe(true);
        expect(new Theme(systemTheme()).isLight).toBe(true);
        expect(systemCanvasHex()).toBe("#eaeaea"); // the ramp is solved against the real thing

        setSystemScheme("dark");
        // No scheme report — a near-white background still reads as light.
        expect(await syncSystemScheme(fakeTui({ bg: { r: 252, g: 252, b: 252 } }))).toBe(true);
        expect(new Theme(systemTheme()).isLight).toBe(true);

        // The macOS case that broke it: the OS appearance is LIGHT (so the
        // scheme report says light) while the terminal itself is dark-themed.
        // The background is what we actually paint on, so it wins — otherwise
        // the light set lands on a dark screen: near-black text, a near-white
        // input bar.
        setSystemScheme("light");
        expect(await syncSystemScheme(fakeTui({ scheme: "light", bg: { r: 30, g: 30, b: 30 } }))).toBe(true);
        expect(new Theme(systemTheme()).isLight).toBe(false);
        expect(systemCanvasHex()).toBe("#1e1e1e");

        // Whether a report with no background is honoured depends on the
        // platform — see the resolveScheme tests below, which pin it on every
        // platform instead of only the one the suite happens to run on.
    });

    test("resolveScheme: the colour decides; the report is a fallback, never on macOS", () => {
        const dark = { r: 30, g: 30, b: 30 };
        const light = { r: 240, g: 240, b: 240 };
        // The background wins over any report, everywhere.
        expect(resolveScheme({ background: dark, reported: "light", platform: "darwin" })).toEqual({
            scheme: "dark",
            canvas: "#1e1e1e",
        });
        expect(resolveScheme({ background: light, platform: "linux" })?.scheme).toBe("light");
        // No colour: elsewhere the report is the best evidence there is...
        expect(resolveScheme({ reported: "light", platform: "linux" })).toEqual({ scheme: "light" });
        // ...but on macOS it is the OS appearance, not the terminal. This is
        // the dark cmux terminal on a light desktop that came up with
        // near-white message boxes: no colour there means a slow reply, and
        // the dark default is legible on any dark screen.
        expect(resolveScheme({ reported: "light", platform: "darwin" })).toBeUndefined();
        // Nothing at all keeps the default.
        expect(resolveScheme({ platform: "linux" })).toBeUndefined();
    });

    test("the terminal is asked ONCE — a report can never provoke another query", async () => {
        // The bug this pins, and the watcher that made it possible: the reply
        // to a scheme query IS a scheme report, so anything that re-measures on
        // every report re-asks forever. It did — 101,022 queries in ten seconds
        // against a terminal that answers, replies batching into chunks the
        // input path could not parse, every OSC 11 reply's trailing BEL landing
        // as ctrl+g, which loop binds to "continue". There is no watcher now.
        const { tui: t, counts, flip } = echoingTui({ r: 29, g: 29, b: 32 });
        noirSystem("dark");
        await syncSystemScheme(t);
        await Promise.resolve();
        // The colour answered, so the weaker question is never asked at all.
        expect(counts.background).toBe(1);
        expect(counts.scheme).toBe(0);

        // Nothing is subscribed, so a report — solicited or not — goes nowhere.
        flip("light");
        flip("dark");
        await Promise.resolve();
        await Promise.resolve();
        expect(counts.background).toBe(1);
        expect(counts.scheme).toBe(0);

        // And a terminal that will not name its colour is asked the report
        // once, and only once.
        const silent = echoingTui(undefined);
        await syncSystemScheme(silent.tui);
        await Promise.resolve();
        expect(silent.counts.background).toBe(1);
        expect(silent.counts.scheme).toBe(1);
    });

    test("no unsolicited-report mode is ever switched on", () => {
        // `?2031h` outlives the process that asked for it, so the theme that
        // no longer needs it must never turn it on.
        let enabled: boolean | undefined;
        const t = {
            queryTerminalColorScheme: async () => undefined,
            queryTerminalBackgroundColor: async () => undefined,
            setTerminalColorSchemeNotifications: (on: boolean) => (enabled = on),
            onTerminalColorSchemeChange: () => () => {},
            invalidate() {},
            requestRender() {},
        } as unknown as TUI;
        noirSystem("dark");
        probeSystemScheme(t);
        expect(enabled).toBeUndefined();
    });

    test("probes are single-flight, and stop once the UI is going away", async () => {
        const { tui: t, counts } = echoingTui({ r: 29, g: 29, b: 32 });
        noirSystem("dark");
        await Promise.all([syncSystemScheme(t), syncSystemScheme(t), syncSystemScheme(t)]);
        expect(counts.background).toBe(1); // two of the three were dropped

        stopSystemSchemeProbes();
        expect(await syncSystemScheme(t)).toBe(false);
        expect(counts.background).toBe(1); // nothing asked on the way out
        resumeSystemSchemeProbesForTest();
    });

    test("a terminal that answers nothing is still legible on any dark canvas", async () => {
        expect(await syncSystemScheme(fakeTui({}))).toBe(false);
        const t = new Theme(systemTheme());
        expect(t.isLight).toBe(false);
        // The point of the safe canvas: the untold background could be as light
        // as #2e2e2e, and dim must still hold night's 2.9:1 there — the exact
        // contrast night's own hex LOSES when it is moved off #141414.
        for (const bg of ["#000000", "#1e1e1e", "#262626", "#2e2e2e"]) {
            expect(contrastRatio(t.raw("dim") as string, bg)).toBeGreaterThanOrEqual(
                contrastRatio(NIGHT_PALETTE.dim, NIGHT_PALETTE.bg) - 0.02,
            );
        }
        // ...which is exactly what night's own hex stops doing once it is
        // moved off its canvas: the same grey loses contrast on a lighter one.
        expect(contrastRatio(NIGHT_PALETTE.dim, "#262626")).toBeLessThan(
            contrastRatio(NIGHT_PALETTE.dim, NIGHT_PALETTE.bg) - 0.5,
        );
    });
});

describe("noir read rows", () => {
    test("the row carries the offset/limit range the summary drops", () => {
        noirOn();
        const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts", offset: 120, limit: 3 }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "x\ny\nz" }], isError: false }, false);
        const row = c.render(W).map(strip).join("\n");
        expect(row).toContain("◆ read src/a.ts:120-122");
    });

    test("a whole-file read has no range suffix", () => {
        noirOn();
        const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "x" }], isError: false }, false);
        expect(c.render(W).map(strip).join("\n")).toContain("◆ read src/a.ts");
        expect(c.render(W).map(strip).join("\n")).not.toContain(":");
    });

    test("expanded output is numbered from the offset", () => {
        noirOn();
        const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts", offset: 9, limit: 2 }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "const x = 1;\nexport default x;" }], isError: false }, false);
        c.setExpanded(true);
        const open = c.render(W).map(strip).join("\n");
        expect(open).toContain("▎   9  const x = 1;");
        expect(open).toContain("▎  10  export default x;");
    });

    test("other tools' output is never numbered", () => {
        noirOn();
        const c = new ToolExecutionComponent("bash", { command: "seq 2" }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "1\n2" }], isError: false }, false);
        c.setExpanded(true);
        const open = c.render(W).map(strip).join("\n");
        expect(open).toContain("▎  1");
        expect(open).not.toContain("▎  1  1");
    });
});

describe("tool detail density", () => {
    afterEach(() => setToolDetail("normal"));

    const bashRow = () => {
        const c = new ToolExecutionComponent("bash", { command: "seq 10" }, tui, "/repo");
        const ten = Array.from({ length: 10 }, (_, i) => String(i + 1)).join("\n");
        c.updateResult({ content: [{ type: "text", text: ten }], isError: false }, false);
        return c;
    };

    test("compact takes the receipt and the peek away", () => {
        noirOn();
        setToolDetail("compact");
        const out = bashRow().render(W).map(strip);
        // lead blank + the call row, and nothing else — today's one-line noir
        expect(out).toHaveLength(2);
        expect(out[1]).toContain("◆ bash seq 10");
        expect(out.join("\n")).not.toContain("ok · 10 lines");
    });

    test("normal is the mode's own look", () => {
        noirOn();
        setToolDetail("normal");
        const out = bashRow().render(W).map(strip).join("\n");
        expect(out).toContain("└ ok · 10 lines");
        expect(out).toContain("… +7 lines");
    });

    test("the cycle wraps compact → normal → full → compact", () => {
        setToolDetail("compact");
        expect(nextToolDetail()).toBe("normal");
        setToolDetail("normal");
        expect(nextToolDetail()).toBe("full");
        setToolDetail("full");
        expect(nextToolDetail()).toBe("compact");
    });

    test("setToolDetail reports whether it changed, so callers can skip a repaint", () => {
        setToolDetail("normal");
        expect(setToolDetail("normal")).toBe(false);
        expect(setToolDetail("compact")).toBe(true);
    });
});
