/**
 * Orca reporter (orca-reporter.ts) against a real HTTP server standing in for
 * Orca's hook listener, asserting the exact requests Orca would receive: the
 * route, the token header, the pane envelope and Claude Code's field names —
 * the shape Orca's Claude-compatible normalizer reads for `/hook/loop`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookBus, type HookPayload } from "@notshekhar/loop-core";
import { createAgentStatusBus } from "../src/interactive/agent-status";
import { attachOrcaReporter, type OrcaReporter } from "../src/interactive/orca-reporter";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | undefined, deadlineMs = 5_000): Promise<T> {
    const end = Date.now() + deadlineMs;
    for (;;) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() > end) throw new Error("timed out waiting for Orca");
        await tick(20);
    }
}

type Received = { path: string; token: string | null; body: { paneKey: string; payload: Record<string, unknown> } & Record<string, unknown> };

function fakeOrca() {
    const received: Received[] = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
            received.push({
                path: new URL(req.url).pathname,
                token: req.headers.get("x-orca-agent-hook-token"),
                body: (await req.json()) as Received["body"],
            });
            return new Response(null, { status: 204 });
        },
    });
    return {
        received,
        port: String(server.port),
        events: () => received.map((r) => r.body.payload),
        stop: () => server.stop(true),
    };
}

const orcaEnv = (port: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ORCA_PANE_KEY: "tab-1:pane-1",
    ORCA_AGENT_HOOK_PORT: port,
    ORCA_AGENT_HOOK_TOKEN: "secret",
    ORCA_TAB_ID: "tab-1",
    ORCA_WORKTREE_ID: "wt-1",
    ...extra,
});

const hook = (name: string, extra: Record<string, unknown> = {}): HookPayload =>
    ({ cwd: "/repo", hook_event_name: name, ...extra }) as HookPayload;

describe("orca reporter", () => {
    let reporter: OrcaReporter | undefined;
    let stop: (() => void) | undefined;
    let dir: string | undefined;

    afterEach(async () => {
        await reporter?.release();
        reporter = undefined;
        stop?.();
        stop = undefined;
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    test("outside Orca it is inert", () => {
        reporter = attachOrcaReporter(null, { getSessionId: () => "s1", cwd: () => "/repo", env: {} });
        expect(reporter.active).toBe(false);
    });

    test("posts a turn to /hook/loop in Claude's field names, in order", async () => {
        const orca = fakeOrca();
        stop = orca.stop;
        reporter = attachOrcaReporter(null, { getSessionId: () => "abc123", cwd: () => "/repo", env: orcaEnv(orca.port) });

        hookBus.emit("event", hook("UserPromptSubmit", { prompt: "fix the build" }));
        hookBus.emit("event", hook("PreToolUse", { tool_name: "bash", tool_input: { command: "bun test" } }));
        hookBus.emit("event", hook("PostToolUse", { tool_name: "bash", tool_output: "12 pass" }));
        hookBus.emit("event", hook("Stop", { last_assistant_message: "Build is green." }));
        await until(() => (orca.received.length >= 4 ? true : undefined));

        expect(orca.received.every((r) => r.path === "/hook/loop" && r.token === "secret")).toBe(true);
        expect(orca.received[0].body).toMatchObject({ paneKey: "tab-1:pane-1", tabId: "tab-1", worktreeId: "wt-1" });
        expect(orca.events()).toEqual([
            { hook_event_name: "UserPromptSubmit", cwd: "/repo", session_id: "abc123", prompt: "fix the build" },
            {
                hook_event_name: "PreToolUse",
                cwd: "/repo",
                session_id: "abc123",
                tool_name: "bash",
                tool_input: { command: "bun test" },
            },
            {
                hook_event_name: "PostToolUse",
                cwd: "/repo",
                session_id: "abc123",
                tool_name: "bash",
                tool_input: undefined,
                tool_response: "12 pass",
            },
            {
                hook_event_name: "Stop",
                cwd: "/repo",
                session_id: "abc123",
                last_assistant_message: "Build is green.",
                stop_hook_active: false,
            },
        ]);
    });

    test("a prompt the agent is blocked on reads as a permission request", async () => {
        const orca = fakeOrca();
        stop = orca.stop;
        const bus = createAgentStatusBus(10);
        reporter = attachOrcaReporter(bus, { getSessionId: () => "abc123", cwd: () => "/repo", env: orcaEnv(orca.port) });

        bus.setWorking();
        bus.modalOpened("bash approval");
        const request = await until(() => orca.events().find((e) => e.hook_event_name === "PermissionRequest"));

        expect(request).toEqual({
            hook_event_name: "PermissionRequest",
            session_id: "abc123",
            cwd: "/repo",
            tool_name: "bash approval",
        });
    });

    test("the endpoint file wins over the env, so a restarted Orca is still reached", async () => {
        const orca = fakeOrca();
        stop = orca.stop;
        dir = mkdtempSync(join(tmpdir(), "orca-test-"));
        const endpoint = join(dir, "endpoint.env");
        writeFileSync(endpoint, `ORCA_AGENT_HOOK_PORT=${orca.port}\nORCA_AGENT_HOOK_TOKEN=rotated\n`);
        // The env still names the listener Orca had when this pane started.
        reporter = attachOrcaReporter(null, {
            getSessionId: () => "abc123",
            cwd: () => "/repo",
            env: orcaEnv("1", { ORCA_AGENT_HOOK_ENDPOINT: endpoint }),
        });

        hookBus.emit("event", hook("UserPromptSubmit", { prompt: "go" }));
        const got = await until(() => orca.received[0]);

        expect(got.token).toBe("rotated");
    });
});
