/**
 * The compaction summary runs at the model's LOWEST reasoning, whatever the
 * session uses: a summary needs none, and thinking over the largest request a
 * session ever sends is minutes of silence before the first word. A model that
 * refuses its lowest level is asked once more at the session's own.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { lowestThinkingLevel } from "../src/agent/thinking";

// Delegating mock (see stream-resume.test.ts): bun module mocks leak across
// files, so getModel is only faked while a test has set currentModel.
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
        currentModel ?? realProviders.getModel(...args),
}));

afterEach(() => {
    currentModel = null;
});

const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
};

const reply = (text: string) => ({
    stream: new ReadableStream({
        start(c) {
            for (const p of [
                { type: "text-start", id: "s" },
                { type: "text-delta", id: "s", delta: text },
                { type: "text-end", id: "s" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ])
                c.enqueue(p);
            c.close();
        },
    }),
});

type Seen = { reasoning?: unknown; providerOptions?: Record<string, Record<string, unknown>> };

/** A model that records what each request asked for, answering with `answer(n)`. */
function recording(answer: (n: number) => ReturnType<typeof reply>) {
    const seen: Seen[] = [];
    currentModel = new MockLanguageModelV3({
        doStream: async (options) => {
            seen.push(options as Seen);
            return answer(seen.length);
        },
    });
    return seen;
}

const rejected = (statusCode: number) =>
    new APICallError({
        message: `HTTP ${statusCode}`,
        url: "https://example.test",
        requestBodyValues: {},
        statusCode,
        isRetryable: false,
    });

describe("lowestThinkingLevel", () => {
    test("off wherever reasoning can be turned off", () => {
        expect(lowestThinkingLevel("claude-opus-5")).toBe("off");
        expect(lowestThinkingLevel("gpt-5.5")).toBe("off");
        expect(lowestThinkingLevel("grok-build-0.1")).toBe("off");
        expect(lowestThinkingLevel("deepseek-chat")).toBe("off");
    });

    test("the lowest effort on a model that always thinks", () => {
        expect(lowestThinkingLevel("claude-fable-5")).toBe("minimal");
        expect(lowestThinkingLevel("claude-mythos-preview")).toBe("minimal");
    });
});

describe("requestSummary reasoning", () => {
    test("a session on high reasoning summarizes with reasoning off", async () => {
        const seen = recording(() => reply("SUMMARY"));
        const { requestSummary } = await import("../src/agent/summarize");
        const out = await requestSummary({
            modelId: "openai/gpt-5.5",
            messages: [{ role: "user", content: "p" }],
            thinkingLevel: "high",
        });
        expect(out.text).toBe("SUMMARY");
        expect(seen).toHaveLength(1);
        expect(seen[0].reasoning).toBe("none");
    });

    test("anthropic: thinking disabled, not the session's effort", async () => {
        const seen = recording(() => reply("SUMMARY"));
        const { requestSummary } = await import("../src/agent/summarize");
        await requestSummary({
            modelId: "anthropic/claude-opus-4-7",
            messages: [{ role: "user", content: "p" }],
            thinkingLevel: "xhigh",
        });
        expect(seen[0].providerOptions?.anthropic).toEqual({ thinking: { type: "disabled" } });
    });

    test("a model that always thinks is asked for its lowest effort", async () => {
        const seen = recording(() => reply("SUMMARY"));
        const { requestSummary } = await import("../src/agent/summarize");
        await requestSummary({
            modelId: "anthropic/claude-fable-5",
            messages: [{ role: "user", content: "p" }],
            thinkingLevel: "high",
        });
        expect(seen[0].providerOptions?.anthropic?.effort).toBe("low");
    });

    test("a refused lowest level falls back to the session's level, once", async () => {
        const seen = recording((n) => {
            if (n === 1) throw rejected(400);
            return reply("SUMMARY");
        });
        const { requestSummary } = await import("../src/agent/summarize");
        const out = await requestSummary({
            modelId: "openai/gpt-5.5",
            messages: [{ role: "user", content: "p" }],
            thinkingLevel: "high",
        });
        expect(out.text).toBe("SUMMARY");
        expect(seen.map((s) => s.reasoning)).toEqual(["none", "high"]);
    });

    test("no fallback when the session already runs at the lowest level", async () => {
        const seen = recording(() => {
            throw rejected(400);
        });
        const { requestSummary } = await import("../src/agent/summarize");
        await expect(
            requestSummary({
                modelId: "openai/gpt-5.5",
                messages: [{ role: "user", content: "p" }],
                thinkingLevel: "off",
            }),
        ).rejects.toThrow("HTTP 400");
        expect(seen).toHaveLength(1);
    });

    test("an error that is not a refusal is not retried at another level", async () => {
        const seen = recording(() => {
            throw rejected(401);
        });
        const { requestSummary } = await import("../src/agent/summarize");
        await expect(
            requestSummary({
                modelId: "openai/gpt-5.5",
                messages: [{ role: "user", content: "p" }],
                thinkingLevel: "high",
            }),
        ).rejects.toThrow("HTTP 401");
        expect(seen).toHaveLength(1);
    });
});
