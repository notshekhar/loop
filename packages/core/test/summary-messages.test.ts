import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";
import { toolStubs } from "../src/agent/summarize";
import { chunkMessages, messageChars, toSummaryMessages } from "../src/agent/summary-messages";

const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: { path: `${id}.ts` } }],
});
const result = (id: string, value: string) => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value } }],
});

describe("toSummaryMessages", () => {
    test("drops reasoning and empty text, names media, keeps calls and results paired", () => {
        const out = toSummaryMessages([
            {
                role: "user",
                content: [
                    { type: "text", text: "look" },
                    { type: "image", image: "AAAA" },
                ],
            },
            {
                role: "assistant",
                content: [{ type: "reasoning", text: "SECRET" }, { type: "text", text: "" }, ...call("a").content],
            },
            result("a", "x".repeat(5_000)),
            { role: "assistant", content: "   " },
        ]);
        expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
        expect(JSON.stringify(out)).not.toContain("SECRET");
        expect(JSON.stringify(out[0])).toContain("[image]");
        const value = (out[2].content as Array<{ output: { value: string } }>)[0].output.value;
        expect(value).toContain("more characters truncated");
        expect(value.length).toBeLessThan(2_200);
    });
});

describe("stored provider ids", () => {
    // A reply that followed reasoning, stored as the Responses API returned it.
    const span = [
        { role: "user", content: [{ type: "text", text: "fix it", providerOptions: { openai: { itemId: "msg_u" } } }] },
        {
            role: "assistant",
            content: [
                {
                    type: "reasoning",
                    text: "",
                    providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "ENC" } },
                },
                { type: "text", text: "Looking.", providerOptions: { openai: { itemId: "msg_1" } } },
                {
                    type: "tool-call",
                    toolCallId: "c1",
                    toolName: "read",
                    input: { path: "a.ts" },
                    providerOptions: { openai: { itemId: "fc_1" } },
                },
            ],
        },
        result("c1", "contents"),
        {
            role: "assistant",
            content: [{ type: "text", text: "Done.", providerOptions: { openai: { itemId: "msg_2" } } }],
        },
    ];

    test("are not carried into the summary messages", () => {
        const out = JSON.stringify(toSummaryMessages(span));
        expect(out).not.toContain("providerOptions");
        expect(out).toContain("Looking.");
        expect(out).toContain('"toolCallId":"c1"');
    });

    // Azure refuses an item_reference whose reasoning item is not in the
    // request, and the summary drops reasoning: the request must carry the
    // replies themselves.
    test("so the Responses API request sends text, not item references", async () => {
        let body = "";
        const openai = createOpenAI({
            apiKey: "test",
            fetch: (async (_url: unknown, init?: RequestInit) => {
                body = String(init?.body);
                return new Response("upstream not needed", { status: 500 });
            }) as unknown as typeof fetch,
        });
        const messages = [...toSummaryMessages(span), { role: "user", content: "Summarize." } as ModelMessage];
        const result = streamText({
            model: openai("gpt-test"),
            messages,
            tools: toolStubs(messages),
            toolChoice: "none",
            maxRetries: 0,
            onError: () => {},
        });
        for await (const _ of result.fullStream) {
        }
        expect(body).toContain("Looking.");
        expect(body).toContain("Done.");
        expect(body).not.toContain("item_reference");
    });
});

describe("chunkMessages", () => {
    test("packs to the budget and never starts a chunk on a tool result", () => {
        const messages = toSummaryMessages([
            { role: "user", content: "u".repeat(300) },
            call("a"),
            result("a", "r".repeat(300)),
            call("b"),
            result("b", "r".repeat(300)),
            { role: "user", content: "u".repeat(300) },
        ]);
        const chunks = chunkMessages(messages, 800);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) expect(chunk[0].role).not.toBe("tool");
        expect(chunks.flat()).toHaveLength(messages.length);
    });

    test("clips a single group bigger than a whole chunk", () => {
        const [chunk] = chunkMessages([{ role: "user", content: "z".repeat(50_000) } as ModelMessage], 4_000);
        expect(messageChars(chunk[0])).toBeLessThan(4_000);
        expect(JSON.stringify(chunk[0])).toContain("chars omitted");
    });
});

describe("toolStubs", () => {
    test("declares every tool the span calls, and nothing when it calls none", () => {
        const stubs = toolStubs(toSummaryMessages([call("a"), result("a", "ok")]));
        expect(Object.keys(stubs ?? {})).toEqual(["read"]);
        expect(toolStubs([{ role: "user", content: "hi" }])).toBeUndefined();
    });
});
