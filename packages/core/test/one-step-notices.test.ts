/**
 * One-step notices — a background shell's exit and a todo nudge — ride the
 * end of ONE request and are gone from the next. AI SDK v7 carries what
 * prepareStep returns into the next step, so without taking them back out
 * they would stay in every later step of the turn. Driven through real turns
 * against a scripted model, reading what each step was actually sent.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { useTempSessionDb } from "./helpers/temp-db";
import { useTempShellLogs } from "./helpers/temp-shell-logs";

useTempSessionDb();
useTempShellLogs();

// Delegating mocks: bun module mocks leak across files, so each falls through
// to the real module unless this file's tests set something.
const settings: Record<string, unknown> = {};
const realSettings = await import("../src/settings");
const realGetSetting = realSettings.getSetting;
mock.module("../src/settings", () => ({
    ...realSettings,
    getSetting: (key: string) => (key in settings ? settings[key] : realGetSetting(key as never)),
}));
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
const realGetModel = realProviders.getModel;
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) => currentModel ?? realGetModel(...args),
}));

const { SessionManager } = await import("../src/sessions");
const { runTurn, CostTracker } = await import("../src/agent");
const { listShells, registerShell, resetShellRegistry } = await import("../src/tools/utils/shell-registry");
const { TODO_NUDGE_START_AFTER } = await import("../src/tools/todo");

const MODEL = "xai/grok-build-0.1";

type Part = Record<string, unknown>;
const usage = {
    inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const stream = (parts: Part[]) => ({
    stream: new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        },
    }),
});
const callLs = (id: string): Part[] => [
    { type: "tool-call", toolCallId: id, toolName: "ls", input: "{}" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const say = (text: string): Part[] => [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
];

/** Runs a turn of `steps` model calls (all but the last call ls) and returns what each step was sent. */
async function promptsOfTurn(steps: number, onStep?: (step: number, sessionId: string) => Promise<void>) {
    const session = await new SessionManager().create({ cwd: dir, provider: "xai", model: MODEL });
    const prompts: string[] = [];
    currentModel = new MockLanguageModelV3({
        doStream: async (call: any) => {
            prompts.push(JSON.stringify(call.prompt));
            await onStep?.(prompts.length, session.id);
            return prompts.length < steps ? stream(callLs(`l${prompts.length}`)) : stream(say("ok"));
        },
    });
    await runTurn({
        session,
        modelId: MODEL,
        userInput: "go",
        cwd: dir,
        tracker: new CostTracker(),
        emitter: new EventEmitter() as never,
    });
    expect(prompts).toHaveLength(steps);
    return prompts;
}

/** The 1-based steps whose prompt contains `needle`. */
const stepsWith = (prompts: readonly string[], needle: string) =>
    prompts.flatMap((p, i) => (p.includes(needle) ? [i + 1] : []));

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-notices-"));
    resetShellRegistry();
});

afterEach(() => {
    currentModel = null;
    for (const key of Object.keys(settings)) delete settings[key];
    resetShellRegistry();
    rmSync(dir, { recursive: true, force: true });
});

describe("one-step notices", () => {
    test("a background shell's exit is told on the next step only", async () => {
        settings.backgroundShells = true;
        const prompts = await promptsOfTurn(4, async (step, sessionId) => {
            if (step !== 1) return;
            // A shell finishes while the first step is out.
            const child = spawn("/bin/bash", ["-c", "exit 3"], { stdio: ["ignore", "pipe", "pipe"] });
            const shell = registerShell({ sessionId, command: "exit 3", cwd: dir, child });
            while (listShells(sessionId).find((s) => s.id === shell.id)?.status === "running") await Bun.sleep(10);
        });
        expect(stepsWith(prompts, "exit 3")).toEqual([2]);
    });

    test("a todo nudge is sent on one step, not on every step after it", async () => {
        settings.todos = true;
        const steps = TODO_NUDGE_START_AFTER + 4;
        const prompts = await promptsOfTurn(steps);
        expect(stepsWith(prompts, "without a todo list")).toHaveLength(1);
    });
});
