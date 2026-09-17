/**
 * Server-to-client notifications.
 *
 * The AI SDK's MCP client has no notification handling: a message with a
 * `method` and no `id` — a JSON-RPC notification, which is what every
 * list_changed, log line and progress report is — was reported as an
 * "Unsupported message type" error through `onUncaughtError`, and loop read
 * that callback as "the connection died". So a server doing something
 * completely ordinary was marked errored and had every one of its tools
 * withdrawn mid-session, while the process behind it was still running fine.
 *
 * These tests pin both halves of the fix: the connection survives, and
 * `tools/list_changed` actually re-lists instead of being ignored.
 */
import { CONFIG_DIR_NAME } from "../src/brand";
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpManager } from "../src/mcp/manager";
import { interceptNotifications, isNotificationMessage, type McpNotification } from "../src/mcp/notifications";
import { trustForSession } from "../src/agent/trust";
import type { McpServerConfig } from "../src/mcp/config";

const here = dirname(fileURLToPath(import.meta.url));
const NOTIFIER = join(here, "fixtures", "mock-mcp-notifier.mjs");

function notifier(env: Record<string, string> = {}): McpServerConfig {
    return { command: process.execPath, args: [NOTIFIER], ...(Object.keys(env).length ? { env } : {}) };
}

function project(servers: Record<string, McpServerConfig>): string {
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-notify-"));
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    trustForSession(root);
    return root;
}

function tempFile(name: string): string {
    return join(mkdtempSync(join(tmpdir(), "loop-mcp-notify-file-")), name);
}

/** Poll until `check` holds, or give up — refreshes are asynchronous by nature. */
async function eventually(check: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
}

describe("server notifications", () => {
    test("a log-only notification does not kill the connection", async () => {
        const root = project({ notifier: notifier({ MOCK_MCP_LOG_ONLY: "1" }) });
        const mgr = new McpManager();
        await mgr.init(root);
        expect(mgr.getServer("notifier")?.status).toBe("ready");
        await new Promise((r) => setTimeout(r, 300));
        // Was: status "error", error "disconnected: Unsupported message type".
        expect(mgr.getServer("notifier")?.status).toBe("ready");
        expect(mgr.getServer("notifier")?.error).toBeUndefined();
        expect(Object.keys(mgr.getTools())).toHaveLength(2);
        await mgr.close();
    });

    test("tools/list_changed re-lists: new tools appear, withdrawn ones go", async () => {
        const root = project({ notifier: notifier() });
        const mgr = new McpManager();
        await mgr.init(root);
        expect(Object.keys(mgr.getTools()).sort()).toEqual(["mcp__notifier__echo", "mcp__notifier__temp"]);

        await eventually(() => "mcp__notifier__added" in mgr.getTools());
        expect(Object.keys(mgr.getTools()).sort()).toEqual(["mcp__notifier__added", "mcp__notifier__echo"]);
        // A merge-only refresh would leave this behind, and the model would go
        // on calling a tool the server has withdrawn.
        expect(mgr.getTools()).not.toHaveProperty("mcp__notifier__temp");
        expect(mgr.getServer("notifier")?.toolCount).toBe(2);
        expect(mgr.getServer("notifier")?.status).toBe("ready");
        await mgr.close();
    });

    test("refreshed tools keep the namespacing and the timeout wrapper", async () => {
        const root = project({ notifier: notifier() });
        const mgr = new McpManager();
        await mgr.init(root);
        await eventually(() => "mcp__notifier__added" in mgr.getTools());
        const tool = mgr.getTools()["mcp__notifier__added"] as { execute?: unknown };
        expect(typeof tool?.execute).toBe("function");
        const result = (await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(
            { text: "hi" },
            {},
        )) as { content: Array<{ text: string }> };
        // The server is called with its OWN name, not the namespaced key.
        expect(result.content[0]?.text).toBe("added: hi");
        await mgr.close();
    });

    test("a burst of list_changed collapses into one extra tools/list", async () => {
        const listfile = tempFile("listcalls");
        const root = project({ notifier: notifier({ MOCK_MCP_NOTIFY_BURST: "8", MOCK_MCP_LISTFILE: listfile }) });
        const mgr = new McpManager();
        await mgr.init(root);
        await eventually(() => "mcp__notifier__added" in mgr.getTools());
        await new Promise((r) => setTimeout(r, 300));
        const calls = existsSync(listfile) ? Number(readFileSync(listfile, "utf8")) : 0;
        // One at connect, then at most one more per coalescing window — never
        // one per notification.
        expect(calls).toBeGreaterThanOrEqual(2);
        expect(calls).toBeLessThanOrEqual(3);
        await mgr.close();
    });
});

describe("notification interception", () => {
    test("classifies JSON-RPC messages by shape", () => {
        expect(isNotificationMessage({ jsonrpc: "2.0", method: "notifications/message" })).toBe(true);
        // A request has both; a response has an id and no method.
        expect(isNotificationMessage({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
        expect(isNotificationMessage({ jsonrpc: "2.0", id: 1, result: {} })).toBe(false);
        expect(isNotificationMessage(null)).toBe(false);
    });

    test("notifications are peeled off; everything else reaches the SDK handler", () => {
        const transport: { onmessage?: (m: unknown) => void } = {};
        const seen: McpNotification[] = [];
        const inner: unknown[] = [];
        expect(interceptNotifications(transport, (n) => seen.push(n))).toBe(true);
        // The SDK assigns its handler AFTER we hook, exactly as it does in its
        // constructor — the accessor has to capture that assignment.
        transport.onmessage = (m) => inner.push(m);

        transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        transport.onmessage?.({ jsonrpc: "2.0", id: 7, result: { ok: true } });

        expect(seen.map((n) => n.method)).toEqual(["notifications/tools/list_changed"]);
        expect(inner).toEqual([{ jsonrpc: "2.0", id: 7, result: { ok: true } }]);
    });

    test("a second hook re-points the handler instead of stacking", () => {
        const transport: { onmessage?: (m: unknown) => void } = {};
        const first: McpNotification[] = [];
        const second: McpNotification[] = [];
        interceptNotifications(transport, (n) => first.push(n));
        interceptNotifications(transport, (n) => second.push(n));
        transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/message" });
        expect(first).toHaveLength(0);
        expect(second).toHaveLength(1);
    });

    test("a frozen transport is not a reason to fail the connect", () => {
        const frozen = Object.freeze({ onmessage: undefined });
        expect(interceptNotifications(frozen, () => {})).toBe(false);
    });
});
