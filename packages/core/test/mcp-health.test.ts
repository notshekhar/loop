/**
 * Staying connected: health probes, automatic reconnect, and the server
 * instructions loop used to throw away.
 *
 * Two failures motivated all of this. A server that DIES mid-session was
 * marked errored and then sat there — the only cure was noticing and running
 * `/mcp reconnect`, and the way people noticed was the model failing to call
 * its tools. A server that WEDGES (process alive, socket open, no replies) was
 * never even marked: the transport has nothing to report, so loop advertised
 * its tools for the rest of the session and every call failed.
 */
import { CONFIG_DIR_NAME } from "../src/brand";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpManager } from "../src/mcp/manager";
import { buildMcpInstructionsNote } from "../src/agent/system-prompt";
import { trustForSession } from "../src/agent/trust";
import type { McpServerConfig } from "../src/mcp/config";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "fixtures", "mock-mcp-server.mjs");
const WEDGE = join(here, "fixtures", "mock-mcp-wedge.mjs");

function project(servers: Record<string, McpServerConfig>): string {
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-health-"));
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    trustForSession(root);
    return root;
}

function tempPidfile(): string {
    return join(mkdtempSync(join(tmpdir(), "loop-mcp-health-pid-")), "pid");
}

function readPid(path: string): number {
    return Number(readFileSync(path, "utf8").trim());
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function eventually(check: () => boolean, ms = 6000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
}

const savedEnv = { ...process.env };
beforeEach(() => {
    // Probes are bounded by an env-read timeout precisely so a test does not
    // have to wait the production ten seconds to watch one give up.
    process.env.LOOP_MCP_PROBE_TIMEOUT_MS = "300";
    // No background timer: every probe in here is driven explicitly.
    process.env.LOOP_MCP_HEALTH_INTERVAL_MS = "0";
});
afterEach(() => {
    process.env.LOOP_MCP_PROBE_TIMEOUT_MS = savedEnv.LOOP_MCP_PROBE_TIMEOUT_MS;
    process.env.LOOP_MCP_HEALTH_INTERVAL_MS = savedEnv.LOOP_MCP_HEALTH_INTERVAL_MS;
});

describe("health probes", () => {
    test("a healthy server passes and keeps its tools", async () => {
        const mgr = new McpManager();
        await mgr.init(project({ good: { command: process.execPath, args: [MOCK] } }));
        await mgr.checkHealth();
        expect(mgr.getServer("good")?.status).toBe("ready");
        expect(Object.keys(mgr.getTools()).length).toBeGreaterThan(0);
        await mgr.close();
    });

    test("a wedged server is caught, and its tools are withdrawn", async () => {
        const mgr = new McpManager();
        await mgr.init(project({ wedged: { command: process.execPath, args: [WEDGE] } }));
        expect(mgr.getServer("wedged")?.status).toBe("ready");
        expect(Object.keys(mgr.getTools())).toContain("mcp__wedged__echo");

        // The process is alive and the socket is open — only the probe can tell.
        await mgr.checkHealth();
        expect(mgr.getServer("wedged")?.status).toBe("error");
        expect(mgr.getServer("wedged")?.error).toContain("health probe timed out");
        // Leaving these in place is what had the model calling tools that
        // could only fail.
        expect(mgr.getTools()).not.toHaveProperty("mcp__wedged__echo");
        await mgr.close();
    });

    test("one wedged server does not stop the others being checked", async () => {
        const mgr = new McpManager();
        await mgr.init(
            project({
                wedged: { command: process.execPath, args: [WEDGE] },
                good: { command: process.execPath, args: [MOCK] },
            }),
        );
        const started = Date.now();
        await mgr.checkHealth();
        // Sequential probing would cost the timeout before `good` was reached.
        expect(Date.now() - started).toBeLessThan(2000);
        expect(mgr.getServer("wedged")?.status).toBe("error");
        expect(mgr.getServer("good")?.status).toBe("ready");
        await mgr.close();
    });

    test("a disabled or failed server is not probed", async () => {
        const mgr = new McpManager();
        await mgr.init(project({ broken: { command: process.execPath, args: [join(here, "fixtures", "nope.mjs")] } }));
        expect(mgr.getServer("broken")?.status).toBe("error");
        // Nothing to probe, nothing to throw.
        await mgr.checkHealth();
        expect(mgr.getServer("broken")?.status).toBe("error");
        await mgr.close();
    });
});

describe("automatic reconnect", () => {
    test("a server that dies mid-session comes back on its own", async () => {
        const pidfile = tempPidfile();
        const mgr = new McpManager();
        await mgr.init(
            project({ flaky: { command: process.execPath, args: [MOCK], env: { MOCK_MCP_PIDFILE: pidfile } } }),
        );
        expect(mgr.getServer("flaky")?.status).toBe("ready");

        const firstPid = readPid(pidfile);
        process.kill(firstPid, "SIGKILL");
        await eventually(() => mgr.getServer("flaky")?.status === "error");
        expect(mgr.getTools()).not.toHaveProperty("mcp__flaky__echo");

        // No user action: the first backoff step is a second.
        await eventually(() => mgr.getServer("flaky")?.status === "ready");
        expect(mgr.getServer("flaky")?.status).toBe("ready");
        expect(mgr.getTools()).toHaveProperty("mcp__flaky__echo");
        // A genuinely new process, not the corpse of the old one.
        const secondPid = readPid(pidfile);
        expect(secondPid).not.toBe(firstPid);
        expect(isAlive(secondPid)).toBe(true);
        await mgr.close();
    }, 15000);

    test("removing a server cancels its pending reconnect", async () => {
        const pidfile = tempPidfile();
        const mgr = new McpManager();
        await mgr.init(
            project({ flaky: { command: process.execPath, args: [MOCK], env: { MOCK_MCP_PIDFILE: pidfile } } }),
        );
        process.kill(readPid(pidfile), "SIGKILL");
        await eventually(() => mgr.getServer("flaky")?.status === "error");

        await mgr.forget("flaky");
        // Long enough for the scheduled retry to have fired.
        await new Promise((r) => setTimeout(r, 1500));
        // A retry that resurrects a server the user just removed is a bug with
        // a subprocess attached.
        expect(mgr.getServer("flaky")).toBeUndefined();
        await mgr.close();
    }, 15000);

    test("close() leaves no timer running", async () => {
        const pidfile = tempPidfile();
        const mgr = new McpManager();
        await mgr.init(
            project({ flaky: { command: process.execPath, args: [MOCK], env: { MOCK_MCP_PIDFILE: pidfile } } }),
        );
        process.kill(readPid(pidfile), "SIGKILL");
        await eventually(() => mgr.getServer("flaky")?.status === "error");
        await mgr.close();
        await new Promise((r) => setTimeout(r, 1500));
        // Nothing came back, and nothing is holding the event loop open.
        expect(mgr.listServers()).toEqual([]);
    }, 15000);
});

describe("server instructions", () => {
    test("a connected server's instructions are captured and attributed", async () => {
        const mgr = new McpManager();
        await mgr.init(project({ wedged: { command: process.execPath, args: [WEDGE] } }));
        const note = buildMcpInstructionsNote(mgr.listServers());
        expect(note).toContain("Wedges after the first listing.");
        // Attribution matters: two servers' instructions are not
        // interchangeable, and an unattributed blob reads as loop's own rules.
        expect(note).toContain('From MCP server "wedged"');
        expect(note).toContain("mcp__wedged__*");
        await mgr.close();
    });

    test("servers without instructions contribute nothing at all", () => {
        expect(buildMcpInstructionsNote([{ name: "a" }, { name: "b", instructions: "   " }])).toBe("");
    });

    test("a fixture with no instructions does not fabricate any", async () => {
        const mgr = new McpManager();
        await mgr.init(project({ plain: { command: process.execPath, args: [MOCK] } }));
        expect(buildMcpInstructionsNote(mgr.listServers())).toBe("");
        await mgr.close();
    });
});

/** The broken-server test needs a path that really isn't there. */
test("the missing fixture used above does not exist", () => {
    expect(existsSync(join(here, "fixtures", "nope.mjs"))).toBe(false);
});
