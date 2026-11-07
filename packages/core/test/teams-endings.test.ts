/**
 * Thread teams when things do not go to plan: a stop, a cancel, a failure, plan
 * mode, a process with no runtime. Real turns against a scripted model, and a
 * host that runs them the way the TUI and the RPC server do.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { useTempSessionDb } from "./helpers/temp-db";
import { useTempShellLogs } from "./helpers/temp-shell-logs";

useTempSessionDb();
useTempShellLogs();

// Delegating mocks, as in teams.test.ts: bun module mocks leak across files.
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

const teams = await import("../src/teams");
const { SessionManager } = await import("../src/sessions");
const { addLedgerRow } = await import("../src/sessions/cost-ledger");
const { runTurn, CostTracker } = await import("../src/agent");
const { killSessionShells, registerShell, runningShellCount } = await import("../src/tools/utils/shell-registry");
const { setPlanMode } = await import("../src/tools/utils/plan-mode");

type Session = Awaited<ReturnType<InstanceType<typeof SessionManager>["create"]>>;
type ModelCall = Parameters<NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"] & object>[0];
type StreamResult = { stream: ReadableStream<unknown> };
type ToolSet = Record<string, { execute: (input: unknown, opts: unknown) => Promise<string> }>;

const MODEL = "xai/grok-build-0.1";
const usage = {
    inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const stream = (parts: unknown[]): StreamResult => ({
    stream: new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        },
    }),
});
const callTool = (toolName: string, input: unknown): StreamResult =>
    stream([
        { type: "tool-call", toolCallId: `${toolName}-${Math.random()}`, toolName, input: JSON.stringify(input) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
    ]);
const say = (text: string): StreamResult =>
    stream([
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
/** A model call that only ends when its turn is cancelled. */
const hang = (call: ModelCall): Promise<StreamResult> =>
    new Promise((_, reject) => call.abortSignal?.addEventListener("abort", () => reject(new Error("aborted"))));

const promptOf = (call: ModelCall): string => JSON.stringify(call.prompt);
const calledTool = (call: ModelCall, name: string): boolean =>
    call.prompt.some((m) => m.role === "tool" && m.content.some((p) => "toolName" in p && p.toolName === name));
const isThread = (text: string): boolean => text.includes("You are in a thread team");

function script(fn: (call: ModelCall, text: string) => StreamResult | Promise<StreamResult>): void {
    currentModel = new MockLanguageModelV3({
        doStream: (async (call: ModelCall) => fn(call, promptOf(call))) as never,
    });
}

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(10);
    }
    throw new Error(`never: ${what}`);
}

let dir: string;
const manager = new SessionManager();
const owner = {};
const running = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();
const cancelled: string[] = [];
let restoreRuntime = () => {};

/** What a host does: run the turn, then pick up mail that came in late. */
function runHosted(session: Session, input: string, team?: Parameters<typeof runTurn>[0]["team"]): Promise<void> {
    const abort = new AbortController();
    aborts.set(session.id, abort);
    const turn = runTurn({
        session,
        modelId: MODEL,
        userInput: input,
        cwd: dir,
        abortSignal: abort.signal,
        tracker: new CostTracker(),
        emitter: new EventEmitter() as never,
        ...(team ? { team } : {}),
    })
        .catch(() => {})
        .finally(() => {
            running.delete(session.id);
            teams.wakeTeamInbox(session.id);
        });
    running.set(session.id, turn);
    return turn;
}

const newSession = () => manager.create({ cwd: dir, provider: "xai", model: MODEL });
const threadNamed = (lead: Session, title: string) =>
    teams.listTeam(teams.teamOf(lead.id)!.teamId).find((m) => m.title === title)!;
const allTurnsEnded = async () => {
    await until(() => running.size === 0, "every turn ended");
};

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-team-endings-"));
    settings.threadTeams = true;
    cancelled.length = 0;
    restoreRuntime = teams.setTeamRuntimeForTests(owner, {
        deliver: async (sessionId, input, team) => {
            void runHosted(await manager.open(sessionId), input, team);
        },
        isRunning: (sessionId) => running.has(sessionId),
        cancel: (sessionId) => {
            cancelled.push(sessionId);
            aborts.get(sessionId)?.abort();
        },
    });
});

afterEach(() => {
    restoreRuntime();
    currentModel = null;
    running.clear();
    aborts.clear();
    for (const key of Object.keys(settings)) delete settings[key];
});

describe("plan mode", () => {
    test("a planning lead cannot start a thread, and no thread writes for it", async () => {
        const target = join(dir, "written-in-plan-mode.txt");
        const results: string[] = [];
        script((call, text) => {
            if (isThread(text)) return callTool("write", { path: target, content: "x" });
            if (!calledTool(call, "spawn_threads")) {
                return callTool("spawn_threads", { threads: [{ title: "Writer", brief: "write it" }] });
            }
            results.push(text);
            return say("ok");
        });
        const lead = await newSession();
        setPlanMode(lead.id, true);
        await runHosted(lead, "plan it");
        await allTurnsEnded();
        setPlanMode(lead.id, false);

        expect(existsSync(target)).toBe(false);
        expect(teams.teamOf(lead.id)).toBeNull();
        expect(results.join()).toContain("plan mode is active");
    });

    test("a planning lead cannot hand an existing thread work either", async () => {
        const lead = await newSession();
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, "idle-thread", "idle");
        const tools = teams.createTeamTools({ session: lead, modelId: MODEL, cwd: dir }) as ToolSet;
        setPlanMode(lead.id, true);
        const out = await tools.send_message!.execute({ to: "idle-thread", message: "edit the file" }, {});
        setPlanMode(lead.id, false);

        expect(out).toContain("plan mode is active");
        expect(teams.inboxCount("idle-thread")).toBe(0);
    });
});

describe("cancelling a wait", () => {
    test("mail wait_for_team had taken goes back to the inbox", async () => {
        const lead = await newSession();
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, "slow", "running");
        teams.postTeamMessages({ teamId, from: "slow", to: [lead.id], kind: "report", body: "THE REPORT" });
        const abort = new AbortController();
        const tools = teams.createTeamTools({
            session: lead,
            modelId: MODEL,
            cwd: dir,
            abortSignal: abort.signal,
        }) as ToolSet;

        const waiting = tools.wait_for_team!.execute({ until: "all", timeoutSec: 30 }, {});
        await until(() => teams.inboxCount(lead.id) === 0, "the wait took the report");
        abort.abort();
        const result = await waiting;

        expect(result).toContain("the turn was cancelled");
        expect(result).not.toContain("THE REPORT");
        expect(teams.takeInbox(lead.id).map((m) => m.body)).toEqual(["THE REPORT"]);
    });
});

describe("a thread that stops without a report", () => {
    /** The lead spawns one thread and ends its turn; everything it is told after that is a later call. */
    function leadWithOneThread(thread: (call: ModelCall) => StreamResult | Promise<StreamResult>): { heard: string[] } {
        const heard: string[] = [];
        script((call, text) => {
            if (isThread(text)) return thread(call);
            if (!calledTool(call, "spawn_threads")) {
                return callTool("spawn_threads", { threads: [{ title: "A", brief: "the job" }] });
            }
            heard.push(text);
            return say("noted");
        });
        return { heard };
    }

    test("the lead is told it failed, and why", async () => {
        const { heard } = leadWithOneThread(() => {
            throw new Error("401 bad key");
        });
        const lead = await newSession();
        await runHosted(lead, "go");
        await until(() => heard.some((t) => t.includes("failed before it reported")), "the lead heard");
        await allTurnsEnded();

        expect(heard.join()).toContain("401 bad key");
        expect(threadNamed(lead, "A").state).toBe("failed");
    });

    test("the lead is told it ended quietly", async () => {
        const { heard } = leadWithOneThread(() => say("finished, but no report"));
        const lead = await newSession();
        await runHosted(lead, "go");
        await until(() => heard.some((t) => t.includes("without a report")), "the lead heard");
        await allTurnsEnded();

        expect(threadNamed(lead, "A").state).toBe("idle");
    });

    test("a thread that reported, or answered the lead by message, says nothing more", async () => {
        const reported = leadWithOneThread(() => callTool("report", { summary: "done" }));
        const lead = await newSession();
        await runHosted(lead, "go");
        await allTurnsEnded();
        expect(reported.heard.join()).not.toContain("without a report");

        const second = await newSession();
        const answered = leadWithOneThread((call) =>
            calledTool(call, "send_message")
                ? say("that was my answer")
                : callTool("send_message", { to: second.id, message: "here is the answer" }),
        );
        await runHosted(second, "go");
        await allTurnsEnded();
        expect(answered.heard.join()).not.toContain("without a report");
    });

    test("a turn the user typed into a thread is not the lead's business", async () => {
        script(() => say("just chatting"));
        const lead = await newSession();
        const thread = await newSession();
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, thread.id, "done");
        await runHosted(thread, "hello");
        await allTurnsEnded();

        expect(teams.inboxCount(lead.id)).toBe(0);
    });
});

describe("stopping a team", () => {
    test("cancels the threads but not the lead, and tells the lead", async () => {
        const heard: string[] = [];
        let leadCalls = 0;
        script((call, text) => {
            if (isThread(text)) return hang(call);
            leadCalls++;
            if (leadCalls === 1) return callTool("spawn_threads", { threads: [{ title: "H", brief: "hang" }] });
            if (leadCalls === 2) return callTool("wait_for_team", { until: "all", timeoutSec: 30 });
            heard.push(text);
            return say("finishing it myself");
        });
        const lead = await newSession();
        const turn = runHosted(lead, "go");
        await until(() => teams.teamOf(lead.id)?.state === "waiting", "the lead is waiting");

        teams.stopTeam(teams.teamOf(lead.id)!.teamId);
        await turn;

        expect(cancelled).toEqual([threadNamed(lead, "H").sessionId]);
        expect(threadNamed(lead, "H").state).toBe("stopped");
        expect(heard.join()).toContain("The user stopped the team");
    });

    test("the budget stops the threads, leaves the lead, and says why", async () => {
        settings.threadTeamsBudgetUsd = 1;
        const lead = await newSession();
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, "busy", "running");
        running.set(lead.id, new Promise(() => {}));
        running.set("busy", new Promise(() => {}));
        const changes: string[] = [];
        const off = teams.onTeamChange((change) => changes.push(change.kind));

        addLedgerRow({
            provider: "xai",
            model: MODEL,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            usd: 5,
            ctx: { source: "team", sessionPub: lead.id },
        } as never);
        off();

        expect(cancelled).toEqual(["busy"]);
        expect(changes).toContain("budget");
        expect(teams.teamSnapshot(teamId)).toMatchObject({ stopped: true, overBudget: true });
        expect(
            teams
                .takeInbox(lead.id)
                .map((m) => m.body)
                .join(),
        ).toContain("reached its budget");
    });

    test("kills the threads' background shells and leaves the lead's", async () => {
        const lead = await newSession();
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, "shell-owner", "running");
        const startShell = (sessionId: string) => {
            const child = spawn("/bin/bash", ["-c", "sleep 30"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
            registerShell({ sessionId, command: "sleep 30", cwd: dir, child });
        };
        startShell("shell-owner");
        startShell(lead.id);

        teams.stopTeam(teamId);
        await until(() => runningShellCount("shell-owner") === 0, "the thread's shell died");

        expect(runningShellCount(lead.id)).toBe(1);
        killSessionShells(lead.id);
    });

    test("a thread stopped inside wait_for_team stays stopped", async () => {
        script((call, text) => {
            if (isThread(text)) {
                if (text.includes("hang job")) return hang(call);
                return callTool("wait_for_team", { until: "all", timeoutSec: 30 });
            }
            if (calledTool(call, "spawn_threads")) return say("spawned");
            return callTool("spawn_threads", {
                threads: [
                    { title: "Waiter", brief: "wait" },
                    { title: "Hanger", brief: "hang job" },
                ],
            });
        });
        const lead = await newSession();
        await runHosted(lead, "go");
        const waiter = threadNamed(lead, "Waiter").sessionId;
        await until(() => teams.teamOf(waiter)?.state === "waiting", "the thread is waiting");

        teams.stopTeam(teams.teamOf(lead.id)!.teamId);
        await allTurnsEnded();

        expect(teams.teamOf(waiter)?.state).toBe("stopped");
    });
});

describe('wait_for_team until "any"', () => {
    /** A team of `self` and whoever else, and `self`'s wait. */
    async function waitAs(self: Session, timeoutSec: number) {
        const tools = teams.createTeamTools({ session: self, modelId: MODEL, cwd: dir }) as ToolSet;
        const startedAt = Date.now();
        const result = await tools.wait_for_team!.execute({ until: "any", timeoutSec }, {});
        return { result, ms: Date.now() - startedAt };
    }

    test("returns at once when nobody is working", async () => {
        const lead = await newSession();
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, "finished", "done");
        const { result, ms } = await waitAs(lead, 30);

        expect(ms).toBeLessThan(1000);
        expect(result).toContain("nothing more is coming");
    });

    test("is not ended by the lead finishing a turn: only a thread counts", async () => {
        const lead = await newSession();
        const thread = await newSession();
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, thread.id, "running");
        teams.addTeamMember(teamId, "still-busy", "running");
        teams.setMemberState(lead.id, "running");

        let settled = false;
        const waiting = waitAs(thread, 5).finally(() => (settled = true));
        await Bun.sleep(20);
        teams.moveMember(lead.id, "idle", null);
        await Bun.sleep(100);
        expect(settled).toBe(false);

        teams.moveMember("still-busy", "done", null);
        expect((await waiting).result).toContain("A thread finished");
    });

    test("a thread waiting on a working lead stays, though no other thread is left", async () => {
        const lead = await newSession();
        const thread = await newSession();
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, thread.id, "running");
        teams.setMemberState(lead.id, "running");

        let settled = false;
        const waiting = waitAs(thread, 5).finally(() => (settled = true));
        await Bun.sleep(100);
        expect(settled).toBe(false);

        teams.postTeamMessages({ teamId, from: lead.id, to: [thread.id], kind: "message", body: "the answer" });
        teams.nudgeWaiters(thread.id);
        expect((await waiting).result).toContain("the answer");
    });
});

describe("a process with no team runtime", () => {
    test("offers nothing to a session in no team, and no spawn to one in a team", async () => {
        restoreRuntime();
        const hadRuntime = teams.getTeamRuntime();
        // A server another test file left running would hold the claim.
        const restoreNone = hadRuntime ? teams.setTeamRuntimeForTests(owner, null as never) : () => {};
        const lead = await newSession();
        expect(Object.keys(teams.createTeamTools({ session: lead, modelId: MODEL, cwd: dir }))).toEqual([]);

        teams.createTeam(lead.id);
        const inTeam = Object.keys(teams.createTeamTools({ session: lead, modelId: MODEL, cwd: dir }));
        expect(inTeam).not.toContain("spawn_threads");
        expect(inTeam).toContain("send_message");
        restoreNone();
    });
});
