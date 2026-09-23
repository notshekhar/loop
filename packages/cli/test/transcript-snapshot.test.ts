import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";

/**
 * Byte-identity gate for THE transcript — every chat block as noir renders it,
 * ANSI bytes included.
 *
 * These replaced the old `ui-mode-snapshot.test.ts`, which pinned the legacy
 * `loop` mode's boxed look. They were captured just before the UI-mode system
 * was deleted — under noir with the knobs its `live` variant used to add
 * (verb grouping, `→` hints) turned on, because that is what the one
 * remaining look is. The teardown had to leave these bytes exactly as they
 * were, and this is the file that proved it.
 *
 * Re-baseline log (each entry changed ONLY the noted bytes):
 * - 2026-09-22: the palette became GrokNight/GrokDay — grok's own theme files
 *   rather than a hand-normalised set. A palette is colour VALUES and nothing
 *   else, so the only bytes that could move are the SGR escapes; the diffs
 *   that were inspected before rebaselining were exactly that (same glyphs,
 *   same widths, different hexes).
 * - 2026-09-23: markdown went back to loop's own softer colours (headings,
 *   inline code, code blocks, links, syntax — NIGHT_MARKDOWN in themes.ts);
 *   the canvas and greys stay grok's. Colour VALUES only.
 * - 2026-09-23: folding became grok's fold pass (transcript-folds.ts), with
 *   loop's own rule that every kind folds once finished. One snapshot moved:
 *   a fold is ONE header row — the member table that used to hang under
 *   "Read 3 files" (and "Ran 1 command") is gone. No other byte changed.
 */
// Pin the color pipeline before the theme module reads COLORTERM.
process.env.COLORTERM = "truecolor";
/**
 * Pin the CLOCK too, in both of its dimensions.
 *
 * Rows carry a right-aligned `h:mm` timestamp, so a snapshot captured at 3:00
 * fails at 3:10 with nothing changed — and the same bytes would differ between
 * two machines in different zones. `TZ` fixes the zone (bun applies it at
 * runtime) and the frozen `Date.now` below fixes the instant, which together
 * make these byte comparisons about the rendering and nothing else.
 */
process.env.TZ = "UTC";
/**
 * ...and before chalk reads FORCE_COLOR. The two halves of "colour" come from
 * different places: the theme's `fg`/`bg` build truecolor escapes by hand and
 * always emit them, while `bold`/`italic`/`underline` go through chalk, which
 * emits NOTHING at level 0. Under `bun test` stdout is not a TTY, so chalk sits
 * at 0 — which is the state these snapshots are captured in, and pinning it
 * makes the gate compare like with like whoever runs it (a developer with
 * FORCE_COLOR exported would otherwise get chalk at level 3 and a wall of
 * failures with nothing in the repo changed).
 *
 * Set on the instance, not via the env var: chalk reads `FORCE_COLOR` when it
 * is imported, and ES imports hoist above this file's statements.
 */
import chalk from "chalk";

chalk.level = 0;

/** 2026-01-30 15:00:00 UTC — an arbitrary instant, held still. */
const FIXED_NOW = 1769871600000;
const realNow = Date.now;

import { ChatHistory } from "../src/interactive/components/chat-history";
import {
    AssistantMessageComponent,
    BranchSummaryMessageComponent,
    CompactionSummaryMessageComponent,
    DynamicBorder,
    SkillInvocationMessageComponent,
    parseSkillBlock,
    UserMessageComponent,
} from "../src/interactive/ui/messages";
import { ToolExecutionComponent } from "../src/interactive/ui/tool-execution";
import { initTheme } from "../src/interactive/ui/theme";

beforeAll(() => {
    Date.now = () => FIXED_NOW;
    initTheme("night");
    // Re-asserted here, not only at module scope: chalk is a singleton bun
    // shares across every test file in the process, so a file that raises the
    // level (theme-attributes.test.ts) could otherwise leave it raised
    // depending on load order.
    chalk.level = 0;
});

afterAll(() => {
    Date.now = realNow;
});

const tui = { requestRender() {} } as unknown as TUI;
const CWD = "/repo";
const W = 80;

describe("user + assistant messages", () => {
    test("user message (markdown, bg box, OSC zones)", () => {
        expect(new UserMessageComponent("fix the **auth** bug in `login.ts`").render(W)).toMatchSnapshot();
    });

    test("assistant text-only", () => {
        const c = new AssistantMessageComponent({
            content: [{ type: "text", text: "The bug is a missing `await` in the token refresh path." }],
            stopReason: "stop",
        });
        expect(c.render(W)).toMatchSnapshot();
    });

    test("assistant thinking then text", () => {
        const c = new AssistantMessageComponent({
            content: [
                { type: "thinking", thinking: "The user wants the auth bug fixed.\nLook at login.ts first." },
                { type: "text", text: "Found it — `refresh()` is not awaited." },
            ],
            stopReason: "stop",
        });
        expect(c.render(W)).toMatchSnapshot();
    });

    test("assistant aborted", () => {
        const c = new AssistantMessageComponent({
            content: [{ type: "text", text: "Let me check" }],
            stopReason: "aborted",
        });
        expect(c.render(W)).toMatchSnapshot();
    });

    test("assistant error", () => {
        const c = new AssistantMessageComponent({
            content: [],
            stopReason: "error",
            errorMessage: "connection reset",
        });
        expect(c.render(W)).toMatchSnapshot();
    });
});

describe("tool execution", () => {
    const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

    test("pending bash (no result yet)", () => {
        expect(new ToolExecutionComponent("bash", { command: "bun test" }, tui, CWD).render(W)).toMatchSnapshot();
    });

    test("bash success, short output", () => {
        const c = new ToolExecutionComponent("bash", { command: "echo hi" }, tui, CWD);
        c.updateResult(result("hi"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("bash success, long output collapsed then expanded", () => {
        const c = new ToolExecutionComponent("bash", { command: "seq 12" }, tui, CWD);
        const lines = Array.from({ length: 12 }, (_, i) => String(i + 1)).join("\n");
        c.updateResult(result(lines), false);
        expect(c.render(W)).toMatchSnapshot();
        c.setExpanded(true);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("bash error output", () => {
        const c = new ToolExecutionComponent("bash", { command: "false" }, tui, CWD);
        c.updateResult(result("command failed", true), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("edit diff coloring", () => {
        const c = new ToolExecutionComponent("edit", { path: "/repo/src/a.ts" }, tui, CWD);
        c.updateResult(result("@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n context"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("read with line range + syntax highlight", () => {
        const c = new ToolExecutionComponent("read", { path: "/repo/src/a.ts", offset: 10, limit: 2 }, tui, CWD);
        c.updateResult(result("const x = 1;\nexport default x;"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("task pending with live status, then done with stats", () => {
        const c = new ToolExecutionComponent("task", { agent: "explore", prompt: "find the auth code" }, tui, CWD);
        c.updateStatus("read src/login.ts");
        expect(c.render(W)).toMatchSnapshot();
        c.setTaskStats({ steps: 3, durationMs: 41000, usd: 0.043 });
        c.updateResult(result("found it"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("sql input preview", () => {
        const c = new ToolExecutionComponent("sql", { query: "select id from users where active = 1" }, tui, CWD);
        c.updateResult(result("2 rows"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("plan renders input as markdown", () => {
        const c = new ToolExecutionComponent("plan", { plan: "# Plan\n\n1. read\n2. edit" }, tui, CWD);
        c.updateResult(result("ok"), false);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("streaming write input tail", () => {
        const c = new ToolExecutionComponent("write", {}, tui, CWD);
        c.updateStreamingInput({ path: "/repo/src/new.ts", content: "line1\nline2\nline3" });
        expect(c.render(W)).toMatchSnapshot();
    });
});

describe("special message boxes", () => {
    test("skill invocation collapsed and expanded", () => {
        const block = parseSkillBlock('<skill name="verify" location="/repo/.skills/verify.md">\ncheck it\n</skill>');
        const c = new SkillInvocationMessageComponent(block!);
        expect(c.render(W)).toMatchSnapshot();
        c.setExpanded(true);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("compaction summary collapsed and expanded", () => {
        const c = new CompactionSummaryMessageComponent({ summary: "We fixed auth.", tokensBefore: 123456 });
        expect(c.render(W)).toMatchSnapshot();
        c.setExpanded(true);
        expect(c.render(W)).toMatchSnapshot();
    });

    test("branch summary collapsed", () => {
        expect(new BranchSummaryMessageComponent("Abandoned branch did X.").render(W)).toMatchSnapshot();
    });

    test("dynamic border", () => {
        expect(new DynamicBorder().render(20)).toMatchSnapshot();
    });
});

describe("chat history end-to-end", () => {
    test("a small conversation renders stably", () => {
        const h = new ChatHistory(tui, CWD);
        h.addUser("run the tests");
        h.appendAssistantDelta("Running them now.", "anthropic", "claude");
        h.addToolCall("bash", "c1", { command: "bun test" });
        h.addToolResult("c1", "12 pass");
        h.appendAssistantDelta("All green.", "anthropic", "claude");
        h.finishAssistant();
        h.addSystem("model switched");
        h.addCommand("/model sonnet");
        h.addHook("post-turn hook ran");
        h.addError("boom");
        h.addRecap("Fixed the tests.");
        h.addCompactionSummary("Old context.", 5000, 1751980000000);
        h.addBranchSummary("Side quest.");
        expect(h.render(W)).toMatchSnapshot();
    });

    test("skill user message + session-start hook context", () => {
        const h = new ChatHistory(tui, CWD);
        h.addUser('<skill name="verify" location="/x">\nbody\n</skill>\n\ndo it');
        expect(h.render(W)).toMatchSnapshot();
    });

    test("tools expanded toggle re-renders expanded", () => {
        const h = new ChatHistory(tui, CWD);
        h.addUser("go");
        h.addToolCall("bash", "c1", { command: "seq 12" });
        h.addToolResult("c1", Array.from({ length: 12 }, (_, i) => String(i + 1)).join("\n"));
        h.setToolsExpanded(true);
        expect(h.render(W)).toMatchSnapshot();
    });

    /**
     * Verb grouping — the one piece of the old `live` variant with a visual
     * footprint of its own: a run of finished, folded, same-verb calls renders
     * as one row. It is captured here because it becomes unconditional, so
     * this snapshot is the proof that "always on" produced the same row the
     * variant used to.
     */
    test("a run of finished reads folds into one group row", () => {
        const h = new ChatHistory(tui, CWD);
        h.addUser("read the auth files");
        for (const [i, path] of ["/repo/src/login.ts", "/repo/src/token.ts", "/repo/src/session.ts"].entries()) {
            h.addToolCall("read", `r${i}`, { path });
            h.addToolResult(`r${i}`, "const x = 1;\nexport default x;");
        }
        expect(h.render(W)).toMatchSnapshot();
    });
});
