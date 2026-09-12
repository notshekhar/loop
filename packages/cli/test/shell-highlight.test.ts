/**
 * Shell highlighting for a bash row's command, and the width it is allowed.
 *
 * Two complaints, one row. The command was printed as a flat grey run when it
 * is the one thing loop shows that a terminal would have coloured; and it was
 * cut at 80 characters however wide the window was, because the cut happened
 * where nothing knew the width.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { registerNoirMode } from "../src/interactive/ui/noir-mode";
import { setActiveUiMode, setLiveVariant } from "../src/interactive/ui/ui-mode";
import { initTheme, theme } from "../src/interactive/ui/theme";
import { highlightShellCommand } from "../src/interactive/ui/shell-highlight";
import { formatToolArgs, highlightToolSummary } from "../src/interactive/ui/tool-summary";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { ChatHistory } from "../src/interactive/components/chat-history";

beforeAll(() => registerNoirMode());
afterEach(() => {
    setLiveVariant(false);
    setActiveUiMode("loop");
    initTheme("dark");
});

const tui = { requestRender() {}, terminal: { rows: 40, columns: 200 } } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");

/** The truecolor SGR the active theme emits for a slot, so assertions name the
 * slot rather than a hex that a repaint would move. */
const sgr = (slot: Parameters<typeof theme.fg>[0]) => {
    const hex = theme.raw(slot) as string;
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `\x1b[38;2;${rgb.join(";")}m`;
};

/** `slot` is applied to `text` somewhere in `painted`. */
const painted = (out: string, slot: Parameters<typeof theme.fg>[0], text: string) =>
    out.includes(`${sgr(slot)}${text}`);

describe("highlightShellCommand", () => {
    test("colours the program at the head of every pipeline segment", () => {
        initTheme("dark");
        const out = highlightShellCommand("git status | grep -v Merge && echo ok");
        expect(painted(out, "syntaxFunction", "git")).toBe(true);
        expect(painted(out, "syntaxFunction", "grep")).toBe(true);
        expect(painted(out, "syntaxFunction", "echo")).toBe(true);
        // `status` is an argument, not a program — highlighting it would say
        // the row ran two commands.
        expect(painted(out, "syntaxFunction", "status")).toBe(false);
        expect(painted(out, "syntaxOperator", "|")).toBe(true);
        expect(painted(out, "syntaxOperator", "&&")).toBe(true);
    });

    test("quoting, variables and comments each keep their own slot", () => {
        initTheme("dark");
        const out = highlightShellCommand(`grep -r "$HOME/src" --include='*.ts' . # find it`);
        expect(painted(out, "syntaxString", `"$HOME/src"`)).toBe(true);
        expect(painted(out, "syntaxComment", "# find it")).toBe(true);
        expect(painted(out, "dim", "-r")).toBe(true);
    });

    test("a loop header reads as grammar, not as three commands", () => {
        initTheme("dark");
        const out = highlightShellCommand("for f in *.ts; do echo $f; done");
        expect(painted(out, "syntaxKeyword", "for")).toBe(true);
        expect(painted(out, "syntaxKeyword", "in")).toBe(true);
        expect(painted(out, "syntaxKeyword", "do")).toBe(true);
        expect(painted(out, "syntaxKeyword", "done")).toBe(true);
        // The loop's own name binds a variable; it is not the program.
        expect(painted(out, "syntaxVariable", "f")).toBe(true);
        expect(painted(out, "syntaxFunction", "f")).toBe(false);
        expect(painted(out, "syntaxFunction", "echo")).toBe(true);
        expect(painted(out, "syntaxVariable", "$f")).toBe(true);
    });

    test("a keyword used as an argument stays an argument", () => {
        initTheme("dark");
        // The bug this guards: `done` is only the end of a loop at the head of
        // a command. Here it is what echo prints.
        const out = highlightShellCommand("echo done");
        expect(painted(out, "syntaxFunction", "echo")).toBe(true);
        expect(painted(out, "syntaxKeyword", "done")).toBe(false);
    });

    test("an environment prefix is a variable, and the program is the word after it", () => {
        initTheme("dark");
        const out = highlightShellCommand("FOO=bar npm run build");
        expect(painted(out, "syntaxVariable", "FOO=bar")).toBe(true);
        expect(painted(out, "syntaxFunction", "npm")).toBe(true);
    });

    test("quoted and expanded assignment values keep the following command highlighted", () => {
        initTheme("dark");
        for (const cmd of [`FOO="a b" npm test`, "FOO=$HOME/bin npm test", "FOO=$(pwd) npm test"]) {
            const out = highlightShellCommand(cmd);
            expect(strip(out)).toBe(cmd);
            expect(painted(out, "syntaxFunction", "npm")).toBe(true);
        }
    });

    test("all parts of a compound word share its command position", () => {
        initTheme("dark");
        for (const cmd of ['"/usr"/bin/git status', "$HOME/bin/git status"]) {
            const out = highlightShellCommand(cmd);
            expect(strip(out)).toBe(cmd);
            expect(painted(out, "syntaxFunction", "/bin/git")).toBe(true);
            expect(painted(out, "syntaxFunction", "status")).toBe(false);
        }
    });

    test("escaped separators and spaces stay inside their word", () => {
        initTheme("dark");
        const cmd = String.raw`echo foo\ bar \; done \| grep \# literal`;
        const out = highlightShellCommand(cmd);
        expect(strip(out)).toBe(cmd);
        expect(painted(out, "syntaxOperator", ";")).toBe(false);
        expect(painted(out, "syntaxOperator", "|")).toBe(false);
        expect(painted(out, "syntaxKeyword", "done")).toBe(false);
        expect(painted(out, "syntaxFunction", "grep")).toBe(false);
        expect(painted(out, "syntaxComment", "#")).toBe(false);
    });

    test("redirections skip their target without consuming the command position", () => {
        initTheme("dark");
        for (const cmd of [">out git status", '2>"error log" git status', "3>&1 git status", "<<<$INPUT git status"]) {
            const out = highlightShellCommand(cmd);
            expect(strip(out)).toBe(cmd);
            expect(painted(out, "syntaxFunction", "git")).toBe(true);
            expect(painted(out, "syntaxFunction", "out")).toBe(false);
        }
        const out = highlightShellCommand("echo ok 2>&1 | grep ok");
        expect(painted(out, "syntaxOperator", "2>&")).toBe(true);
        expect(painted(out, "syntaxFunction", "grep")).toBe(true);
        expect(painted(out, "syntaxFunction", "1")).toBe(false);
    });

    test("newlines separate commands and end comments, except when escaped", () => {
        initTheme("dark");
        const out = highlightShellCommand("echo ok # comment\ngit status");
        expect(painted(out, "syntaxFunction", "git")).toBe(true);
        expect(painted(out, "syntaxComment", "# comment\ngit")).toBe(false);
        const continued = highlightShellCommand("echo \\\n done");
        expect(painted(continued, "syntaxKeyword", "done")).toBe(false);
    });

    test("colouring never changes the text, only its escapes", () => {
        initTheme("dark");
        for (const cmd of [
            "git status",
            `awk '{print $1}' file | sort -u`,
            'echo "unterminated',
            "ls $(pwd)/src",
            "a && b || c; d & e > f < g",
            "#!/bin/sh",
            "",
        ]) {
            expect(strip(highlightShellCommand(cmd))).toBe(cmd);
        }
    });

    test("terminates on every byte it is given", () => {
        initTheme("dark");
        // A reader that claims nothing would spin here; each of these is a
        // character no branch consumes on its own.
        for (const cmd of ["\\", "((", "))", "$", "'", "``", "!!", "%^@"]) {
            expect(strip(highlightShellCommand(cmd))).toBe(cmd);
        }
    });
});

describe("highlightToolSummary", () => {
    test("only bash — every other summary keeps the caller's muted run", () => {
        initTheme("dark");
        expect(highlightToolSummary("read", "src/a.ts")).toBeNull();
        expect(highlightToolSummary("grep", "TODO in src")).toBeNull();
        expect(highlightToolSummary("bash", "git status")).not.toBeNull();
    });

    test("a backgrounded call keeps its label out of the command", () => {
        initTheme("dark");
        const out = highlightToolSummary("bash", "npm run dev (background)")!;
        expect(strip(out)).toBe("npm run dev (background)");
        expect(painted(out, "syntaxFunction", "npm")).toBe(true);
        expect(painted(out, "dim", " (background)")).toBe(true);
    });

    test("a summary that already carries colour is left alone", () => {
        initTheme("dark");
        // An extension may own bash's summary; re-painting could cut an escape.
        expect(highlightToolSummary("bash", `${sgr("muted")}already painted`)).toBeNull();
    });
});

describe("the row uses the width it actually has", () => {
    const LONG =
        "find /some/deeply/nested/path -name '*.ts' -not -path node_modules -exec grep -l 'pattern' {} \; | head -50";

    test("bash rows retain command colors after quoted assignments and redirections", () => {
        for (const mode of ["loop", "noir"]) {
            setActiveUiMode(mode);
            initTheme("dark");
            const command = 'FOO="a b" 2>errors git status | grep modified';
            const c = new ToolExecutionComponent("bash", { command }, tui, "/repo");
            c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
            const title = c.render(200).find((line) => strip(line).includes(command))!;
            expect(title).toBeDefined();
            expect(painted(title, "syntaxFunction", "git")).toBe(true);
            expect(painted(title, "syntaxFunction", "grep")).toBe(true);
            expect(painted(title, "syntaxFunction", "errors")).toBe(false);
        }
    });

    test("formatToolArgs no longer cuts at 80 — that is the renderer's call", () => {
        expect(LONG.length).toBeGreaterThan(80);
        expect(formatToolArgs("bash", { command: LONG }, "/repo")).toBe(LONG);
        // The guard that remains is a ceiling on pathological input, not a
        // width: it is past anything a terminal can show.
        const huge = "x".repeat(5000);
        expect(formatToolArgs("bash", { command: huge }, "/repo").length).toBeLessThan(1100);
    });

    test("a wide terminal shows the whole command; a narrow one clips it", () => {
        setActiveUiMode("noir");
        initTheme("dark");
        const row = (width: number) => {
            const c = new ToolExecutionComponent("bash", { command: LONG }, tui, "/repo");
            c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
            return c.render(width).map(strip);
        };
        const wide = row(200).find((l) => l.includes("bash"))!;
        expect(wide).toContain("head -50");
        expect(wide).not.toContain("…");
        expect(wide.length).toBeLessThanOrEqual(200);

        const narrow = row(70).find((l) => l.includes("bash"))!;
        expect(narrow).toContain("…");
        expect(narrow.length).toBeLessThanOrEqual(70);
    });

    test("the default box gets the same width, not 80 columns of it", () => {
        setActiveUiMode("loop");
        initTheme("dark");
        const c = new ToolExecutionComponent("bash", { command: LONG }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        const title = c
            .render(200)
            .map(strip)
            .find((l) => l.includes("bash"))!;
        expect(title).toContain("head -50");
    });

    test("task rows show the prompt the width allows, not 50 characters of it", () => {
        setActiveUiMode("noir");
        initTheme("dark");
        const prompt =
            "find every call site of the legacy auth helper and report which ones still pass the old token shape";
        expect(prompt.length).toBeGreaterThan(50);
        const row = (width: number) => {
            const c = new ToolExecutionComponent("task", { agent: "explore", prompt }, tui, "/repo");
            c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
            return c
                .render(width)
                .map(strip)
                .find((l) => l.includes("task"))!;
        };
        expect(row(200)).toContain("old token shape");
        expect(row(200).length).toBeLessThanOrEqual(200);
        // Still clipped when there genuinely is no room.
        expect(row(70)).toContain("…");
        expect(row(70).length).toBeLessThanOrEqual(70);
    });

    test("the default box gives a task row the same width", () => {
        setActiveUiMode("loop");
        initTheme("dark");
        const prompt = "trace the retry path through the queue worker and say where a message can be dropped";
        const c = new ToolExecutionComponent("task", { agent: "plan", prompt }, tui, "/repo");
        c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
        const title = c
            .render(200)
            .map(strip)
            .find((l) => l.includes("task"))!;
        expect(title).toContain("can be dropped");
    });

    test("a folded run's member rows use the width too", () => {
        setActiveUiMode("noir");
        initTheme("night");
        setLiveVariant(true);
        const h = new ChatHistory(tui, "/repo");
        for (let i = 0; i < 2; i++) {
            h.addToolCall("bash", `c${i}`, { command: `${LONG} # ${i}` });
            h.addToolResult(`c${i}`, "ok");
        }
        const out = h.render(200).map(strip).join("\n");
        expect(out).toContain("head -50");
        for (const line of h.render(200).map(strip)) expect(line.length).toBeLessThanOrEqual(200);
    });
});
