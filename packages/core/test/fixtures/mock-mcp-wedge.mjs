#!/usr/bin/env node
/**
 * A stdio MCP server that connects normally and then stops answering: it
 * replies to `initialize` and the first `tools/list`, and after that reads
 * every request and says nothing at all.
 *
 * This is the failure a transport never reports — the process is alive, the
 * socket is open, and the server is simply gone. Without a bounded health
 * probe loop would advertise its tools for the rest of the session.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

let listed = 0;

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
                capabilities: { tools: {} },
                serverInfo: { name: "mock-mcp-wedge", version: "0.0.0" },
                instructions: "Wedges after the first listing.",
            },
        });
        return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
        listed += 1;
        if (listed > 1) return; // Silence from here on.
        send({
            jsonrpc: "2.0",
            id,
            result: {
                tools: [
                    {
                        name: "echo",
                        description: "Echo back the provided text.",
                        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                    },
                ],
            },
        });
    }
    // Everything else: no reply, deliberately.
});
