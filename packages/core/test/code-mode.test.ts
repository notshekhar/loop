import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// In-memory settings: the tools' deny/permission checks read settings, and a
// test must never read or write the real ~/.loop/settings.json.
const mem: Record<string, unknown> = {};
const realSettings = await import("../src/settings");
mock.module("../src/settings", () => ({
    ...realSettings,
    getSetting: (k: string) => mem[k],
    setSetting: (k: string, v: unknown) => {
        mem[k] = v;
    },
}));

const { createTools } = await import("../src/tools");
const { createCodeTool } = await import("../src/tools/code-mode");
const { clearPermissionRulesCache } = await import("../src/tools/utils/permission-rules");
const { foldIntoCodeTool } = await import("../src/agent/turn/code-mode");
const { useTempSessionDb } = await import("./helpers/temp-db");
type CodeToolOutput = import("../src/tools/code-mode").CodeToolOutput;
type CodeRunPayload = import("../src/tools/code-mode").CodeRunPayload;

useTempSessionDb();

let cwd = "";
beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
    clearPermissionRulesCache();
    cwd = mkdtempSync(join(tmpdir(), "loop-code-mode-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

type Event = { kind: "started" | "finished" | "failed"; id: string; toolName?: string };

async function codeTool() {
    const events: Event[] = [];
    const runs: CodeRunPayload[] = [];
    const tool = await createCodeTool({
        recordRun: async (payload) => {
            runs.push(payload);
        },
        tools: createTools({ cwd, sessionId: "code-mode-test" }) as never,
        sink: {
            started: ({ id, toolName }) => events.push({ kind: "started", id, toolName }),
            finished: (id) => events.push({ kind: "finished", id }),
            failed: (id, toolName) => events.push({ kind: "failed", id, toolName }),
        },
    });
    const run = (code: string, abortSignal?: AbortSignal) =>
        (tool as unknown as { execute: (i: object, o: object) => Promise<CodeToolOutput> }).execute(
            { code },
            { toolCallId: "call-1", messages: [], ...(abortSignal ? { abortSignal } : {}) },
        );
    const modelText = (output: CodeToolOutput) =>
        (tool as unknown as { toModelOutput: (a: { output: unknown }) => { value: string } }).toModelOutput({ output })
            .value;
    return { tool, run, events, runs, modelText };
}

describe("code tool", () => {
    test("a script chains real tools: read, edit, read back", async () => {
        writeFileSync(join(cwd, "retry.ts"), "export const maxAttempts = 3;\n");
        const { run, events, runs, modelText } = await codeTool();
        const out = await run(`
            const before = await tools.read({ path: "retry.ts" });
            await tools.edit({ path: "retry.ts", edits: [{ oldText: "maxAttempts = 3", newText: "maxAttempts = 5" }] });
            return { before: before.includes("= 3"), after: (await tools.read({ path: "retry.ts" })).includes("= 5") };
        `);
        expect(out.ok).toBe(true);
        expect(readFileSync(join(cwd, "retry.ts"), "utf8")).toBe("export const maxAttempts = 5;\n");
        expect(out.callCount).toBe(3);
        // The run is saved for replay: the script, and each call with what it returned.
        expect(runs).toHaveLength(1);
        expect(runs[0]!.toolCallId).toBe("call-1");
        expect(runs[0]!.code).toContain("tools.edit");
        expect(runs[0]!.calls.map((c) => [c.id, c.toolName])).toEqual([
            ["call-1.1", "read"],
            ["call-1.2", "edit"],
            ["call-1.3", "read"],
        ]);
        // Each call was announced as it started and as it ended, so a UI draws it live.
        expect(events.map((e) => `${e.kind}:${e.id}`)).toEqual([
            "started:call-1.1",
            "finished:call-1.1",
            "started:call-1.2",
            "finished:call-1.2",
            "started:call-1.3",
            "finished:call-1.3",
        ]);
        const text = modelText(out);
        expect(text).toContain("Script completed (3 tool calls).");
        expect(text).toContain('"after": true');
    });

    test("independent calls run in parallel", async () => {
        const { run } = await codeTool();
        const started = performance.now();
        const out = await run(`
            await Promise.all([1, 2, 3].map((n) => tools.bash({ command: "sleep 0.6; echo " + n })));
            return "done";
        `);
        const elapsed = performance.now() - started;
        expect(out.ok).toBe(true);
        expect(out.callCount).toBe(3);
        // Three 0.6s commands one after another would take 1.8s.
        expect(elapsed).toBeLessThan(1500);
    });

    test("a deny rule still refuses a call made from a script", async () => {
        mem.bashDeny = ["touch"];
        const { run, events, runs } = await codeTool();
        const out = await run(`
            try { await tools.bash({ command: "touch made-it" }); return "ran"; }
            catch (e) { return "refused: " + e.message; }
        `);
        expect(out.ok).toBe(true);
        expect(String(out.text)).toContain("refused:");
        expect(() => readFileSync(join(cwd, "made-it"))).toThrow();
        expect(events.map((e) => e.kind)).toEqual(["started", "failed"]);
        expect(runs[0]!.calls[0]!.error).toBeDefined();
    });

    test("the sandbox has no host: the constructor trick finds no process", async () => {
        const { run } = await codeTool();
        const out = await run(`
            return [typeof process, typeof Bun, typeof require,
                    tools.read.constructor.constructor("return typeof process")()].join(" ");
        `);
        expect(out.text).toContain("undefined undefined undefined undefined");
    });

    test("aborting stops a script that never yields", async () => {
        const { run } = await codeTool();
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 200);
        const started = performance.now();
        const failure = await run("while (true) {}", abort.signal).catch((e: Error) => e);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("Script failed (aborted)");
        expect(performance.now() - started).toBeLessThan(2000);
    });

    test("input is checked against the tool's schema, like a direct call", async () => {
        const { run, events } = await codeTool();
        const out = await run(`
            try { await tools.read({ nope: 1 }); } catch (e) { return e.message; }
        `);
        expect(out.text).toContain("Invalid input for read");
        // Rejected before it ran: nothing to draw.
        expect(events).toEqual([]);
    });
});

describe("folding a turn's tools", () => {
    test("control tools stay direct, the rest move into code, and code is hook-wrapped", async () => {
        const wrapped: string[][] = [];
        const tools = { ...createTools({ cwd }), ask: { execute: async () => "" }, todo: { execute: async () => "" } };
        const folded = await foldIntoCodeTool(tools, {
            emitter: { emit: () => true } as never,
            wrap: (t) => {
                wrapped.push(Object.keys(t));
                return t;
            },
        });
        expect(Object.keys(folded).sort()).toEqual(["ask", "code", "todo"]);
        expect(wrapped).toEqual([["code"]]);
        const description = (folded.code as { description: string }).description;
        for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
            expect(description).toContain(`${name}(`);
        }
    });
});

describe("a saved Code Mode run, reopened", () => {
    test("the desktop transcript draws each call as its own tool part, right after the code part", async () => {
        const { fromEntries } = await import("../src/transcript");
        const at = (n: number) => ({ ts: n, id: `e${n}` });
        const run = {
            kind: "code-run",
            toolCallId: "call-1",
            code: "await tools.read({ path: 'a.ts' })",
            calls: [
                { id: "call-1.1", toolName: "read", input: { path: "a.ts" }, output: "1\talpha", durationMs: 3 },
                { id: "call-1.2", toolName: "bash", input: { command: "false" }, error: "exit 1", durationMs: 9 },
            ],
        };
        const transcript = fromEntries([
            { type: "message", role: "user", content: "go", ...at(1) },
            // Saved while the script ran: before the step's assistant message.
            { type: "custom", payload: run, ...at(2) },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "call-1", toolName: "code", input: { code: run.code } }],
                ...at(3),
            },
            {
                type: "message",
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "call-1",
                        toolName: "code",
                        output: { type: "text", value: "Script completed (2 tool calls)." },
                    },
                ],
                ...at(4),
            },
        ] as never);
        const reply = transcript.messages.find((m) => m.role === "assistant")!;
        const tools = reply.parts.filter((p) => "toolCallId" in p) as {
            toolCallId: string;
            toolName: string;
            state: string;
            output?: unknown;
            errorText?: string;
        }[];
        expect(tools.map((t) => [t.toolCallId, t.toolName, t.state])).toEqual([
            ["call-1", "code", "output-available"],
            ["call-1.1", "read", "output-available"],
            ["call-1.2", "bash", "output-error"],
        ]);
        expect(tools[1]!.output).toBe("1\talpha");
        expect(tools[2]!.errorText).toBe("exit 1");
    });
});
