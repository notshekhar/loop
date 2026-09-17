#!/usr/bin/env node
/**
 * A stdio MCP server that uses the half of the protocol loop used to hang up
 * on: it declares `tools.listChanged` and actually sends notifications.
 *
 * Its tool list changes with each `tools/list_changed` it announces — one tool
 * disappears and another appears — so a refresh that only merges (instead of
 * replacing) is visible as a stale tool that should be gone.
 *
 * Env:
 *   MOCK_MCP_NOTIFY_BURST  how many list_changed notifications to send at once
 *                          (default 1); a burst is what a server rebuilding its
 *                          registry emits, and it's what coalescing is for.
 *   MOCK_MCP_LISTFILE      file to write the running tools/list call count to,
 *                          so a test can prove the burst was coalesced.
 *   MOCK_MCP_LOG_ONLY      send only a `notifications/message` log line, with
 *                          no list_changed at all.
 */
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const burst = Number(process.env.MOCK_MCP_NOTIFY_BURST) || 1;
const listfile = process.env.MOCK_MCP_LISTFILE;
const logOnly = Boolean(process.env.MOCK_MCP_LOG_ONLY);

let generation = 0;
let listCalls = 0;

const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

function tools() {
    // "temp" exists only before the first announcement; "added" only after.
    const names = generation === 0 ? ["echo", "temp"] : ["echo", "added"];
    return names.map((name) => ({ name, description: `${name} tool`, inputSchema: schema }));
}

rl.on("line", (line) => {
    if (!line.trim()) return;
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        return;
    }
    const { id, method, params } = req;

    if (method === "initialize") {
        send({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: params?.protocolVersion ?? "2024-11-05",
                capabilities: { tools: { listChanged: true }, logging: {} },
                serverInfo: { name: "mock-mcp-notifier", version: "0.0.0" },
            },
        });
        return;
    }
    if (method === "notifications/initialized") {
        setTimeout(() => {
            send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "ready" } });
            if (logOnly) return;
            generation += 1;
            for (let i = 0; i < burst; i++) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        }, 50);
        return;
    }
    if (method === "tools/list") {
        listCalls += 1;
        if (listfile) writeFileSync(listfile, String(listCalls));
        send({ jsonrpc: "2.0", id, result: { tools: tools() } });
        return;
    }
    if (method === "tools/call") {
        send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `${params?.name}: ${params?.arguments?.text ?? ""}` }] },
        });
        return;
    }
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
});
