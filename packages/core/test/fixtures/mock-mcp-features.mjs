#!/usr/bin/env node
/**
 * A stdio MCP server that publishes resources, resource templates and prompts
 * as well as tools — the half of the protocol loop could not see.
 *
 * It records every method it is asked for in MOCK_MCP_CALLFILE, which is how
 * the capability-gating tests prove that a server declaring only `tools` is
 * never asked for `resources/list` (a server that doesn't implement it answers
 * with a method-not-found, so asking anyway is an error per connect).
 *
 * Env:
 *   MOCK_MCP_CAPS       comma-separated: tools,resources,prompts,completions
 *                       (default: all four)
 *   MOCK_MCP_CALLFILE   file to append every received method to, one per line
 *   MOCK_MCP_PAGED      serve resources in two pages, to exercise pagination
 */
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const caps = (process.env.MOCK_MCP_CAPS ?? "tools,resources,prompts,completions").split(",").filter(Boolean);
const has = (name) => caps.includes(name);
const callfile = process.env.MOCK_MCP_CALLFILE;
const paged = Boolean(process.env.MOCK_MCP_PAGED);

const RESOURCES = [
    { uri: "notes://standup", name: "standup", description: "Today's standup notes", mimeType: "text/plain" },
    { uri: "notes://roadmap", name: "roadmap", title: "Roadmap", mimeType: "text/markdown", size: 42 },
    { uri: "blob://logo", name: "logo", mimeType: "image/png" },
];

const TEMPLATES = [
    {
        uriTemplate: "notes://{date}/journal",
        name: "journal",
        description: "One day's journal entry",
        mimeType: "text/plain",
    },
];

const PROMPTS = [
    {
        name: "review",
        description: "Review a diff with a house style",
        arguments: [
            { name: "path", description: "File to review", required: true },
            { name: "tone", description: "blunt or gentle" },
        ],
    },
    { name: "summarize", description: "Summarize the session" },
];

function capabilities() {
    const out = {};
    if (has("tools")) out.tools = { listChanged: true };
    if (has("resources")) out.resources = { subscribe: true, listChanged: true };
    if (has("prompts")) out.prompts = { listChanged: true };
    if (has("completions")) out.completions = {};
    return out;
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
    if (callfile && method) appendFileSync(callfile, `${method}\n`);

    if (method === "initialize") {
        send({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: params?.protocolVersion ?? "2024-11-05",
                capabilities: capabilities(),
                serverInfo: { name: "mock-mcp-features", version: "0.0.0" },
                instructions: "Call the echo tool for echoes. Notes live under notes://.",
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
                tools: [
                    {
                        name: "echo",
                        description: "Echo back the provided text.",
                        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                    },
                ],
            },
        });
        return;
    }
    if (method === "tools/call") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } });
        return;
    }

    if (method === "resources/list") {
        if (!paged) {
            send({ jsonrpc: "2.0", id, result: { resources: RESOURCES } });
            return;
        }
        // Two pages: the cursor is the index of the next one.
        const cursor = params?.cursor;
        if (!cursor) {
            send({ jsonrpc: "2.0", id, result: { resources: RESOURCES.slice(0, 2), nextCursor: "page2" } });
        } else {
            send({ jsonrpc: "2.0", id, result: { resources: RESOURCES.slice(2) } });
        }
        return;
    }
    if (method === "resources/templates/list") {
        send({ jsonrpc: "2.0", id, result: { resourceTemplates: TEMPLATES } });
        return;
    }
    if (method === "resources/read") {
        const uri = params?.uri;
        if (uri === "blob://logo") {
            send({
                jsonrpc: "2.0",
                id,
                result: { contents: [{ uri, mimeType: "image/png", blob: Buffer.from("not really a png").toString("base64") }] },
            });
            return;
        }
        const known = RESOURCES.find((r) => r.uri === uri);
        if (!known) {
            send({ jsonrpc: "2.0", id, error: { code: -32002, message: `resource not found: ${uri}` } });
            return;
        }
        send({
            jsonrpc: "2.0",
            id,
            result: { contents: [{ uri, mimeType: known.mimeType, text: `contents of ${known.name}` }] },
        });
        return;
    }

    if (method === "prompts/list") {
        send({ jsonrpc: "2.0", id, result: { prompts: PROMPTS } });
        return;
    }
    if (method === "prompts/get") {
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (!PROMPTS.some((p) => p.name === name)) {
            send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown prompt: ${name}` } });
            return;
        }
        send({
            jsonrpc: "2.0",
            id,
            result: {
                description: `the ${name} prompt`,
                messages: [
                    { role: "user", content: { type: "text", text: `${name}: ${JSON.stringify(args)}` } },
                    { role: "assistant", content: { type: "text", text: "understood" } },
                ],
            },
        });
        return;
    }
    if (method === "completion/complete") {
        const value = params?.argument?.value ?? "";
        const all = ["src/index.ts", "src/app.ts", "README.md"];
        send({
            jsonrpc: "2.0",
            id,
            result: { completion: { values: all.filter((v) => v.startsWith(value)), total: all.length } },
        });
        return;
    }

    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
});
