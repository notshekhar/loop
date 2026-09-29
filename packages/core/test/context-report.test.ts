import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextReport } from "../src/agent/context-report";
import { getExtensionHost } from "../src/extensions";
import { Session } from "../src/sessions";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// A model that exists in the bundled fallback catalog with a known window.
const MODEL = "anthropic/claude-sonnet-5";

function sessionWith(entries: Entry[], cwd: string): Session {
    // Deep-clone: the constructor assigns id/parentId in place, so shared
    // entry objects would leak one session's tree links into the next.
    const cloned = entries.map((e) => JSON.parse(JSON.stringify(e)) as Entry);
    return new Session(
        { id: "ctx-t", createdAt: 0, cwd, provider: "anthropic", model: MODEL },
        "/tmp/fake.jsonl",
        cloned,
    );
}

const ts = 0;
const emptyDir = () => mkdtempSync(join(tmpdir(), "loop-ctx-"));

describe("buildContextReport", () => {
    test("categories sum to totalTokens and free space complements it", async () => {
        const cwd = emptyDir();
        const session = sessionWith(
            [
                { type: "message", role: "user", content: "hello there", ts },
                { type: "message", role: "assistant", content: "hi! how can I help?", ts },
            ],
            cwd,
        );
        const report = await buildContextReport({ session, modelId: MODEL, cwd });

        expect(report.contextWindow).toBeGreaterThan(0);
        const sum = report.categories.reduce((a, c) => a + c.tokens, 0);
        expect(report.totalTokens).toBe(sum);
        expect(report.freeTokens).toBe(report.contextWindow - report.totalTokens);

        const keys = report.categories.map((c) => c.key);
        expect(keys).toContain("systemPrompt");
        expect(keys).toContain("systemTools");
        expect(keys).toContain("messages");
        for (const c of report.categories) expect(c.tokens).toBeGreaterThanOrEqual(0);
    });

    test("null session yields zero message tokens but nonzero overhead", async () => {
        const cwd = emptyDir();
        const report = await buildContextReport({ session: null, modelId: MODEL, cwd });
        const messages = report.categories.find((c) => c.key === "messages");
        expect(messages?.tokens).toBe(0);
        const system = report.categories.find((c) => c.key === "systemPrompt");
        expect(system!.tokens).toBeGreaterThan(0);
    });

    test("compaction drops pre-cutAt messages and adds a compact-summary bucket", async () => {
        const cwd = emptyDir();
        const big = "x".repeat(4000);
        const before: Entry[] = [
            { type: "message", role: "user", content: big, ts },
            { type: "message", role: "assistant", content: big, ts },
        ];
        const after: Entry[] = [{ type: "message", role: "user", content: "small follow-up", ts }];

        const uncompacted = sessionWith([...before, ...after], cwd);
        const compacted = sessionWith(
            [
                ...before,
                { type: "compact", summary: "we talked", cutAt: 2, ts, tokensBefore: 2000, tokensAfter: 50 } as Entry,
                ...after,
            ],
            cwd,
        );

        const a = await buildContextReport({ session: uncompacted, modelId: MODEL, cwd });
        const b = await buildContextReport({ session: compacted, modelId: MODEL, cwd });

        const msg = (r: typeof a) => r.categories.find((c) => c.key === "messages")!.tokens;
        expect(msg(b)).toBeLessThan(msg(a));
        expect(b.categories.some((c) => c.key === "compactSummary")).toBe(true);
        expect(a.categories.some((c) => c.key === "compactSummary")).toBe(false);
    });

    test("a rollover's handoff is sized as the block the model reads, not as an empty summary", async () => {
        const cwd = emptyDir();
        const handoff = "carried inputs ".repeat(2_000); // ~30k chars
        const session = sessionWith(
            [
                { type: "message", role: "user", content: "old", ts },
                { type: "message", role: "assistant", content: "old reply", ts },
                {
                    type: "compact",
                    summary: "",
                    handoff,
                    rollover: true,
                    cutAt: 2,
                    ts,
                    tokensBefore: 10,
                    tokensAfter: 10,
                },
            ],
            cwd,
        );
        const report = await buildContextReport({ session, modelId: MODEL, cwd });
        const block = report.categories.find((c) => c.key === "compactSummary");
        expect(block!.tokens).toBeGreaterThan(handoff.length / 4);
    });

    test("unknown model reports a zero context window without crashing", async () => {
        const cwd = emptyDir();
        const report = await buildContextReport({ session: null, modelId: "nope/does-not-exist", cwd });
        expect(report.contextWindow).toBe(0);
        expect(report.freeTokens).toBe(0);
    });

    test("extension onSystemPrompt injection shows up as an extensionPrompt bucket", async () => {
        const cwd = emptyDir();
        const host = getExtensionHost();
        const orig = host.getTurnMiddleware.bind(host);
        // ~4000 injected chars ⇒ ~1000 estimated tokens (chars/4 heuristic).
        (host as { getTurnMiddleware: () => unknown[] }).getTurnMiddleware = () => [
            { onSystemPrompt: (p: string) => p + "X".repeat(4000) },
        ];
        try {
            const report = await buildContextReport({ session: null, modelId: MODEL, cwd });
            const ext = report.categories.find((c) => c.key === "extensionPrompt");
            expect(ext).toBeDefined();
            expect(ext!.tokens).toBe(1000);
            // The base prompt bucket stays what buildSystemPrompt produced.
            const clean = await (async () => {
                (host as { getTurnMiddleware: () => unknown[] }).getTurnMiddleware = orig;
                return buildContextReport({ session: null, modelId: MODEL, cwd });
            })();
            const sys = (r: typeof report) => r.categories.find((c) => c.key === "systemPrompt")!.tokens;
            expect(sys(report)).toBe(sys(clean));
            expect(clean.categories.some((c) => c.key === "extensionPrompt")).toBe(false);
        } finally {
            (host as { getTurnMiddleware: () => unknown[] }).getTurnMiddleware = orig;
        }
    });
});
