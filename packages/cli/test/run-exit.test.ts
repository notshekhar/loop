import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_END_GRACE_MS } from "../../core/src/agent/hooks";

// `loop run` ends by draining the event loop, so anything left pending after
// the reply — the SessionEnd grace timer was one — holds the process open.
// Real process, fake Anthropic endpoint: the seam a script calling loop sees.

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function helloReply(): Response {
    const events: [string, unknown][] = [
        [
            "message_start",
            {
                type: "message_start",
                message: {
                    id: "m",
                    type: "message",
                    role: "assistant",
                    model: "fixture",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 2, output_tokens: 0 },
                },
            },
        ],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
            "message_delta",
            {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
            },
        ],
        ["message_stop", { type: "message_stop" }],
    ];
    const body = new ReadableStream({
        start(c) {
            for (const [event, data] of events) c.enqueue(sse(event, data));
            c.close();
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
        await req.text();
        if (new URL(req.url).pathname.endsWith("/models"))
            return Response.json({ data: [{ id: "fixture", type: "model" }] });
        return helloReply();
    },
});
afterAll(() => server.stop(true));

function fakeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "loop-run-exit-"));
    const dir = join(home, ".loop");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultModel: "custom:fixture/fixture" }));
    writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({
            active: "custom:fixture",
            customProviders: {
                fixture: {
                    name: "fixture",
                    sdk: "anthropic",
                    baseURL: `http://127.0.0.1:${server.port}/v1`,
                    apiKey: "fixture",
                    auth: { kind: "apikey", apiKey: "fixture" },
                    models: [{ id: "fixture", contextWindow: 100000, maxOutput: 4096 }],
                },
            },
        }),
    );
    // A fresh probe cache, so the native-agent CLIs on this machine are not
    // launched — they have their own cost and are not what this measures.
    const fresh = (value: object) => ({ value, ts: Date.now() });
    writeFileSync(
        join(dir, "native-agents.json"),
        JSON.stringify({
            "claude-code": fresh({ loggedIn: false, models: [] }),
            "cursor-agent": fresh({ loggedIn: false, families: [] }),
            "codex-cli": fresh({ loggedIn: false, models: [] }),
            antigravity: fresh({ loggedIn: false, models: [] }),
        }),
    );
    return home;
}

test("loop run exits as soon as the reply is printed, not after the SessionEnd grace period", async () => {
    const home = fakeHome();
    const proc = Bun.spawn(["bun", CLI, "run", "hi"], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, LOOP_SKIP_VERSION_CHECK: "1", LOOP_SOUND: "0" },
    });
    let stdout = "";
    let printedAt = 0;
    for await (const chunk of proc.stdout) {
        stdout += new TextDecoder().decode(chunk);
        if (!printedAt && stdout.includes("hello")) printedAt = performance.now();
    }
    await proc.exited;
    const tail = performance.now() - printedAt;

    expect(stdout).toContain("hello");
    expect(proc.exitCode).toBe(0);
    expect(tail).toBeLessThan(SESSION_END_GRACE_MS / 2);
}, 30_000);
