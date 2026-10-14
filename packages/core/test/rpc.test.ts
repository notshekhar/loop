import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";

// getLoopDir() captures homedir() at module load, so point HOME at a temp dir
// BEFORE the first dynamic import of the server — the session store + auth land
// there instead of the real ~/.loop. Static imports are hoisted, so this runs
// in beforeAll with a dynamic import, not a top-level `import`.
const HOME = mkdtempSync(join(tmpdir(), "loop-rpc-home-"));
const CWD = mkdtempSync(join(tmpdir(), "loop-rpc-cwd-"));
const prevHome = process.env.HOME;
const MODEL = "anthropic/claude-sonnet-4-6";

/** A model turn the tests can swap per-case; default is a tiny text answer. */
type StreamPart = Record<string, unknown>;
function streamOf(parts: StreamPart[]) {
    let i = 0;
    return {
        stream: new ReadableStream({
            async pull(controller) {
                await new Promise((r) => setTimeout(r, 1));
                if (i < parts.length) controller.enqueue(parts[i++]);
                else controller.close();
            },
        }),
    };
}
function textTurn(text: string) {
    return streamOf([
        { type: "text-start", id: "t0" },
        ...text.split("").map((c) => ({ type: "text-delta", id: "t0", delta: c })),
        { type: "text-end", id: "t0" },
        {
            type: "finish",
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
    ]);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let doStreamImpl: (options: any) => Promise<any> = async () => textTurn("hello from mock");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RpcServer: any, startSocketServer: any, RpcClient: any;
let realProviders: typeof import("../src/providers");
let providersMockActive = true;

const NATIVE_BIN_VARS = ["LOOP_CLAUDE_CODE_BIN", "LOOP_CURSOR_AGENT_BIN", "LOOP_CODEX_BIN", "LOOP_ANTIGRAVITY_BIN"] as const;
const prevNativeBins = NATIVE_BIN_VARS.map((name) => process.env[name]);

beforeAll(async () => {
    process.env.HOME = HOME;
    // config.reload refreshes the catalog, which probes the native agents (Claude Code, Cursor, Codex, Antigravity).
    // Their answers are cached in the REAL home's config (os.homedir() ignores
    // $HOME under Bun), so the test must never run the user's CLIs: point both
    // at a binary that doesn't exist and the probes find nothing to ask.
    for (const name of NATIVE_BIN_VARS) process.env[name] = join(HOME, "no-such-binary");
    // The session store must land under the temp HOME too — the db path is
    // resolved lazily, so an explicit override beats load-order roulette.
    const { setDbPathForTests } = await import("../src/sessions");
    setDbPathForTests(join(HOME, ".loop", "agent.db"));
    // Mock the model resolver BEFORE importing the server, so runTurn's binding
    // resolves to the mock. Every turn streams whatever doStreamImpl returns.
    realProviders = await import("../src/providers");
    const model = new MockLanguageModelV3({ doStream: (options) => doStreamImpl(options) });
    // The mock delegates through providersMockActive instead of being swapped
    // out in afterAll: bindings resolve at import time (hence "mock BEFORE
    // importing the server" above), so the rpc/server module cached by this
    // file keeps THIS namespace forever — including when a later test file
    // (rpc-serve.test.ts on CI's file order) imports it. mock.restore() does
    // not undo mock.module, and a re-mock can't reach the stale binding; the
    // leaked always-succeed getModel made rpc-serve's bogus-provider send
    // never fail, timing out its error-event wait (the red ci since v0.12.8).
    mock.module("../src/providers", () => ({
        ...realProviders,
        getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
            providersMockActive ? model : realProviders.getModel(...args),
    }));
    ({ RpcServer, startSocketServer } = await import("../src/rpc/server"));
    ({ RpcClient } = await import("../src/rpc/client"));
});

afterEach(() => {
    doStreamImpl = async () => textTurn("hello from mock");
});

afterAll(async () => {
    mock.restore();
    // Hand the real getModel back to whoever imports rpc/server after us —
    // see the delegation comment in beforeAll.
    providersMockActive = false;
    mock.module("../src/providers", () => realProviders);
    // The RpcServer constructor init()s the process-global extension host; reset
    // it so a later test file gets a pristine (uninitialized) host.
    const { getExtensionHost } = await import("../src/extensions");
    await getExtensionHost().close();
    const { setDbPathForTests } = await import("../src/sessions");
    setDbPathForTests(null);
    process.env.HOME = prevHome;
    NATIVE_BIN_VARS.forEach((name, i) => {
        if (prevNativeBins[i] === undefined) delete process.env[name];
        else process.env[name] = prevNativeBins[i];
    });
    rmSync(HOME, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
});

async function until(cond: () => boolean, tries = 400, ms = 5) {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, ms));
    }
    throw new Error("condition not met in time");
}

/** Drive an in-process server through its real newline-delimited transport. */
function harness(opts?: { remote?: boolean }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent: any[] = [];
    const server = new RpcServer(opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { feed } = server.attach({ send: (m: any) => sent.push(m) });
    let id = 0;

    async function call(method: string, params?: unknown) {
        const myId = ++id;
        feed(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let res: any;
        await until(() => !!(res = sent.find((m) => m.id === myId)));
        return res;
    }
    /** All session.event notifications received so far, oldest first. */
    const events = () => sent.filter((m) => m.method === "session.event").map((m) => m.params);
    return { sent, feed, call, events };
}

describe("rpc: capabilities + framing", () => {
    test("server.info advertises the full method + event surface", async () => {
        const { call } = harness();
        const { result, error } = await call("server.info");
        expect(error).toBeUndefined();
        expect(result.methods).toContain("session.history");
        expect(result.methods).toContain("session.compact");
        // The whole turn stream is forwarded, not the old 7-event subset.
        for (const e of ["reasoning-delta", "subagent-delta", "step-usage", "tool-error"]) {
            expect(result.events).toContain(e);
        }
    });

    test("two requests in one chunk each get a response", async () => {
        const { sent, feed } = harness();
        feed(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server.info" }) +
                "\n" +
                JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server.info" }) +
                "\n",
        );
        await until(() => sent.filter((m) => m.id === 1 || m.id === 2).length === 2);
        expect(sent.find((m) => m.id === 1)).toBeTruthy();
        expect(sent.find((m) => m.id === 2)).toBeTruthy();
    });

    test("a request split across two feeds is buffered until the newline", async () => {
        const { sent, feed } = harness();
        const line = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "server.info" });
        feed(line.slice(0, 10));
        await new Promise((r) => setTimeout(r, 15));
        expect(sent.find((m) => m.id === 7)).toBeFalsy(); // no newline yet
        feed(line.slice(10) + "\n");
        await until(() => !!sent.find((m) => m.id === 7));
        expect(sent.find((m) => m.id === 7)).toBeTruthy();
    });

    test("malformed JSON yields a parse-error response with null id", async () => {
        const { sent, feed } = harness();
        feed("{ not json }\n");
        await until(() => sent.some((m) => m.error?.code === -32700));
        const res = sent.find((m) => m.error?.code === -32700);
        expect(res.id).toBeNull();
    });

    test("unknown method is a JSON-RPC error, not a throw", async () => {
        const { call } = harness();
        const { error } = await call("does.not.exist");
        expect(error).toBeDefined();
        expect(String(error.message)).toContain("does.not.exist");
    });
});

describe("rpc: session lifecycle", () => {
    test("create → list → open round-trips through disk", async () => {
        const a = harness();
        const created = await a.call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        expect(sessionId).toBeTruthy();

        const list = await a.call("session.list", { cwd: CWD });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((list.result as any[]).some((s) => s.id === sessionId)).toBe(true);

        // A fresh server (no in-memory state) must reopen it from the JSONL file.
        const b = harness();
        const opened = await b.call("session.open", { sessionId });
        expect(opened.error).toBeUndefined();
        expect(opened.result.sessionId).toBe(sessionId);
        expect(opened.result.info.cwd).toBe(CWD);
    });

    test("session.history replays the current branch", async () => {
        const { call } = harness();
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        const hist = await call("session.history", { sessionId });
        expect(hist.error).toBeUndefined();
        expect(hist.result.info.cwd).toBe(CWD);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries = hist.result.entries as any[];
        expect(entries[0].type).toBe("session-info");
        expect(hist.result.leafId).toBe(entries[entries.length - 1].id);
    });

    test("session.history and session.list report the model in force, not the creation one", async () => {
        // `info.model` is fixed at creation, so a GUI pre-selecting from it
        // undoes every /model switch — the composer appeared to refuse to
        // change models mid-session.
        const { call, events } = harness();
        doStreamImpl = async () => textTurn("switched");
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;

        await call("session.send", { sessionId, input: "hi", model: "openai/gpt-5.6" });
        await until(() => events().some((p) => p.sessionId === sessionId && p.part.type === "finish"));

        const hist = await call("session.history", { sessionId });
        expect(hist.result.info.model).toBe(MODEL); // creation model, untouched
        expect(hist.result.model).toBe("openai/gpt-5.6");
        expect(hist.result.provider).toBe("openai");

        const row = (await call("session.list", { cwd: CWD })).result.find((r: { id: string }) => r.id === sessionId);
        expect(row.model).toBe(MODEL);
        expect(row.lastModel).toBe("openai/gpt-5.6");
        expect(row.lastProvider).toBe("openai");
    });

    test("the running flag is announced, not just answered when asked", async () => {
        // `ctx.running` is the only un-missable turn boundary: it moves in a
        // `finally`, where `finish` can be skipped by a throw, an abort or a
        // dropped socket. It used to flip in silence, readable only by polling
        // — so a client that lost `finish` showed "Working" until it was
        // remounted. See the desktop's liveTurn `session-running` case.
        const { call, events } = harness();
        doStreamImpl = async () => textTurn("done");
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;

        await call("session.send", { sessionId, input: "hi" });
        await until(() =>
            events().some(
                (p) => p.sessionId === sessionId && p.part.type === "session-running" && p.part.data.running === false,
            ),
        );

        const running = events()
            .filter((p) => p.sessionId === sessionId && p.part.type === "session-running")
            .map((p) => p.part.data.running);
        // Exactly one transition each way — the setter is idempotent, so a
        // re-assertion of the state already held never reaches the wire.
        expect(running).toEqual([true, false]);

        // And it closes the turn AFTER the stream said its piece, so a client
        // acting on it is not throwing away a reply it had not rendered yet.
        const types = events()
            .filter((p) => p.sessionId === sessionId)
            .map((p) => p.part.type);
        expect(types.indexOf("finish")).toBeLessThan(types.lastIndexOf("session-running"));
    });

    test("session.list falls back to the creation model before any turn", async () => {
        const { call } = harness();
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        const row = (await call("session.list", { cwd: CWD })).result.find((r: { id: string }) => r.id === sessionId);
        expect(row.lastModel).toBe(MODEL);
        expect(row.lastProvider).toBe("anthropic");
    });

    test("session.tree shows every branch, and session.branch moves between them", async () => {
        // `session.history` returns only the current branch, so a client could
        // not see that a session HAS alternatives, let alone switch.
        const { call, events } = harness();
        doStreamImpl = async () => textTurn("first answer");
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;

        await call("session.send", { sessionId, input: "question one" });
        await until(() => events().some((p) => p.sessionId === sessionId && p.part.type === "finish"));

        const before = await call("session.tree", { sessionId });
        const firstUser = before.result.rows.find((row: { role?: string; text?: string }) => row.role === "user");
        expect(firstUser.text).toBe("question one");
        expect(before.result.rows.every((row: { onPath: boolean }) => row.onPath)).toBe(true);

        // Rewind to the prompt's parent and answer differently: the first
        // answer becomes an abandoned branch, still in the tree.
        const branched = await call("session.branch", { sessionId, entryId: firstUser.parentId });
        expect(branched.error).toBeUndefined();
        expect(branched.result.leafId).toBe(firstUser.parentId);

        doStreamImpl = async () => textTurn("second answer");
        await call("session.send", { sessionId, input: "question two" });
        await until(() => events().filter((p) => p.sessionId === sessionId && p.part.type === "finish").length === 2);

        const after = await call("session.tree", { sessionId });
        const userRows = after.result.rows.filter((row: { role?: string }) => row.role === "user");
        // The branch the session is ON sorts first among siblings, so the
        // current one leads rather than being buried under an abandoned one.
        expect(userRows.map((row: { text: string }) => row.text)).toEqual(["question two", "question one"]);
        // The abandoned branch is off-path; the new one is on it.
        expect(userRows.find((r: { text: string }) => r.text === "question one").onPath).toBe(false);
        expect(userRows.find((r: { text: string }) => r.text === "question two").onPath).toBe(true);
        // Their shared parent is the branch point.
        expect(after.result.branchPointIds).toContain(firstUser.parentId);

        // History follows the leaf — that is what the model sees.
        const history = await call("session.history", { sessionId });
        const texts = JSON.stringify(history.result.entries);
        expect(texts).toContain("question two");
        expect(texts).not.toContain("question one");
    });

    test("session.branch refuses an entry the session does not have", async () => {
        const { call } = harness();
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        const { error } = await call("session.branch", { sessionId, entryId: "nope" });
        expect(error).toBeDefined();
        expect(String(error.message)).toContain("nope");
    });

    test("session.fork copies a branch into a new session", async () => {
        const { call, events } = harness();
        doStreamImpl = async () => textTurn("an answer");
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        await call("session.send", { sessionId, input: "the prompt" });
        await until(() => events().some((p) => p.sessionId === sessionId && p.part.type === "finish"));

        const tree = await call("session.tree", { sessionId });
        const userRow = tree.result.rows.find((row: { role?: string }) => row.role === "user");

        // "at" clones up to and including the entry (/clone).
        const cloned = await call("session.fork", { sessionId, entryId: userRow.id, position: "at" });
        expect(cloned.error).toBeUndefined();
        expect(cloned.result.sessionId).not.toBe(sessionId);
        expect(cloned.result.cwd).toBe(CWD);
        const clonedHistory = await call("session.history", { sessionId: cloned.result.sessionId });
        expect(JSON.stringify(clonedHistory.result.entries)).toContain("the prompt");

        // "before" forks at the prompt's parent and hands the text back, so a
        // client can put it in its composer without a second round trip.
        const forked = await call("session.fork", {
            sessionId,
            entryId: userRow.id,
            position: "before",
        });
        expect(forked.result.text).toBe("the prompt");
        const forkedHistory = await call("session.history", { sessionId: forked.result.sessionId });
        expect(JSON.stringify(forkedHistory.result.entries)).not.toContain("the prompt");

        // The original is untouched by either.
        const original = await call("session.history", { sessionId });
        expect(JSON.stringify(original.result.entries)).toContain("the prompt");
    });

    test("session.fork before only accepts a user message", async () => {
        const { call, events } = harness();
        doStreamImpl = async () => textTurn("an answer");
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        await call("session.send", { sessionId, input: "the prompt" });
        await until(() => events().some((p) => p.sessionId === sessionId && p.part.type === "finish"));

        const tree = await call("session.tree", { sessionId });
        const assistantRow = tree.result.rows.find((row: { role?: string }) => row.role === "assistant");
        const { error } = await call("session.fork", {
            sessionId,
            entryId: assistantRow.id,
            position: "before",
        });
        expect(error).toBeDefined();
        expect(String(error.message)).toContain("user message");
    });

    test("session.archive hides a session from the list without deleting it", async () => {
        // The gentler half of delete: everything stays, it just stops
        // appearing in the list you work from.
        const { call } = harness();
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        const has = async (params: Record<string, unknown>) =>
            (await call("session.list", { cwd: CWD, ...params })).result.some(
                (r: { id: string }) => r.id === sessionId,
            );

        expect(await has({})).toBe(true);

        const archived = await call("session.archive", { sessionId });
        expect(archived.result).toMatchObject({ ok: true, archived: true });

        // Gone from the working set, present in the archive, present in both.
        expect(await has({})).toBe(false);
        expect(await has({ archived: true })).toBe(true);
        expect(await has({ archived: "all" })).toBe(true);

        // The transcript is untouched — this is not a delete.
        expect((await call("session.history", { sessionId })).error).toBeUndefined();
        // And the row carries when it happened, which is what an archive sorts by.
        const row = (await call("session.list", { cwd: CWD, archived: true })).result.find(
            (r: { id: string }) => r.id === sessionId,
        );
        expect(typeof row.archivedAt).toBe("number");

        const restored = await call("session.archive", { sessionId, archived: false });
        expect(restored.result).toMatchObject({ ok: true, archived: false });
        expect(await has({})).toBe(true);
        expect(await has({ archived: true })).toBe(false);
    });

    test("session.archive reports a session that was never there", async () => {
        const { call } = harness();
        const { result, error } = await call("session.archive", { sessionId: "nope-nope" });
        expect(error).toBeUndefined();
        expect(result.ok).toBe(false);
    });

    test("session.archive does not refuse while a turn is running", async () => {
        // Putting a conversation away does not disturb it, so forcing you to
        // stop the agent first would be gratuitous — unlike delete, which
        // pulls the transcript out from under a running turn.
        const { call } = harness();
        let release: (() => void) | undefined;
        doStreamImpl = async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return textTurn("done");
        };
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        await call("session.send", { sessionId, input: "hi" });
        await until(() => release !== undefined);

        const { result, error } = await call("session.archive", { sessionId });
        expect(error).toBeUndefined();
        expect(result.archived).toBe(true);
        release?.();
    });

    test("session.delete removes the session and its entries", async () => {
        const { call } = harness();
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        expect((await call("session.list", { cwd: CWD })).result.some((r: { id: string }) => r.id === sessionId)).toBe(
            true,
        );

        const deleted = await call("session.delete", { sessionId });
        expect(deleted.error).toBeUndefined();
        expect(deleted.result.ok).toBe(true);
        expect((await call("session.list", { cwd: CWD })).result.some((r: { id: string }) => r.id === sessionId)).toBe(
            false,
        );
        // Gone for good: the transcript cannot be replayed afterwards.
        expect((await call("session.history", { sessionId })).error).toBeDefined();
    });

    test("session.delete reports a session that was never there", async () => {
        // Distinguishable from a successful delete, so a caller can tell
        // "already gone" from "removed it".
        const { call } = harness();
        const { result, error } = await call("session.delete", { sessionId: "nope-nope" });
        expect(error).toBeUndefined();
        expect(result.ok).toBe(false);
    });

    test("session.delete refuses while a turn is running", async () => {
        const { call } = harness();
        let release: (() => void) | undefined;
        doStreamImpl = async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return textTurn("done");
        };
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        await call("session.send", { sessionId, input: "hi" });
        await until(() => release !== undefined);

        const { error } = await call("session.delete", { sessionId });
        expect(error).toBeDefined();
        expect(String(error.message)).toContain("running");
        release?.();
    });

    test.each([["session.send"], ["session.cancel"], ["session.compact"], ["session.history"], ["cost.session"]])(
        "%s on an unopened session errors instead of crashing",
        async (method) => {
            const { call } = harness();
            const { result, error } = await call(method, { sessionId: "nope-nope", input: "x" });
            expect(result).toBeUndefined();
            expect(error).toBeDefined();
            expect(String(error.message)).toContain("nope-nope");
        },
    );
});

describe("rpc: turn streaming", () => {
    test("session.send streams the whole event sequence as notifications", async () => {
        const { call, events } = harness();
        doStreamImpl = async () => textTurn("streamed answer");
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;

        const ack = await call("session.send", { sessionId, input: "hi" });
        expect(ack.result.ok).toBe(true); // returns immediately; events stream after

        await until(() => events().some((p) => p.part.type === "finish"));
        const mine = events().filter((p) => p.sessionId === sessionId);
        const deltas = mine.filter((p) => p.part.type === "text-delta");
        expect(deltas.length).toBeGreaterThan(0);
        expect(deltas.map((p) => p.part.data).join("")).toBe("streamed answer");
        expect(mine.some((p) => p.part.type === "finish")).toBe(true);
        // step-usage now rides the wire (was dropped by the old 7-event list).
        expect(mine.some((p) => p.part.type === "step-usage")).toBe(true);

        // The assistant answer is persisted and replays via history.
        const hist = await call("session.history", { sessionId });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assistant = (hist.result.entries as any[]).find((e) => e.type === "message" && e.role === "assistant");
        expect(JSON.stringify(assistant.content)).toContain("streamed answer");
    });

    test("session.cancel aborts the in-flight model stream", async () => {
        const { call, events } = harness();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let signal: AbortSignal | undefined;
        doStreamImpl = async (options) => {
            signal = options.abortSignal;
            // Long stream so cancel lands mid-flight.
            return textTurn("x".repeat(200));
        };
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;

        await call("session.send", { sessionId, input: "go" });
        await until(() => !!signal); // model started
        const res = await call("session.cancel", { sessionId });
        expect(res.result.ok).toBe(true);
        expect(signal!.aborted).toBe(true);
        // Abort used to skip the stream `finish` part — web clients stayed
        // "running" forever. We synthesize finish so Stop unlocks the UI.
        await until(() => events().some((p) => p.sessionId === sessionId && p.part.type === "finish"));
    });

    test("a turn that throws is reported on the same error channel", async () => {
        const { call, events } = harness();
        doStreamImpl = async () => {
            throw new Error("boom-from-model");
        };
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;
        await call("session.send", { sessionId, input: "hi" });

        await until(() => events().some((p) => p.sessionId === sessionId && p.part.type === "error"));
        const err = events().find((p) => p.sessionId === sessionId && p.part.type === "error");
        // Normalized shape: error rides `part.data`, like the emitter's error event.
        // Flattened to plain data first — an Error's `message` is non-enumerable,
        // so the raw object JSON-serialised to `{}` and every client that is not
        // in this process saw a failure with nothing in it.
        expect(err.part.data.message).toContain("boom-from-model");
        expect(JSON.parse(JSON.stringify(err.part.data)).message).toContain("boom-from-model");
    });
});

describe("rpc: auth / catalog / cost", () => {
    test("auth.login validates its inputs then persists the key", async () => {
        const { call } = harness();
        const bad = await call("auth.login", { provider: "anthropic" }); // no apiKey
        expect(bad.error).toBeDefined();

        const ok = await call("auth.login", { provider: "anthropic", apiKey: "sk-test-123" });
        expect(ok.result.ok).toBe(true);
        const status = await call("auth.status");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((status.result.providers as any[]).map((p) => (typeof p === "string" ? p : p.id))).toContain(
            "anthropic",
        );
    });

    test("catalog.list returns models and honors the provider filter", async () => {
        const { call } = harness();
        const all = await call("catalog.list");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = all.result as any[];
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBeGreaterThan(0);
        const anth = await call("catalog.list", { provider: "anthropic" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((anth.result as any[]).every((m) => m.provider === "anthropic")).toBe(true);
    });

    test("cost.lifetime returns a breakdown object", async () => {
        const { call } = harness();
        const res = await call("cost.lifetime");
        expect(res.error).toBeUndefined();
        expect(typeof res.result).toBe("object");
    });

    /**
     * `config.reload` has to be EXECUTED, not merely dispatched-to.
     *
     * It shipped once with an unimported `settingsStore`, which is a plain
     * ReferenceError the moment the branch runs — and nothing ran it, so the
     * first thing to find out was the user's `/reload`. Any assertion here
     * would have caught it; the point is that the branch executes at all.
     */
    test("config.reload re-reads config and reports what it found", async () => {
        const { call } = harness();
        const res = await call("config.reload", { cwd: CWD });
        expect(res.error).toBeUndefined();
        const summary = res.result as Record<string, number>;
        // Counts, not just an object: they are what the client shows as proof
        // the reload did something, and a missing field renders as "0".
        for (const key of ["models", "availableModels", "commands", "agents", "providers"]) {
            expect(typeof summary[key]).toBe("number");
        }
        // The catalog is real, so a reload that reports zero models re-read
        // nothing — which is the failure this call exists to prevent.
        expect(summary.models).toBeGreaterThan(0);
        expect(summary.commands).toBeGreaterThan(0);
    });

    test("config.reload is advertised, so a client can tell an older loop", async () => {
        const { call } = harness();
        const { result } = await call("server.info");
        expect(result.methods).toContain("config.reload");
    });
});

describe("rpc: client over a unix socket (end to end)", () => {
    test("RpcClient calls, streams notifications, and rejects on error", async () => {
        const { server, socketPath } = startSocketServer();
        const client = new RpcClient(socketPath);
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const info: any = await client.call("server.info");
            expect(info.methods).toContain("session.create");

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const events: any[] = [];
            client.on("session.event", (p: unknown) => events.push(p));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const created: any = await client.call("session.create", {
                cwd: CWD,
                provider: "anthropic",
                model: MODEL,
            });
            doStreamImpl = async () => textTurn("over the socket");
            await client.call("session.send", { sessionId: created.sessionId, input: "hi" });
            await until(() => events.some((p) => p.part.type === "finish"));
            expect(events.some((p) => p.part.type === "text-delta")).toBe(true);

            // Errors surface as a rejected promise, not a hang.
            await expect(client.call("does.not.exist")).rejects.toBeDefined();
        } finally {
            client.close();
            server.close();
        }
    });
});

describe("rpc: agents", () => {
    test("agent.list reports the agents a picker can offer", async () => {
        const { call } = harness();
        const { result, error } = await call("agent.list", {});
        expect(error).toBeUndefined();
        expect(Array.isArray(result)).toBe(true);
        // Built-ins are always there, and the prompt (pages long) is not sent.
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toHaveProperty("name");
        expect(result[0]).not.toHaveProperty("prompt");
    });

    test("session.send refuses an agent that does not exist", async () => {
        // Falling back to the default persona would look like the agent had
        // simply ignored its instructions.
        const { call } = harness();
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const { error } = await call("session.send", {
            sessionId: created.result.sessionId,
            input: "hi",
            agent: "no-such-agent",
        });
        expect(error).toBeDefined();
        expect(String(error.message)).toContain("no-such-agent");
    });

    test("session.send accepts a known agent for one turn", async () => {
        const { call } = harness();
        doStreamImpl = async () => textTurn("done");
        const agents = await call("agent.list", {});
        const name = (agents.result as { name: string }[])[0]!.name;
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const { result, error } = await call("session.send", {
            sessionId: created.result.sessionId,
            input: "hi",
            agent: name,
        });
        expect(error).toBeUndefined();
        expect(result.ok).toBe(true);
    });

    test("agent.get carries the prompt agent.list withholds", async () => {
        // The picker needs names; an editor needs the document. Two methods
        // rather than one so a picker never pays for pages of prompt.
        const { call } = harness();
        const { result, error } = await call("agent.get", { name: "plan" });
        expect(error).toBeUndefined();
        expect(result.prompt.length).toBeGreaterThan(100);
        expect(result.builtin).toBe(true);
        // A built-in's tool set is fixed — the editor must not offer to edit it.
        expect(result.toolsEditable).toBe(false);
        expect(result.hasOverride).toBe(false);
    });

    test("agent.get refuses a name that is not an agent", async () => {
        const { call } = harness();
        const { error } = await call("agent.get", { name: "nope" });
        expect(error).toBeDefined();
        expect(String(error.message)).toContain("nope");
    });

    test("agent.save then agent.delete round-trips a custom agent", async () => {
        const { call } = harness();
        const prompt = "You are a reviewer. ".repeat(10);
        const saved = await call("agent.save", {
            name: "rpc-reviewer",
            prompt,
            tools: ["read", "grep", "ls"],
        });
        expect(saved.error).toBeUndefined();

        const got = await call("agent.get", { name: "rpc-reviewer" });
        expect(got.result.prompt.trim()).toBe(prompt.trim());
        expect(got.result.tools).toEqual(["read", "grep", "ls"]);
        expect(got.result.toolsEditable).toBe(true);

        const listed = (await call("agent.list", {})).result as { name: string }[];
        expect(listed.some((a) => a.name === "rpc-reviewer")).toBe(true);

        expect((await call("agent.delete", { name: "rpc-reviewer" })).result.ok).toBe(true);
        // Already gone is `{ok:false}`, not an error — so a caller can tell
        // "removed it" from "there was nothing to remove".
        expect((await call("agent.delete", { name: "rpc-reviewer" })).result.ok).toBe(false);
        expect((await call("agent.get", { name: "rpc-reviewer" })).error).toBeDefined();
    });

    test("agent.save refuses a name that would not be addressable", async () => {
        const { call } = harness();
        // The name becomes a filename AND a /command, so path characters are
        // rejected rather than sanitized into a different agent.
        const bad = await call("agent.save", { name: "../escape", prompt: "x".repeat(30) });
        expect(bad.error).toBeDefined();
        expect(String(bad.error.message)).toContain("Invalid agent name");
        // An agent with no prompt is not an agent.
        const empty = await call("agent.save", { name: "blankagent", prompt: "   " });
        expect(empty.error).toBeDefined();
    });

    test("agent.save leaves a built-in's fixed tool set alone", async () => {
        // Overriding plan's prompt is allowed; widening its tools is not —
        // saveAgent drops `tools` for built-ins rather than trusting the caller.
        const { call } = harness();
        const before = (await call("agent.get", { name: "plan" })).result.tools;
        await call("agent.save", {
            name: "plan",
            prompt: "Plan carefully and never edit files. ".repeat(6),
            tools: ["read", "write", "edit", "bash"],
        });
        const after = await call("agent.get", { name: "plan" });
        expect(after.result.tools).toEqual(before);
        // The prompt override took, and is now resettable.
        expect(after.result.prompt).toContain("Plan carefully");
        expect(after.result.hasOverride).toBe(true);

        // Deleting a built-in resets the prompt instead of removing the agent.
        expect((await call("agent.delete", { name: "plan" })).result.ok).toBe(true);
        const reset = await call("agent.get", { name: "plan" });
        expect(reset.result.prompt).not.toContain("Plan carefully");
        expect(reset.result.hasOverride).toBe(false);
    });

    test("agent.tools offers extension tools, not just the static list", async () => {
        const { call } = harness();
        const { result } = await call("agent.tools", {});
        expect(result).toContain("read");
        expect(result).toContain("task");
    });
});

describe("rpc: the ask tool", () => {
    test("puts a question to the client and resolves with the answer", async () => {
        // Registering a bridge is what makes the tool exist at all — RPC
        // clients never saw a question before, because none was registered.
        const { call, events } = harness();
        const created = await call("session.create", { cwd: CWD, provider: "anthropic", model: MODEL });
        const sessionId = created.result.sessionId as string;

        const { getAskUserBridge } = await import("../src/tools/ask-bridge");
        const bridge = getAskUserBridge();
        expect(bridge).not.toBeNull();

        // Ask from inside a running turn so the session context is set.
        let answers: unknown;
        doStreamImpl = async () => {
            answers = await bridge!.ask([
                { question: "Which?", header: "Pick", options: [{ label: "A", description: "" }] },
            ]);
            return textTurn("done");
        };
        await call("session.send", { sessionId, input: "hi" });

        await until(() => events().some((p) => p.part.type === "ask"));
        const asked = events().find((p) => p.part.type === "ask")!;
        const { askId, questions } = asked.part.data as { askId: string; questions: unknown[] };
        expect(questions).toHaveLength(1);

        const ack = await call("session.answer", { askId, answers: [{ answers: ["A"] }] });
        expect(ack.result.ok).toBe(true);
        await until(() => answers !== undefined);
        expect(answers).toEqual([{ answers: ["A"] }]);
    });

    test("declines rather than hanging when nobody is watching the session", async () => {
        // No session context at all: a turn that waited here would never end.
        const { getAskUserBridge } = await import("../src/tools/ask-bridge");
        const answers = await getAskUserBridge()!.ask([{ question: "Which?", header: "Pick", options: [] }]);
        expect(answers).toEqual([{ answers: [], declined: true }]);
    });

    test("answering an id the server has forgotten is reported, not thrown", async () => {
        const { call } = harness();
        const { result, error } = await call("session.answer", { askId: "ask-999", answers: [] });
        expect(error).toBeUndefined();
        expect(result.ok).toBe(false);
    });
});

describe("rpc mcp", () => {
    test("mcp.list reports the master switch, the project config path, and that nothing is connected yet", async () => {
        // Deliberately does not connect: listing must draw immediately, and a
        // connect is up to 30s per server.
        const { call } = harness();
        const { result, error } = await call("mcp.list", { cwd: CWD });
        expect(error).toBeUndefined();
        expect(result.enabled).toBe(true);
        expect(result.connected).toBe(false);
        expect(result.projectConfigPath.startsWith(CWD)).toBe(true);
        expect(result.servers).toEqual([]);
    });

    test("a config that could never connect is refused instead of written", async () => {
        // The entry lands in settings.json before anything tries to use it, so
        // a silently accepted `{}` becomes a permanent broken row.
        const { call } = harness();
        expect((await call("mcp.add", { name: "nope", config: {} })).error?.message).toContain("command");
        expect((await call("mcp.add", { name: "nope", config: { type: "http" } })).error?.message).toContain("url");
        expect(
            (await call("mcp.add", { name: "nope", config: { type: "http", url: "not a url" } })).error?.message,
        ).toContain("not a valid url");
        expect((await call("mcp.add", { name: "nope", config: { type: "carrier-pigeon" } })).error?.message).toContain(
            "unknown transport",
        );
        expect((await call("mcp.add", { name: "  ", config: { command: "x" } })).error?.message).toContain("name");
    });

    test("a project server is written to the project file and listed with its scope", async () => {
        const { call } = harness();
        const added = await call("mcp.add", {
            cwd: CWD,
            scope: "project",
            name: "probe",
            // `false` is a real command that exits 0/1 immediately, so the
            // connect fails fast instead of spawning something long-lived.
            config: { command: "false" },
        });
        expect(added.error).toBeUndefined();

        const listed = await call("mcp.list", { cwd: CWD });
        const row = listed.result.servers.find((s: { name: string }) => s.name === "probe");
        expect(row.scope).toBe("project");
        expect(row.transport).toBe("stdio");
        expect(row.command).toBe("false");
        expect(row.oauth).toBe(false);

        const removed = await call("mcp.remove", { cwd: CWD, scope: "project", name: "probe" });
        expect(removed.result.ok).toBe(true);
        expect(
            (await call("mcp.list", { cwd: CWD })).result.servers.some((s: { name: string }) => s.name === "probe"),
        ).toBe(false);
    });

    test("logging in to a server this process has not connected is refused, not left hanging", async () => {
        const { call } = harness();
        const { error } = await call("mcp.login.start", { name: "ghost" });
        expect(error?.message).toContain("unknown MCP server");
    });

    test("polling an unknown login says so; cancelling one is idempotent", async () => {
        const { call } = harness();
        expect((await call("mcp.login.poll", { flowId: "nope" })).error?.message).toContain("unknown MCP login");
        expect((await call("mcp.login.cancel", { flowId: "nope" })).result.ok).toBe(true);
    });
});

describe("rpc: datasources", () => {
    const base = {
        type: "postgres",
        host: "db.internal",
        port: 5432,
        database: "analytics",
        user: "reader",
    };
    const find = async (
        call: (m: string, p?: unknown) => Promise<any>,
        id: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> => (await call("datasource.list")).result.find((d: { id: string }) => d.id === id);

    test("a saved password is never returned by list", async () => {
        // `loop serve` is reachable over a network — a stored secret must not
        // ride a list response just because the desktop happens to be local.
        const { call } = harness();
        await call("datasource.save", { id: "warehouse", config: { ...base, password: "hunter2" } });

        const row = await find(call, "warehouse");
        expect(row.config.host).toBe("db.internal");
        expect(row.hasPassword).toBe(true);
        expect(row.config.password).toBeUndefined();
        expect(JSON.stringify(row)).not.toContain("hunter2");
    });

    test("an env placeholder IS returned — it is a pointer, not a secret", async () => {
        const { call } = harness();
        await call("datasource.save", { id: "viaenv", config: { ...base, password: "${env:PGPASSWORD}" } });

        const row = await find(call, "viaenv");
        expect(row.config.password).toBe("${env:PGPASSWORD}");
        expect(row.passwordIsEnvRef).toBe(true);
    });

    test("editing without resending the password keeps it", async () => {
        // The list withholds it, so an edit form has none to send back —
        // treating that silence as "clear it" would break the connection every
        // time someone corrected a port.
        const { call } = harness();
        await call("datasource.save", { id: "keep", config: { ...base, password: "secret" } });
        await call("datasource.save", { id: "keep", config: { ...base, port: 6543 } });

        const row = await find(call, "keep");
        expect(row.config.port).toBe(6543);
        expect(row.hasPassword).toBe(true);
    });

    test("an empty password is an explicit clear", async () => {
        const { call } = harness();
        await call("datasource.save", { id: "clearme", config: { ...base, password: "secret" } });
        await call("datasource.save", { id: "clearme", config: { ...base, password: "" } });
        expect((await find(call, "clearme")).hasPassword).toBe(false);
    });

    test("a bad config is refused instead of stored", async () => {
        const { call } = harness();
        expect((await call("datasource.save", { id: "bad", config: { ...base, port: 0 } })).error?.message).toContain(
            "not a valid port",
        );
        expect((await call("datasource.save", { id: "BAD ID", config: base })).error?.message).toContain(
            "invalid connection id",
        );
        expect(await find(call, "bad")).toBeUndefined();
    });

    test("remove reports whether anything was there", async () => {
        const { call } = harness();
        await call("datasource.save", { id: "gone", config: base });
        expect((await call("datasource.remove", { id: "gone" })).result.ok).toBe(true);
        expect((await call("datasource.remove", { id: "gone" })).result.ok).toBe(false);
        expect(await find(call, "gone")).toBeUndefined();
    });

    test("testing an unknown datasource says so rather than hanging", async () => {
        const { call } = harness();
        const { error } = await call("datasource.test", { id: "nosuch" });
        expect(error?.message).toContain("unknown datasource");
    });
});

/**
 * Artifacts never cross the network.
 *
 * `loop serve` binds 0.0.0.0 by default and an artifact is a page the agent
 * wrote out of the contents of a repo. Refusing the whole family at the RPC
 * layer — rather than leaving a client to decline to render them — is what
 * makes "artifacts are local" a property of the server instead of a habit of
 * one UI.
 */
describe("rpc: artifacts are local-only", () => {
    const ARTIFACT_METHODS = ["artifact.list", "artifact.get", "artifact.read", "artifact.export", "artifact.delete"];

    test("the local server answers them", async () => {
        const { call } = harness();
        const { result, error } = await call("artifact.list");
        expect(error).toBeUndefined();
        expect(Array.isArray(result)).toBe(true);
    });

    test("a server reachable over the network refuses every one", async () => {
        const { call } = harness({ remote: true });
        for (const method of ARTIFACT_METHODS) {
            const { error } = await call(method, { id: "a1b2c3d4e5f6" });
            expect(error).toBeDefined();
            // Names the method and says why, so the refusal is diagnosable from
            // the client rather than looking like an unknown-method error.
            expect(error.message).toContain(method);
            expect(error.message).toContain("serve");
        }
    });

    test("the refusal is about the transport, not about the artifact existing", async () => {
        // A bogus id over the local socket reports the artifact is missing; the
        // same call over the network must not reveal even that much.
        const local = await harness().call("artifact.get", { id: "a1b2c3d4e5f6" });
        expect(local.error.message).toContain("no such artifact");

        const remote = await harness({ remote: true }).call("artifact.get", { id: "a1b2c3d4e5f6" });
        expect(remote.error.message).not.toContain("no such artifact");
    });

    test("the rest of the surface still works over the network", async () => {
        // The gate must be artifact-shaped, not a blanket lockout of serve.
        const { call } = harness({ remote: true });
        const { result, error } = await call("server.info");
        expect(error).toBeUndefined();
        expect(result.methods).toContain("artifact.list");
    });
});
