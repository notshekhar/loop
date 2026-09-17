#!/usr/bin/env node
/**
 * A stdio MCP server whose tool asks the USER a question before it answers —
 * the `elicitation/create` flow. The tool call does not resolve until the
 * client replies, which is exactly why an unanswered request is a hang rather
 * than an error.
 *
 * Env:
 *   MOCK_MCP_ELICIT_SCHEMA  "fields" (default) or "confirm" (no properties)
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const mode = process.env.MOCK_MCP_ELICIT_SCHEMA ?? "fields";

/** tools/call id → the elicitation id we are waiting on. */
const pending = new Map();
let nextId = 1000;

const SCHEMAS = {
    fields: {
        type: "object",
        properties: {
            environment: { type: "string", enum: ["staging", "production"], enumNames: ["Staging", "Production"] },
            replicas: { type: "integer", minimum: 1, maximum: 9 },
            note: { type: "string", description: "Anything to record" },
        },
        required: ["environment"],
    },
    confirm: { type: "object", properties: {} },
};

rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    const { id, method, params, result } = msg;

    if (method === "initialize") {
        send({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: params?.protocolVersion ?? "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "mock-mcp-elicit", version: "0.0.0" },
            },
        });
        return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
        send({
            jsonrpc: "2.0",
            id,
            result: {
                tools: [{ name: "deploy", description: "Deploy, asking first.", inputSchema: { type: "object", properties: {} } }],
            },
        });
        return;
    }
    if (method === "tools/call") {
        const elicitId = nextId++;
        pending.set(elicitId, id);
        send({
            jsonrpc: "2.0",
            id: elicitId,
            method: "elicitation/create",
            params: { message: "Where should this deploy go?", requestedSchema: SCHEMAS[mode] },
        });
        return;
    }
    // The client's reply to our elicitation: finish the tool call with it.
    if (id !== undefined && pending.has(id)) {
        const callId = pending.get(id);
        pending.delete(id);
        send({
            jsonrpc: "2.0",
            id: callId,
            result: { content: [{ type: "text", text: `elicited: ${JSON.stringify(result ?? msg.error ?? null)}` }] },
        });
        return;
    }
    if (id !== undefined && method) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
});
