import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { generateHandoff } from "../src/agent/handoff";
import { generateRecipe } from "../src/recipes/generate";
import type { Entry } from "../src/types";
import type { CostTracker } from "../src/agent/cost";

function model(text: string, finish: "stop" | "length" = "stop") {
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [{ type: "text", text }],
            finishReason: { unified: finish, raw: finish },
            usage: {
                inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
            warnings: [],
        }),
    });
}

const entries: Entry[] = [
    { type: "message", role: "user", content: "Fix the endpoint; tests are still failing.", ts: 1 },
];

describe("workflow generation through the model API", () => {
    for (const kind of ["recipe", "handoff"] as const) {
        const call = async (
            fake: MockLanguageModelV3,
            extra: { tracker?: CostTracker; abortSignal?: AbortSignal; entries?: Entry[] } = {},
        ) => {
            const opts = {
                name: "endpoint",
                entries,
                modelId: "xai/test",
                cwd: "/tmp/workflow",
                sessionPub: "source",
                focus: "endpoint validation",
                workspaceStatus: " M src/endpoint.ts",
                ...extra,
            };
            return kind === "recipe" ? generateRecipe(opts, async () => fake) : generateHandoff(opts, async () => fake);
        };
        test(`${kind}: produces editable Markdown, includes evidence and records usage`, async () => {
            const fake = model("```markdown\n## Next steps\nFix the failing tests.\n```");
            const recorded: unknown[][] = [];
            const tracker = { add: (...args: unknown[]) => recorded.push(args) } as unknown as CostTracker;
            expect(await call(fake, { tracker })).toBe("## Next steps\nFix the failing tests.");
            expect(fake.doGenerateCalls).toHaveLength(1);
            const prompt = JSON.stringify(fake.doGenerateCalls[0].prompt);
            expect(prompt).toContain("tests are still failing");
            expect(prompt).toContain("endpoint validation");
            if (kind === "handoff") expect(prompt).toContain("src/endpoint.ts");
            expect(fake.doGenerateCalls[0].tools ?? []).toHaveLength(0);
            expect(recorded).toHaveLength(1);
            expect(recorded[0][2]).toEqual({ cwd: "/tmp/workflow", sessionPub: "source", source: kind });
        });
        test(`${kind}: refuses empty and cut-off drafts`, async () => {
            await expect(call(model(" "))).rejects.toThrow("empty");
            await expect(call(model("partial instructions", "length"))).rejects.toThrow("cut off");
        });
        test(`${kind}: empty sessions and cancellation do not call the model`, async () => {
            const fake = model("should not be generated");
            await expect(call(fake, { entries: [] })).rejects.toThrow();
            const abort = new AbortController();
            abort.abort();
            await expect(call(fake, { abortSignal: abort.signal })).rejects.toThrow();
            expect(fake.doGenerateCalls).toHaveLength(0);
        });
    }
});
