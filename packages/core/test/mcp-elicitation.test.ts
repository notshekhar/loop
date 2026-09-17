/**
 * Elicitation — an MCP server asking the user a question mid-tool-call.
 *
 * Until loop registered a handler, the SDK answered every one of these with
 * "no elicitation handler registered on client", so a server built around a
 * confirmation could never complete its call. The end-to-end tests here drive
 * a real server through a real tool call: it asks, a stub bridge answers, and
 * the tool result carries what the user chose.
 */
import { CONFIG_DIR_NAME } from "../src/brand";
import { describe, expect, test, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpManager } from "../src/mcp/manager";
import {
    coerceElicitationValues,
    handleElicitation,
    isElicitationAvailable,
    parseElicitationSchema,
    setMcpElicitationBridge,
    type ElicitationOutcome,
    type ElicitationRequestInfo,
} from "../src/mcp/elicitation";
import { trustForSession } from "../src/agent/trust";
import type { McpServerConfig } from "../src/mcp/config";

const here = dirname(fileURLToPath(import.meta.url));
const ELICIT = join(here, "fixtures", "mock-mcp-elicit.mjs");

function project(env: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-elicit-"));
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    const server: McpServerConfig = {
        command: process.execPath,
        args: [ELICIT],
        ...(Object.keys(env).length ? { env } : {}),
    };
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: { ask: server } }));
    trustForSession(root);
    return root;
}

/** Call the server's one tool and return what it reported back. */
async function callDeploy(mgr: McpManager): Promise<string> {
    const tool = mgr.getTools()["mcp__ask__deploy"] as {
        execute: (input: unknown, options: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const result = await tool.execute({}, {});
    return result.content[0].text;
}

afterEach(() => setMcpElicitationBridge(null));

describe("schema parsing", () => {
    test("enums, numbers, booleans and strings all come through", () => {
        const fields = parseElicitationSchema({
            type: "object",
            properties: {
                env: { type: "string", enum: ["a", "b"], enumNames: ["Ay", "Bee"] },
                count: { type: "integer", minimum: 1, maximum: 9 },
                force: { type: "boolean", default: false },
                note: { type: "string", description: "why", maxLength: 40 },
            },
            required: ["env", "count"],
        });
        expect(fields.map((f) => [f.name, f.type, f.required])).toEqual([
            ["env", "enum", true],
            ["count", "integer", true],
            ["force", "boolean", false],
            ["note", "string", false],
        ]);
        // enumNames are the labels; the values are what goes back to the server.
        expect(fields[0].options).toEqual([
            { value: "a", label: "Ay" },
            { value: "b", label: "Bee" },
        ]);
        expect(fields[1]).toMatchObject({ minimum: 1, maximum: 9 });
    });

    test("anything that isn't a flat primitive is dropped, not guessed at", () => {
        const fields = parseElicitationSchema({
            type: "object",
            properties: {
                nested: { type: "object", properties: { a: { type: "string" } } },
                list: { type: "array", items: { type: "string" } },
                ok: { type: "string" },
            },
        });
        expect(fields.map((f) => f.name)).toEqual(["ok"]);
    });

    test("a schema with no properties is a confirmation, not an error", () => {
        expect(parseElicitationSchema({ type: "object", properties: {} })).toEqual([]);
        expect(parseElicitationSchema(undefined)).toEqual([]);
        expect(parseElicitationSchema("nonsense")).toEqual([]);
    });
});

describe("value coercion", () => {
    const fields = parseElicitationSchema({
        type: "object",
        properties: {
            env: { type: "string", enum: ["staging", "production"] },
            count: { type: "integer", minimum: 1, maximum: 9 },
            force: { type: "boolean" },
            note: { type: "string" },
        },
        required: ["env"],
    });

    test("a number field comes back as a number, not the string that was typed", () => {
        const { content, errors } = coerceElicitationValues(fields, { env: "staging", count: "3", force: "yes" });
        expect(errors).toEqual([]);
        expect(content).toEqual({ env: "staging", count: 3, force: true });
        expect(typeof content.count).toBe("number");
    });

    test("declared bounds are enforced before anything is sent", () => {
        expect(coerceElicitationValues(fields, { env: "staging", count: "99" }).errors).toEqual([
            "count must be at most 9",
        ]);
        expect(coerceElicitationValues(fields, { env: "staging", count: "1.5" }).errors).toEqual([
            "count must be a whole number",
        ]);
        expect(coerceElicitationValues(fields, { env: "nowhere" }).errors[0]).toContain("must be one of");
    });

    test("an empty optional field is omitted rather than sent as an empty string", () => {
        const { content, errors } = coerceElicitationValues(fields, { env: "staging", note: "" });
        expect(errors).toEqual([]);
        expect(content).toEqual({ env: "staging" });
        expect("note" in content).toBe(false);
    });

    test("an empty required field is an error", () => {
        expect(coerceElicitationValues(fields, {}).errors).toEqual(["env is required"]);
    });
});

describe("with no UI attached", () => {
    test("the request is declined immediately, not left hanging", async () => {
        expect(isElicitationAvailable()).toBe(false);
        expect(await handleElicitation("srv", { message: "hi", requestedSchema: {} })).toEqual({ action: "decline" });
    });

    test("end to end: the tool call completes instead of stalling", async () => {
        const mgr = new McpManager();
        await mgr.init(project());
        const text = await callDeploy(mgr);
        expect(text).toContain('"action":"decline"');
        await mgr.close();
    });
});

describe("with a UI attached", () => {
    function bridge(outcome: ElicitationOutcome, seen: ElicitationRequestInfo[] = []) {
        setMcpElicitationBridge({
            elicit: async (request) => {
                seen.push(request);
                return outcome;
            },
        });
        return seen;
    }

    test("end to end: the user's answers reach the server", async () => {
        const seen = bridge({ action: "accept", content: { environment: "staging", replicas: 2 } });
        const mgr = new McpManager();
        await mgr.init(project());
        const text = await callDeploy(mgr);

        // The bridge was told who is asking and what they asked for.
        expect(seen[0].server).toBe("ask");
        expect(seen[0].message).toBe("Where should this deploy go?");
        expect(seen[0].fields.map((f) => f.name)).toEqual(["environment", "replicas", "note"]);
        // And the server got the answer back, typed.
        expect(text).toContain('"environment":"staging"');
        expect(text).toContain('"replicas":2');
        await mgr.close();
    });

    test("a field-less request arrives as a confirmation", async () => {
        const seen = bridge({ action: "accept", content: {} });
        const mgr = new McpManager();
        await mgr.init(project({ MOCK_MCP_ELICIT_SCHEMA: "confirm" }));
        await callDeploy(mgr);
        expect(seen[0].fields).toEqual([]);
        await mgr.close();
    });

    test("cancelling answers the server rather than dropping the call", async () => {
        bridge({ action: "cancel" });
        const mgr = new McpManager();
        await mgr.init(project());
        expect(await callDeploy(mgr)).toContain('"action":"cancel"');
        await mgr.close();
    });

    test("a bridge that throws becomes a cancel, never a hung tool call", async () => {
        setMcpElicitationBridge({
            elicit: async () => {
                throw new Error("ui exploded");
            },
        });
        expect(await handleElicitation("srv", { message: "hi", requestedSchema: {} })).toEqual({ action: "cancel" });
    });

    test("the connection is unharmed: the server keeps working afterwards", async () => {
        bridge({ action: "accept", content: { environment: "production" } });
        const mgr = new McpManager();
        await mgr.init(project());
        await callDeploy(mgr);
        expect(mgr.getServer("ask")?.status).toBe("ready");
        expect(await callDeploy(mgr)).toContain("production");
        await mgr.close();
    });
});
