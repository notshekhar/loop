/**
 * cmux reporter (cmux-reporter.ts) against a real unix socket standing in for
 * cmux, asserting the exact `feed.push` frames cmux would receive for a
 * scripted turn and the decisions it can push back.
 *
 * The frames are the contract — they were read off a live cmux, so a test
 * that only checked "something was sent" would not have caught any of the
 * three things that actually mattered: a card only parks when it carries a
 * request id, cmux keys its reply by that id, and telemetry must never wait.
 * The env gate and the dead-socket path are here for the same reason they are
 * in the herdr test: outside cmux, or with cmux gone, this must be inert.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { hookBus, type HookPayload } from "@notshekhar/loop-core";
import { createAgentStatusBus } from "../src/interactive/agent-status";
import { attachTerminalTitle, setTabName } from "../src/interactive/session-title";
import { attachCmuxReporter, type CmuxReporter, type CmuxSessionRef } from "../src/interactive/cmux-reporter";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll instead of sleeping: socket round-trips land when they land. */
async function until<T>(read: () => T | undefined, deadlineMs = 5_000): Promise<T> {
    const end = Date.now() + deadlineMs;
    for (;;) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() > end) throw new Error("timed out waiting for cmux");
        await tick(25);
    }
}

type Frame = { id: string; method: string; params: { event: Record<string, unknown>; wait_timeout_seconds: number } };

/**
 * Line-delimited JSON-RPC server that behaves the way cmux does: a push with
 * `_opencode_request_id` parks (no reply until the test answers it), anything
 * else is acked as telemetry straight away.
 */
function fakeCmux(socketPath: string) {
    const frames: Frame[] = [];
    /** The line-delimited V1 commands (set_status, notify_target, …). */
    const commands: string[] = [];
    const parked = new Map<string, { write: (s: string) => void; id: string }>();
    const server = Bun.listen({
        unix: socketPath,
        socket: {
            data(socket, data) {
                for (const line of data.toString().split("\n")) {
                    if (!line.trim()) continue;
                    // Two protocols share this socket: JSON feed frames, and
                    // plain V1 command lines carrying the pane capability.
                    if (!line.startsWith("{")) {
                        commands.push(line);
                        socket.write("OK\n");
                        continue;
                    }
                    const frame = JSON.parse(line) as Frame;
                    frames.push(frame);
                    const requestId = frame.params.event._opencode_request_id as string | undefined;
                    if (requestId) {
                        parked.set(requestId, { write: (s) => socket.write(s), id: frame.id });
                        continue;
                    }
                    socket.write(`${JSON.stringify({ id: frame.id, ok: true, result: { status: "acknowledged" } })}\n`);
                }
            },
        },
    });
    return {
        frames,
        commands,
        /** V1 commands with the capability prefix stripped, for readability. */
        v1: () => commands.map((c) => c.replace(/^_cmux_capability_v1 \S+ /, "")),
        events: () => frames.map((f) => f.params.event),
        /** Answer a parked card the way a click in cmux's sidebar would. */
        resolve(requestId: string, decision: Record<string, unknown>) {
            const waiter = parked.get(requestId);
            if (!waiter) throw new Error(`no parked card for ${requestId}`);
            parked.delete(requestId);
            waiter.write(`${JSON.stringify({ id: waiter.id, ok: true, result: { status: "resolved", decision } })}\n`);
        },
        parkedIds: () => [...parked.keys()],
        stop: () => server.stop(true),
    };
}

const cmuxEnv = (socketPath: string): NodeJS.ProcessEnv => ({
    CMUX_SOCKET_PATH: socketPath,
    CMUX_SURFACE_ID: "surface-1",
    CMUX_WORKSPACE_ID: "workspace-1",
});

/** What runHooks pushes onto the bus for one event. */
const hook = (name: string, extra: Record<string, unknown> = {}): HookPayload =>
    ({ cwd: () => "/repo", hook_event_name: name, session_id: "s1", ...extra }) as HookPayload;

describe("cmux reporter", () => {
    let dir: string | undefined;
    let stopServer: (() => void) | undefined;
    let reporter: CmuxReporter | undefined;

    afterEach(async () => {
        // Release first: it unsubscribes from the process-wide hook bus, which
        // would otherwise leak this test's listener into the next one.
        await reporter?.release();
        reporter = undefined;
        stopServer?.();
        stopServer = undefined;
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    function start(server: ReturnType<typeof fakeCmux>, socketPath: string): CmuxReporter {
        reporter = attachCmuxReporter(null, {
            getSession: () => ({ id: "abc123", path: "/tmp/abc123.jsonl" }),
            cwd: () => "/repo",
            env: cmuxEnv(socketPath),
            decisionWaitSeconds: 2,
            connectTimeoutMs: 100,
        });
        expect(reporter.active).toBe(true);
        return reporter;
    }

    test("forwards loop's hook events as feed telemetry", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;
        start(server, socketPath);

        hookBus.emit("event", hook("SessionStart"));
        hookBus.emit("event", hook("UserPromptSubmit", { prompt: "ship the cmux bridge" }));
        hookBus.emit("event", hook("PreToolUse", { tool_name: "bash", tool_input: { command: "bun test" } }));
        hookBus.emit("event", hook("PostToolUse", { tool_name: "bash", tool_output: "12 pass" }));
        hookBus.emit("event", hook("Stop", { last_assistant_message: "done", stop_hook_active: false }));
        await tick(120);

        const events = server.events();
        expect(events.map((e) => e.hook_event_name)).toEqual([
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Stop",
        ]);
        // Every frame carries the pane and the session, under loop's own name.
        for (const e of events) {
            expect(e._source).toBe("loop");
            expect(e.session_id).toBe("loop-abc123");
            expect(e.surface_id).toBe("surface-1");
            expect(e.workspace_id).toBe("workspace-1");
        }
        // Telemetry never asks cmux to park.
        expect(server.frames.every((f) => f.params.wait_timeout_seconds === 0)).toBe(true);
        expect(events[1].tool_input).toEqual({ prompt: "ship the cmux bridge" });
        expect(events[2].tool_input).toEqual({ command: "bun test" });
        expect(events[3].tool_result).toBe("12 pass");
        expect(events[4].last_assistant_message).toBe("done");
        // The prompt rides along as context, so a card seen on a phone says
        // what it is for.
        expect(events[2].context).toEqual({ lastUserMessage: "ship the cmux bridge" });
    });

    test("events before the first session are replayed into it, not beside it", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;

        // loop has no session until the first turn — SessionStart fires before it.
        let session: CmuxSessionRef | null = null;
        reporter = attachCmuxReporter(null, {
            getSession: () => session,
            cwd: () => "/repo",
            env: cmuxEnv(socketPath),
        });

        hookBus.emit("event", hook("SessionStart"));
        await tick(80);
        expect(server.events()).toHaveLength(0); // held, not filed under the pane

        session = { id: "abc123", path: null };
        hookBus.emit("event", hook("UserPromptSubmit", { prompt: "go" }));
        await tick(120);

        const events = server.events();
        expect(events.map((e) => e.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit"]);
        // One workstream for the launch, the session's own.
        expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(["loop-abc123"]));
    });

    test("the sidebar chip and the notifications follow the agent's state", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;

        const bus = createAgentStatusBus(10);
        reporter = attachCmuxReporter(bus, {
            getSession: () => ({ id: "abc123", path: null }),
            cwd: () => "/repo/widgets",
            env: cmuxEnv(socketPath),
        });

        bus.setWorking();
        const closeModal = bus.modalOpened("bash approval");
        await tick(60);
        closeModal();
        bus.setIdle();
        await tick(80);

        const v1 = server.v1();
        // Launch announce, then working, then blocked (floated to the top of
        // the sidebar), then idle once the settle window passes.
        expect(v1[0]).toBe(
            "set_status loop Idle --icon=pause.circle.fill --color=#8E8E93 --tab=workspace-1 --panel=surface-1",
        );
        expect(v1).toContain(
            "set_status loop Working --icon=bolt.fill --color=#4C8DFF --tab=workspace-1 --panel=surface-1",
        );
        expect(v1).toContain(
            "set_status loop bash approval --icon=bell.fill --color=#4C8DFF --priority=100 --tab=workspace-1 --panel=surface-1",
        );
        // A prompt the agent is stuck on also rings, in cmux's own category so
        // the user's notification settings govern it.
        expect(v1).toContain("notify_target workspace-1 surface-1 loop|widgets|bash approval|c=needs-permission;p=1");

        // The end of a turn is the notification people actually wait for.
        hookBus.emit("event", hook("Stop", { last_assistant_message: "shipped it" }));
        await tick(80);
        expect(server.v1()).toContain(
            "notify_target workspace-1 surface-1 loop|widgets|shipped it|c=turn-complete;p=0",
        );

        // Nothing of ours is left in the sidebar after loop exits. The V1
        // channel is fire-and-forget, so wait for the line rather than for a
        // promise that never described its delivery.
        await reporter.release();
        reporter = undefined;
        const cleared = await until(() =>
            server.v1().includes("clear_status loop --tab=workspace-1 --panel=surface-1") ? true : undefined,
        );
        expect(cleared).toBe(true);
    });

    test("a multi-line answer cannot break the wire", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;
        const bus = createAgentStatusBus(10);
        reporter = attachCmuxReporter(bus, {
            getSession: () => ({ id: "abc123", path: null }),
            cwd: () => "/repo",
            env: cmuxEnv(socketPath),
        });

        // Newlines end a V1 command and `|` ends a notification field: an
        // assistant reply carrying either would truncate or forge the rest.
        hookBus.emit("event", hook("Stop", { last_assistant_message: "line one\nline two | still body\n--flag" }));
        await tick(80);

        const notif = server.v1().find((c) => c.startsWith("notify_target"));
        expect(notif).toBeDefined();
        expect(notif!.split("\n")).toHaveLength(1);
        expect(notif).toContain("line one line two / still body —flag");
        expect(notif!.split("|")).toHaveLength(4); // title, subtitle, body, meta
    });

    test("the todo list also goes out as cmux's TodoWrite", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;
        start(server, socketPath);

        const todos = [{ content: "wire the bridge", status: "in_progress" }];
        hookBus.emit("event", hook("PostToolUse", { tool_name: "todo", tool_input: { todos } }));
        await tick(120);

        const events = server.events();
        expect(events.map((e) => e.hook_event_name)).toEqual(["PostToolUse", "TodoWrite"]);
        expect(events[1].tool_input).toEqual({ todos });
    });

    test("an approval parks until cmux answers, and the answer comes back", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;
        const r = start(server, socketPath);

        const pending = r.requestApproval({
            kind: "bash",
            toolName: "bash",
            body: "rm -rf build",
            patterns: ["rm:*"],
        });
        await tick(50);

        const [id] = server.parkedIds();
        expect(id).toBeDefined();
        const card = server.events()[0];
        expect(card.hook_event_name).toBe("PermissionRequest");
        expect(card.tool_name).toBe("bash");
        expect(card.tool_input).toMatchObject({ command: "rm -rf build", patterns: ["rm:*"] });
        expect(server.frames[0].params.wait_timeout_seconds).toBe(2);

        server.resolve(id!, { kind: "permission", mode: "always" });
        expect(await pending).toEqual({ kind: "permission", mode: "always" });
    });

    test("a plan approval is an ExitPlanMode card", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;
        const r = start(server, socketPath);

        const pending = r.requestApproval({ kind: "exit-plan", toolName: "exit_plan_mode", body: "# Plan\n- one" });
        await tick(50);
        const card = server.events()[0];
        expect(card.hook_event_name).toBe("ExitPlanMode");
        expect(card.tool_input).toEqual({ plan: "# Plan\n- one" });

        server.resolve(server.parkedIds()[0]!, { kind: "exit_plan", mode: "manual" });
        expect(await pending).toEqual({ kind: "exit_plan", mode: "manual" });
    });

    test("questions go as one card and come back as selections", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;
        const r = start(server, socketPath);

        const pending = r.requestQuestions([
            { header: "Scope", question: "How far?", options: [{ label: "Small" }, { label: "Big" }] },
        ]);
        await tick(50);
        const card = server.events()[0];
        expect(card.hook_event_name).toBe("AskUserQuestion");
        expect(card.tool_input).toEqual({
            questions: [
                {
                    id: "q0",
                    header: "Scope",
                    question: "How far?",
                    multiSelect: false,
                    options: [
                        { id: "opt0", label: "Small", description: undefined },
                        { id: "opt1", label: "Big", description: undefined },
                    ],
                },
            ],
        });

        server.resolve(server.parkedIds()[0]!, { kind: "question", selections: ["Big"] });
        expect(await pending).toEqual(["Big"]);
    });

    test("the TUI answering first withdraws the card", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;
        const r = start(server, socketPath);

        const abort = new AbortController();
        const pending = r.requestApproval({ kind: "bash", toolName: "bash", body: "ls" }, abort.signal);
        await tick(50);
        abort.abort(); // the on-screen menu was answered
        expect(await pending).toBeNull();
    });

    test("nobody answers: the card times out and the prompt stays the TUI's", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "cmux.sock");
        const server = fakeCmux(socketPath);
        stopServer = server.stop;
        reporter = attachCmuxReporter(null, {
            getSession: () => ({ id: "abc123", path: null }),
            cwd: () => "/repo",
            env: cmuxEnv(socketPath),
            decisionWaitSeconds: 0.05,
            connectTimeoutMs: 10,
        });
        expect(await reporter.requestApproval({ kind: "bash", toolName: "bash", body: "ls" })).toBeNull();
    });

    test("inert outside cmux: no socket traffic, no subscription", () => {
        const before = hookBus.listenerCount("event");
        const inert = attachCmuxReporter(null, { getSession: () => null, cwd: () => "/repo", env: {} });
        expect(inert.active).toBe(false);
        expect(hookBus.listenerCount("event")).toBe(before);

        // A socket path alone is not a cmux pane — the surface id is.
        expect(
            attachCmuxReporter(null, {
                getSession: () => null,
                cwd: () => "/repo",
                env: { CMUX_SOCKET_PATH: "/tmp/x.sock" },
            }).active,
        ).toBe(false);
        // Setting opt-out wins even inside cmux.
        expect(
            attachCmuxReporter(null, {
                getSession: () => null,
                cwd: () => "/repo",
                disabled: true,
                env: cmuxEnv("/tmp/x.sock"),
            }).active,
        ).toBe(false);
    });

    test("dead socket: telemetry and decisions resolve without throwing", async () => {
        dir = mkdtempSync(join(tmpdir(), "cmux-test-"));
        const socketPath = join(dir, "gone.sock"); // never listened on
        reporter = attachCmuxReporter(null, {
            getSession: () => ({ id: "abc123", path: null }),
            cwd: () => "/repo",
            env: cmuxEnv(socketPath),
            decisionWaitSeconds: 1,
            connectTimeoutMs: 20,
        });
        expect(reporter.active).toBe(true);
        hookBus.emit("event", hook("SessionStart"));
        expect(await reporter.requestApproval({ kind: "bash", toolName: "bash", body: "ls" })).toBeNull();
        await reporter.release(); // resolves despite no server
    });
});

describe("terminal title", () => {
    /** A TUI stand-in that just records what the tab was told. */
    const fakeDeps = () => {
        const titles: string[] = [];
        return { deps: { tui: { setTitle: (t: string) => titles.push(t) } } as never, titles };
    };

    test("the tab carries the session's name and what loop is doing", async () => {
        const { deps, titles } = fakeDeps();
        const bus = createAgentStatusBus(10);
        const stop = attachTerminalTitle(bus, deps, "Fix the pty test");
        // Idle is the name alone: an idle pane should read as itself.
        expect(titles).toEqual(["Fix the pty test"]);

        bus.setWorking();
        await tick(60);
        // Spinning: same name, a frame in front, and it actually animates.
        expect(titles.at(-1)).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Fix the pty test$/);
        const frames = new Set(titles.filter((t) => t.endsWith("Fix the pty test")).map((t) => t[0]));
        expect(frames.size).toBeGreaterThan(1);

        const close = bus.modalOpened("bash approval");
        await tick(30);
        expect(titles.at(-1)).toBe("◆ Fix the pty test");

        close();
        bus.setIdle();
        await tick(60);
        expect(titles.at(-1)).toBe("Fix the pty test");

        // Nothing keeps painting once it is stopped.
        stop();
        const settled = titles.length;
        await tick(60);
        expect(titles.length).toBe(settled);
        expect(titles.at(-1)).toBe("Fix the pty test");
    });

    test("exiting mid-turn leaves a plain name, not a spinner frame", async () => {
        const { deps, titles } = fakeDeps();
        const bus = createAgentStatusBus(10);
        const stop = attachTerminalTitle(bus, deps, "Fix the pty test");
        bus.setWorking();
        await tick(40);
        expect(titles.at(-1)).not.toBe("Fix the pty test"); // spinning
        stop();
        expect(titles.at(-1)).toBe("Fix the pty test");
    });

    test("renaming keeps the state glyph that is showing", async () => {
        const { deps, titles } = fakeDeps();
        const bus = createAgentStatusBus(10);
        const stop = attachTerminalTitle(bus, deps, "loop");
        bus.setWorking();
        await tick(40);
        // The title arrives from the model mid-turn; the spinner must survive it.
        setTabName(deps, "Add cmux status reporting");
        await tick(60);
        expect(titles.at(-1)).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Add cmux status reporting$/);
        stop();
        expect(titles.at(-1)).toBe("Add cmux status reporting");
    });
});
