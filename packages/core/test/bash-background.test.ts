/**
 * bash run_in_background, and the promotion path that replaces death-by-
 * timeout. The registry's own behaviour is covered in shell-registry.test.ts;
 * what matters here is that the tool hands the right processes over — and,
 * above all, that a background shell does NOT die with the turn that started
 * it, which is the entire point of the feature.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const mem: Record<string, unknown> = {};
mock.module("../src/settings", () => ({
    getSetting: (k: string) => mem[k],
    setSetting: (k: string, v: unknown) => {
        mem[k] = v;
    },
}));

const { createBashTool } = await import("../src/tools/bash");
const {
    listShells,
    killShell,
    readShell,
    resetShellRegistry,
    runningShellCount,
    setShellPanelPresent,
    MAX_BACKGROUND_SHELLS,
} = await import("../src/tools/utils/shell-registry");
const { useTempSessionDb } = await import("./helpers/temp-db");
const { useTempShellLogs } = await import("./helpers/temp-shell-logs");

useTempSessionDb();
useTempShellLogs();

const SESSION = "bg-test";

function bash(ctx: Record<string, unknown> = {}) {
    return createBashTool({ cwd: process.cwd(), sessionId: SESSION, ...ctx });
}

/** The AI SDK passes tool options; only abortSignal matters here. */
function run(tool: ReturnType<typeof bash>, input: Record<string, unknown>, signal?: AbortSignal) {
    return (tool.execute as (i: unknown, o: unknown) => Promise<string>)(input, { abortSignal: signal });
}

async function settled(id: string, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = listShells(SESSION).find((s) => s.id === id);
        if (found && found.status !== "running") return found;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${id} never settled`);
}

beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
    resetShellRegistry();
    setShellPanelPresent(false);
    // Background shells are opt-in, and beforeEach just cleared the store — so
    // every test below that exercises the feature has to turn it on. The tests
    // for the OFF path set it back to false themselves.
    mem.backgroundShells = true;
});

afterEach(() => {
    for (const s of listShells(SESSION)) if (s.status === "running") killShell(SESSION, s.id);
    resetShellRegistry();
    setShellPanelPresent(false);
});

describe("run_in_background", () => {
    test("returns a shell id immediately instead of the output", async () => {
        const out = await run(bash(), { command: "sleep 30", run_in_background: true });
        expect(out).toContain("bash_1");
        expect(out).toContain("background");
        expect(runningShellCount(SESSION)).toBe(1);
    });

    test("the output is readable through the registry afterwards", async () => {
        await run(bash(), { command: "echo hello-from-bg", run_in_background: true });
        await settled("bash_1");
        expect(readShell(SESSION, "bash_1")?.text).toContain("hello-from-bg");
    });

    test("aborting the turn does NOT kill the shell", async () => {
        // The whole feature in one assertion: esc ends the turn, and the dev
        // server the user asked for keeps running.
        const abort = new AbortController();
        await run(bash({ abortSignal: abort.signal }), { command: "sleep 30", run_in_background: true }, abort.signal);
        abort.abort();
        await new Promise((r) => setTimeout(r, 250));
        expect(listShells(SESSION)[0].status).toBe("running");
    });

    test("refuses once the concurrency cap is reached", async () => {
        for (let i = 0; i < MAX_BACKGROUND_SHELLS; i++) {
            await run(bash(), { command: "sleep 30", run_in_background: true });
        }
        await expect(run(bash(), { command: "sleep 30", run_in_background: true })).rejects.toThrow(
            /Too many background shells/,
        );
    });

    test("a read-only agent cannot leave a process behind", async () => {
        await expect(run(bash({ readOnlyFs: true }), { command: "sleep 30", run_in_background: true })).rejects.toThrow(
            /not available here/,
        );
        expect(runningShellCount(SESSION)).toBe(0);
    });

    test("refused outright when the setting is off", async () => {
        mem.backgroundShells = false;
        await expect(run(bash(), { command: "sleep 30", run_in_background: true })).rejects.toThrow(
            /Background shells are off/,
        );
        expect(runningShellCount(SESSION)).toBe(0);
    });

    test("refused when the setting is unset — the feature is opt-in", async () => {
        delete mem.backgroundShells;
        await expect(run(bash(), { command: "sleep 30", run_in_background: true })).rejects.toThrow(
            /Background shells are off/,
        );
        expect(runningShellCount(SESSION)).toBe(0);
    });

    test("the denylist still applies to a backgrounded command", async () => {
        mem.bashDeny = ["rm -rf /"];
        await expect(run(bash(), { command: "rm -rf /", run_in_background: true })).rejects.toThrow();
        expect(runningShellCount(SESSION)).toBe(0);
    });
});

describe("promotion on timeout", () => {
    test("without a panel to show it, a timeout still kills (the old behaviour)", async () => {
        setShellPanelPresent(false);
        await expect(run(bash(), { command: "sleep 5", timeout: 1 })).rejects.toThrow(/timed out/);
        expect(runningShellCount(SESSION)).toBe(0);
    });

    test("with a panel, the command is moved to the background instead of killed", async () => {
        setShellPanelPresent(true);
        const out = await run(bash(), { command: "sleep 5", timeout: 1 });
        expect(out).toContain("moved to the background");
        expect(out).toContain("bash_1");
        expect(runningShellCount(SESSION)).toBe(1);
    });

    test("a promoted shell keeps the output it printed before promotion", async () => {
        setShellPanelPresent(true);
        await run(bash(), { command: "echo before-promotion; sleep 5", timeout: 1 });
        const read = readShell(SESSION, "bash_1");
        expect(read?.text).toContain("before-promotion");
        // And it is marked as promoted, so surfaces can say why it is there.
        expect(listShells(SESSION)[0].promoted).toBe(true);
    });

    test("output after promotion is not double-counted", async () => {
        // The foreground accumulator and the registry both listened to this
        // child; if the tool forgets to detach one, every later line lands
        // twice.
        setShellPanelPresent(true);
        await run(bash(), { command: "sleep 1.2; echo once", timeout: 1 });
        await settled("bash_1");
        const text = readShell(SESSION, "bash_1")?.text ?? "";
        expect(text.match(/once/g)?.length).toBe(1);
    });

    test("the setting off means a timeout kills, panel or no panel", async () => {
        // Disabling the feature has to take promotion with it — otherwise a
        // long command still ends up as a shell the user switched off.
        mem.backgroundShells = false;
        setShellPanelPresent(true);
        await expect(run(bash(), { command: "sleep 5", timeout: 1 })).rejects.toThrow(/timed out/);
        expect(runningShellCount(SESSION)).toBe(0);
    });

    test("unset means a timeout kills too — promotion is part of the opt-in", async () => {
        delete mem.backgroundShells;
        setShellPanelPresent(true);
        await expect(run(bash(), { command: "sleep 5", timeout: 1 })).rejects.toThrow(/timed out/);
        expect(runningShellCount(SESSION)).toBe(0);
    });

    test("a command that finishes in time is unaffected", async () => {
        setShellPanelPresent(true);
        const out = await run(bash(), { command: "echo quick", timeout: 5 });
        expect(out).toContain("quick");
        expect(listShells(SESSION)).toEqual([]);
    });
});
