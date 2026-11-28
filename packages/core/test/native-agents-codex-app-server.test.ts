/**
 * Codex driven over its app-server protocol, end to end: loop's real
 * provider spawns a fake `codex` (test/fixtures/fake-codex-app-server.ts)
 * that speaks the same JSON-RPC, and the test reads what loop streamed and
 * what it sent. Nothing touches the real ~/.loop: config dir, settings and
 * the session DB are all temporary.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { BashApprovalDecision, BashApprovalRequest } from "../src/tools/approval-bridge";

const home = mkdtempSync(join(tmpdir(), "loop-codex-home-"));
const actualBrand = await import("../src/brand");
mock.module("../src/brand", () => ({ ...actualBrand, getConfigDir: () => join(home, ".loop") }));
const settings: Record<string, unknown> = {};
const actualSettings = await import("../src/settings");
mock.module("../src/settings", () => ({
    ...actualSettings,
    getSetting: (k: string) => settings[k],
    setSetting: (k: string, v: unknown) => {
        settings[k] = v;
    },
}));

const { createCodexModel } = await import("../src/providers/native-agents");
const { getSessionLink, setSessionLink } = await import("../src/providers/native-agents/shared");
const { setBashApprovalBridge } = await import("../src/tools/approval-bridge");
const { useTempSessionDb } = await import("./helpers/temp-db");
useTempSessionDb();

const FAKE = join(import.meta.dir, "fixtures", "fake-codex-app-server.ts");
chmodSync(FAKE, 0o755);
process.env.LOOP_CODEX_BIN = FAKE;

let logFile: string;
const sent = (method: string) =>
    readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
        .filter((m) => m.method === method)
        .map((m) => m.params);

beforeEach(() => {
    logFile = join(mkdtempSync(join(tmpdir(), "loop-codex-log-")), "log.jsonl");
    process.env.FAKE_CODEX_LOG = logFile;
    for (const k of Object.keys(settings)) delete settings[k];
    setBashApprovalBridge(null);
});

const cwd = mkdtempSync(join(tmpdir(), "loop-codex-cwd-"));
const ctx = (over: Partial<{ planMode: boolean; approvals: boolean }> = {}) => ({
    loopSessionId: `s-${Math.random()}`,
    cwd,
    planMode: false,
    approvals: false,
    ...over,
});

function call(text: string, turnCtx: ReturnType<typeof ctx> | undefined, extra: Partial<LanguageModelV4CallOptions> = {}): LanguageModelV4CallOptions {
    return {
        prompt: [
            { role: "system", content: "LOOP SYSTEM PROMPT" },
            { role: "user", content: [{ type: "text", text }] },
        ],
        ...(turnCtx ? { providerOptions: { "codex-cli": { ...turnCtx } } } : {}),
        ...extra,
    } as LanguageModelV4CallOptions;
}

async function collect(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamPart[]> {
    const { stream } = await createCodexModel("gpt-test").doStream(options);
    const parts: LanguageModelV4StreamPart[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return parts;
        parts.push(value);
    }
}

const textOf = (parts: LanguageModelV4StreamPart[]) =>
    parts.flatMap((p) => (p.type === "text-delta" ? [p.delta] : [])).join("");

describe("codex over app-server", () => {
    test("the reply streams as it is written, and the turn's usage is reported", async () => {
        const parts = await collect(call("hi", ctx()));
        expect(parts.filter((p) => p.type === "text-delta").map((p) => (p as { delta: string }).delta)).toEqual(["hel", "lo"]);
        const finish = parts.find((p) => p.type === "finish") as Extract<LanguageModelV4StreamPart, { type: "finish" }>;
        expect(finish.finishReason.unified).toBe("stop");
        // Context = the last call's input; output = this turn's share of the thread total.
        expect(finish.usage.inputTokens).toMatchObject({ total: 1200, cacheRead: 200, noCache: 1000 });
        expect(finish.usage.outputTokens.total).toBe(30);
    });

    test("loop's system prompt becomes the thread's developer instructions, with the mode's sandbox", async () => {
        await collect(call("hi", ctx()));
        const [start] = sent("thread/start");
        expect(start).toMatchObject({
            model: "gpt-test",
            cwd,
            developerInstructions: "LOOP SYSTEM PROMPT",
            sandbox: "danger-full-access",
            approvalPolicy: "never",
        });
        // Not repeated inline in the message.
        expect(JSON.stringify(sent("turn/start")[0].input)).not.toContain("LOOP SYSTEM PROMPT");
    });

    test("a utility call is ephemeral and read-only", async () => {
        await collect(call("title this", undefined));
        expect(sent("thread/start")[0]).toMatchObject({ ephemeral: true, sandbox: "read-only" });
    });

    test("with approvals on, Codex's command request is answered by loop's prompt", async () => {
        settings.bashApprove = true;
        const asked: BashApprovalRequest[] = [];
        setBashApprovalBridge({
            confirm: async (req): Promise<BashApprovalDecision> => {
                asked.push(req);
                return "deny";
            },
        });
        const parts = await collect(call("run make deploy", ctx({ approvals: true })));
        // Judged without Codex's shell wrapper, so "always" would remember `make`, not `zsh`.
        expect(asked.map((r) => [r.command, r.patterns])).toEqual([["make deploy", ["make"]]]);
        expect(sent("thread/start")[0]).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "untrusted" });
        const result = parts.find((p) => p.type === "tool-result") as { result: string; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.result).toContain("declined");
    });

    test("loop's denylist refuses a command without asking", async () => {
        settings.bashApprove = true;
        settings.bashDeny = ["make deploy"];
        let prompted = false;
        setBashApprovalBridge({
            confirm: async () => {
                prompted = true;
                return "once";
            },
        });
        const parts = await collect(call("run make deploy", ctx({ approvals: true })));
        expect(prompted).toBe(false);
        expect((parts.find((p) => p.type === "tool-result") as { isError?: boolean }).isError).toBe(true);
    });

    test("a linked thread is resumed with the turn's model; a gone one is re-seeded fresh", async () => {
        const live = ctx();
        setSessionLink("codex-cli", live.loopSessionId, { nativeId: "thread-live", seen: 0, updatedAt: Date.now() });
        await collect(call("hi", live));
        expect(sent("thread/resume")[0]).toMatchObject({ threadId: "thread-live", model: "gpt-test" });
        expect(sent("thread/start")).toHaveLength(0);

        const gone = ctx();
        setSessionLink("codex-cli", gone.loopSessionId, { nativeId: "thread-deleted", seen: 0, updatedAt: Date.now() });
        const parts = await collect(call("hi", gone));
        expect(textOf(parts)).toBe("hello");
        expect(sent("thread/start")).toHaveLength(1);
        expect(getSessionLink("codex-cli", gone.loopSessionId)?.nativeId).toBe("thread-new");
    });

    test("Esc interrupts the turn instead of killing Codex mid-write", async () => {
        const ac = new AbortController();
        const done = collect(call("wait", ctx(), { abortSignal: ac.signal }));
        await Bun.sleep(300);
        ac.abort();
        const parts = await done;
        expect(sent("turn/interrupt")).toHaveLength(1);
        const finish = parts.find((p) => p.type === "finish") as Extract<LanguageModelV4StreamPart, { type: "finish" }>;
        expect(finish.finishReason.raw).toBe("aborted");
        expect(parts.some((p) => p.type === "error")).toBe(false);
    });
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
