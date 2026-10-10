/**
 * Thread teams: the store (who is in a team, mail, the board, the cost sum),
 * and a whole run through real turns against a scripted model — a lead
 * spawns two threads, waits for them, and gets both reports back.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// Delegating mocks: bun module mocks leak across files, so each falls through
// to the real module unless this file's tests set something.
const settings: Record<string, unknown> = {};
const realSettings = await import("../src/settings");
// Captured before mocking: bun swaps the module's exports in place, so
// reading `realSettings.getSetting` later would call this mock again.
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
const { fromEntries } = await import("../src/transcript");

const MODEL = "xai/grok-build-0.1";

describe("team store", () => {
    test("a lead and its members, in the order they joined", () => {
        const teamId = teams.createTeam("lead-1");
        teams.addTeamMember(teamId, "m-a");
        teams.addTeamMember(teamId, "m-b");
        const roster = teams.listTeam(teamId);
        expect(roster.map((m) => [m.sessionId, m.role])).toEqual([
            ["lead-1", "lead"],
            ["m-a", "member"],
            ["m-b", "member"],
        ]);
        expect(teams.teamOf("m-b")).toMatchObject({ teamId, role: "member", leadId: "lead-1", state: "starting" });
        expect(teams.teamOf("nobody")).toBeNull();
        expect([...teams.teamsOf(["m-a", "nobody", "lead-1"]).keys()].sort()).toEqual(["lead-1", "m-a"]);
    });

    test("mail is one row per recipient, read once, oldest first", () => {
        const teamId = teams.createTeam("lead-2");
        teams.addTeamMember(teamId, "x");
        teams.addTeamMember(teamId, "y");
        teams.postTeamMessages({ teamId, from: "lead-2", to: ["x", "y"], kind: "message", body: "first" });
        teams.postTeamMessages({ teamId, from: "y", to: ["x"], kind: "message", body: "second" });
        expect(teams.inboxCount("x")).toBe(2);
        expect(teams.takeInbox("x").map((m) => m.body)).toEqual(["first", "second"]);
        expect(teams.takeInbox("x")).toEqual([]);
        expect(teams.takeInbox("y").map((m) => m.body)).toEqual(["first"]);
    });

    test("the board keeps the latest note per key, and an empty one removes it", () => {
        const teamId = teams.createTeam("lead-3");
        teams.postBoardNote(teamId, "lead-3", "contract", "GET /a");
        teams.postBoardNote(teamId, "lead-3", "owners", "api: src/");
        teams.postBoardNote(teamId, "lead-3", "contract", "GET /a?from&to");
        expect(teams.readBoard(teamId).map((n) => [n.key, n.body])).toEqual([
            ["contract", "GET /a?from&to"],
            ["owners", "api: src/"],
        ]);
        teams.postBoardNote(teamId, "lead-3", "owners", "");
        expect(teams.readBoard(teamId).map((n) => n.key)).toEqual(["contract"]);
    });

    test("a member's state moves, and activity clears once it finishes", () => {
        const teamId = teams.createTeam("lead-4");
        teams.addTeamMember(teamId, "w");
        expect(teams.setMemberState("w", "running", "edit a.ts")).toBe(true);
        expect(teams.teamOf("w")).toMatchObject({ state: "running", activity: "edit a.ts" });
        expect(teams.setMemberState("w", "running", "edit a.ts")).toBe(false);
        teams.setMemberState("w", "done");
        expect(teams.teamOf("w")?.activity).toBeUndefined();
    });

    test("the team's cost is every row billed to it, summed — the user's own turns in a member included", async () => {
        const manager = new SessionManager();
        const lead = await manager.create({ cwd: "/tmp", provider: "xai", model: MODEL });
        const member = await manager.create({ cwd: "/tmp", provider: "xai", model: MODEL });
        const outsider = await manager.create({ cwd: "/tmp", provider: "xai", model: MODEL });
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, member.id);
        const bill = (sessionPub: string, usd: number, source: "turn" | "team") =>
            addLedgerRow({
                provider: "xai",
                model: MODEL,
                usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
                usd,
                ctx: { source, sessionPub },
            });
        bill(lead.id, 0.1, "turn");
        bill(member.id, 0.2, "team");
        bill(member.id, 0.05, "turn"); // the user typed into the member
        bill(outsider.id, 9, "turn");
        const cost = teams.teamCost(teamId);
        expect(cost.usd).toBeCloseTo(0.35);
        expect(cost.inputTokens).toBe(300);
        expect(cost.bySession.get(member.id)?.usd).toBeCloseTo(0.25);
        expect(cost.bySession.get(member.id)?.teamUsd).toBeCloseTo(0.2);
    });
});

describe("team snapshot", () => {
    test("a thread left 'running' by a process that quit reads idle once nothing has moved for a while", async () => {
        const { getDb } = await import("../src/sessions/db");
        const teamId = teams.createTeam("lead-stale");
        teams.addTeamMember(teamId, "stuck", "running");
        teams.addTeamMember(teamId, "fresh", "running");
        getDb().run("UPDATE team_members SET updated_at = ? WHERE session_pub = ?", [Date.now() - 11 * 60_000, "stuck"]);
        const snapshot = teams.teamSnapshot(teamId)!;
        expect(snapshot.members.map((m) => [m.id, m.state])).toEqual([
            ["stuck", "idle"],
            ["fresh", "running"],
        ]);
    });
});

describe("team tools", () => {
    test("a lead's board note before its first spawn starts the team instead of bouncing", async () => {
        const lead = await new SessionManager().create({ cwd: "/tmp", provider: "xai", model: MODEL });
        const tools = teams.createTeamTools({ session: lead, modelId: MODEL, cwd: "/tmp" }) as Record<
            string,
            { execute: (input: unknown, opts: unknown) => Promise<string> }
        >;
        const out = await tools.team_board!.execute({ action: "post", key: "contract", content: "GET /x" }, {});
        expect(out).toBe('Posted "contract" to the board.');
        const team = teams.teamOf(lead.id);
        expect(team?.role).toBe("lead");
        expect(teams.readBoard(team!.teamId).map((n) => n.key)).toEqual(["contract"]);
    });
});

// ── a whole run ─────────────────────────────────────────────────────────────

type Part = Record<string, unknown>;
// The provider spec's usage shape (LanguageModelV3), not the SDK's flat one.
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
const toolCall = (id: string, toolName: string, input: unknown): Part[] => [
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const say = (text: string): Part[] => [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
];

/** Everything a model call was sent, as one searchable string. */
function promptText(call: { prompt?: unknown }): string {
    return JSON.stringify(call.prompt ?? "");
}

/** Whether the conversation already holds a result for this tool. */
function hasResult(call: { prompt?: unknown }, toolName: string): boolean {
    const prompt = (call.prompt ?? []) as Array<{ role: string; content: unknown }>;
    return prompt.some(
        (m) =>
            m.role === "tool" &&
            Array.isArray(m.content) &&
            (m.content as Array<{ toolName?: string }>).some((p) => p.toolName === toolName),
    );
}

describe("a team run, through real turns", () => {
    let dir: string;
    const running = new Map<string, Promise<void>>();
    const manager = new SessionManager();
    const owner = {};

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-teams-"));
        settings.threadTeams = true;
        // What a host does: run each delivered turn, then pick up late mail.
        teams.claimTeamRuntime(owner, {
            deliver: (sessionId, input, team) => {
                const run = (async () => {
                    const session = await manager.open(sessionId);
                    await runTurn({
                        session,
                        modelId: MODEL,
                        userInput: input,
                        cwd: dir,
                        tracker: new CostTracker(),
                        emitter: new EventEmitter() as never,
                        team,
                    });
                })().finally(() => {
                    running.delete(sessionId);
                    teams.wakeTeamInbox(sessionId);
                });
                running.set(sessionId, run);
            },
            isRunning: (sessionId) => running.has(sessionId),
            cancel: () => {},
        });
    });
    afterEach(() => {
        teams.releaseTeamRuntime(owner);
        currentModel = null;
        delete settings.threadTeams;
        running.clear();
    });

    test("the lead spawns two threads, waits, and both reports come back", async () => {
        let leadSystem = "";
        currentModel = new MockLanguageModelV3({
            doStream: async (call: any) => {
                const text = promptText(call);
                if (text.includes("You are in a thread team")) {
                    // A member: report once, then stop.
                    const mine = text.includes("do the api") ? "api done" : "ui done";
                    return stream(toolCall(`r-${mine}`, "report", { summary: mine, files: ["a.ts"] }));
                }
                leadSystem = text;
                if (!hasResult(call, "spawn_threads")) {
                    return stream(
                        toolCall("s1", "spawn_threads", {
                            threads: [
                                { title: "API", brief: "do the api" },
                                { title: "UI", brief: "do the ui" },
                            ],
                        }),
                    );
                }
                if (!hasResult(call, "wait_for_team")) {
                    return stream(toolCall("w1", "wait_for_team", { until: "all", timeoutSec: 30 }));
                }
                return stream(say("both threads finished"));
            },
        });

        const lead = await manager.create({ cwd: dir, provider: "xai", model: MODEL });
        await runTurn({
            session: lead,
            modelId: MODEL,
            userInput: "build it in parallel",
            cwd: dir,
            tracker: new CostTracker(),
            emitter: new EventEmitter() as never,
        });
        await Promise.all([...running.values()]);

        // The lead was told how teams work.
        expect(leadSystem).toContain("# Thread teams");

        const snapshot = teams.teamSnapshotForSession(lead.id)!;
        expect(snapshot.members.map((m) => [m.title, m.state])).toEqual([
            ["API", "done"],
            ["UI", "done"],
        ]);
        // A finished thread is doing nothing — not its last tool call.
        expect(snapshot.members.map((m) => m.activity)).toEqual([undefined, undefined]);

        // The wait returned both reports to the lead, as its tool result.
        const branch = lead.getBranch();
        const waitResult = JSON.stringify(
            branch
                .filter((e) => e.type === "message" && e.role === "tool")
                .map((e) => (e as { content: unknown }).content),
        );
        expect(waitResult).toContain("Every thread has finished");
        expect(waitResult).toContain("api done");
        expect(waitResult).toContain("ui done");

        // A member's first message is its brief, saved as a team card — titled
        // by the lead, so it never had to title itself.
        const api = await manager.open(snapshot.members[0]!.id);
        expect(api.getName()).toBe("API");
        const opening = api.getBranch().find((e) => e.type === "message" && e.role === "user") as {
            content: string;
            team?: { kind: string; from?: { id: string } };
        };
        expect(opening.content).toContain("do the api");
        expect(opening.team).toMatchObject({ kind: "spawn", from: { id: lead.id } });
        const transcript = fromEntries(api.getBranch());
        expect(transcript.messages[0]?.parts[0]?.type).toBe("data-team");

        // Its spend is the team's, billed as "team"; the lead's is its own.
        expect(snapshot.members[0]!.teamUsd).toBe(snapshot.members[0]!.usd);
        expect(snapshot.cost.inputTokens).toBeGreaterThan(0);
        expect(snapshot.cost.inputTokens).toBe(
            [snapshot.lead, ...snapshot.members].reduce((sum, m) => sum + m.inputTokens, 0),
        );
    });

    test("mail to a thread mid-turn reaches the model before its next step, and is saved where it arrived", async () => {
        const lead = await manager.create({ cwd: dir, provider: "xai", model: MODEL });
        const member = await manager.create({ cwd: dir, provider: "xai", model: MODEL });
        const teamId = teams.createTeam(lead.id);
        teams.addTeamMember(teamId, member.id, "running");

        let step = 0;
        let secondStepSaw = "";
        currentModel = new MockLanguageModelV3({
            doStream: async (call: any) => {
                step++;
                if (step === 1) {
                    // The lead writes while the member's first step is out.
                    teams.postTeamMessages({
                        teamId,
                        from: lead.id,
                        to: [member.id],
                        kind: "message",
                        body: "use ISO dates",
                    });
                    return stream(toolCall("l1", "ls", {}));
                }
                secondStepSaw = promptText(call);
                return stream(say("ok"));
            },
        });
        await runTurn({
            session: member,
            modelId: MODEL,
            userInput: "start",
            cwd: dir,
            tracker: new CostTracker(),
            emitter: new EventEmitter() as never,
        });

        expect(secondStepSaw).toContain("use ISO dates");
        expect(secondStepSaw).toContain("<team-message");
        expect(teams.inboxCount(member.id)).toBe(0);
        // Saved after the step it interrupted, and drawn inside that reply.
        const transcript = fromEntries(member.getBranch());
        const reply = transcript.messages.find((m) => m.role === "assistant")!;
        const kinds = reply.parts.map((p) => p.type);
        expect(kinds).toContain("data-team");
        expect(kinds.indexOf("data-team")).toBeGreaterThan(kinds.indexOf("tool-ls"));
        expect(transcript.messages.filter((m) => m.role === "user")).toHaveLength(1);
    });

    test("with the setting off, no team tool is offered", async () => {
        delete settings.threadTeams;
        settings.threadTeams = false;
        let offered: string[] = [];
        currentModel = new MockLanguageModelV3({
            doStream: async (call: any) => {
                offered = (call.tools ?? []).map((t: { name: string }) => t.name);
                return stream(say("ok"));
            },
        });
        const session = await manager.create({ cwd: dir, provider: "xai", model: MODEL });
        await runTurn({
            session,
            modelId: MODEL,
            userInput: "hi",
            cwd: dir,
            tracker: new CostTracker(),
            emitter: new EventEmitter() as never,
        });
        expect(offered).toContain("read");
        for (const name of teams.TEAM_TOOL_NAMES) expect(offered).not.toContain(name);
    });
});
