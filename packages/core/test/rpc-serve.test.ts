import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempSessionDb } from "./helpers/temp-db";

// In-memory token store so tests never touch the real ~/.loop/auth.json.
let storedToken: string | undefined;
mock.module("../src/rpc/serve-token-store", () => ({
    getStoredServeToken: () => storedToken,
    storeServeToken: (t: string) => {
        storedToken = t;
    },
}));

// In-memory settings so settings.set never writes the real ~/.loop/settings.json
// (same pattern as bash-approve.test.ts).
const memSettings: Record<string, unknown> = {};
mock.module("../src/settings", () => ({
    getSetting: (k: string) => memSettings[k],
    setSetting: (k: string, v: unknown) => {
        memSettings[k] = v;
    },
}));

const { getOrCreateServeToken, isLoopbackHost, remoteTerminalFor, startWebServer } = await import("../src/rpc/serve");
const { writeAttachmentPayloads, RpcServer } = await import("../src/rpc/server");
const { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } = await import("../src/rpc/protocol");
import type { ServeHandle } from "../src/rpc/serve";

/** In-memory transport for driving an RpcServer directly. */
function fakeTransport() {
    const sent: Array<Record<string, unknown>> = [];
    return {
        sent,
        send(msg: unknown) {
            sent.push(msg as Record<string, unknown>);
        },
        /** Responses to a given request id. */
        response(id: number) {
            return sent.find((m) => m.id === id);
        },
        /** All session.event notification params. */
        events() {
            return sent
                .filter((m) => m.method === "session.event")
                .map((m) => m.params as { sessionId: string; seq: number; part: { type: string; data: unknown } });
        },
    };
}

/** Unknown-provider sends fail at getModel; keep budget for init under CI load. */
async function until(cond: () => boolean, label: string, tries = 1000, ms = 10): Promise<void> {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, ms));
    }
    // Name the starved wait — the async stack loses the call site, and an
    // unlabeled "condition not met" cost a week of red ci (see issue #3).
    throw new Error(`until: condition not met: ${label}`);
}

describe("serve token", () => {
    test("generated once, then stable across calls", () => {
        storedToken = undefined;
        const first = getOrCreateServeToken();
        expect(first).toMatch(/^[0-9a-f]{48}$/);
        expect(getOrCreateServeToken()).toBe(first);
    });

    test("existing stored token is reused, not replaced", () => {
        storedToken = "a".repeat(48);
        expect(getOrCreateServeToken()).toBe(storedToken);
    });
});

describe("isLoopbackHost", () => {
    test("loopback names", () => {
        expect(isLoopbackHost("127.0.0.1")).toBe(true);
        expect(isLoopbackHost("::1")).toBe(true);
        expect(isLoopbackHost("localhost")).toBe(true);
        expect(isLoopbackHost("0.0.0.0")).toBe(false);
        expect(isLoopbackHost("192.168.1.4")).toBe(false);
    });
});

describe("writeAttachmentPayloads", () => {
    // 1x1 transparent PNG
    const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const PDF_B64 = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");

    test("writes temp files and returns [image:] sentinels", async () => {
        const out = writeAttachmentPayloads([{ data: PNG_B64, mediaType: "image/png" }]);
        const m = out.match(/^\n\[image:(.+\.png)\]$/);
        expect(m).not.toBeNull();
        const file = Bun.file(m![1]!);
        expect(await file.exists()).toBe(true);
        expect(file.size).toBeGreaterThan(0);
    });

    test("takes PDFs too — extractImagesFromInput has always read .pdf sentinels", async () => {
        // Whether the chosen model may actually receive it is runTurn's call
        // (filterAttachmentsByModalities), not this function's: refusing here
        // meant no GUI client could attach a PDF to ANY model.
        const out = writeAttachmentPayloads([{ data: PDF_B64, mediaType: "application/pdf" }]);
        const m = out.match(/^\n\[image:(.+\.pdf)\]$/);
        expect(m).not.toBeNull();
        expect(await Bun.file(m![1]!).exists()).toBe(true);
    });

    test("rejects unknown media types, junk, and empty payloads", () => {
        expect(writeAttachmentPayloads(undefined)).toBe("");
        expect(writeAttachmentPayloads([])).toBe("");
        expect(writeAttachmentPayloads([{ data: PNG_B64, mediaType: "text/plain" }])).toBe("");
        expect(writeAttachmentPayloads([{ data: 42, mediaType: "image/png" }])).toBe("");
        expect(writeAttachmentPayloads([{ data: "", mediaType: "image/png" }])).toBe("");
    });
});

describe("multi-client broadcast + seq replay", () => {
    useTempSessionDb();

    test("events broadcast to every subscriber; attach replays; detach stops delivery", async () => {
        const server = new RpcServer();
        const a = fakeTransport();
        const b = fakeTransport();
        const c = fakeTransport();
        const fa = server.attach(a);
        const fb = server.attach(b);
        const fc = server.attach(c);
        // Real writable cwd — "/tmp" alone can fail create on some runners /
        // sandboxes and leaves response(1) undefined.
        const cwd = mkdtempSync(join(tmpdir(), "loop-rpc-"));

        // a creates (auto-subscribed); b attaches explicitly.
        fa.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session.create",
                params: { cwd, provider: "nope", model: "nope/model" },
            }) + "\n",
        );
        await until(() => !!a.response(1), "session.create response");
        const sid = (a.response(1) as { result: { sessionId: string } }).result.sessionId;
        fb.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.attach", params: { sessionId: sid } }) + "\n");
        await until(() => !!b.response(1), "session.attach response (b)");
        expect((b.response(1) as { result: { running: boolean } }).result.running).toBe(false);

        // session.list reflects both watchers, and re-opening from b does NOT
        // reset the shared context (attached count survives).
        fb.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.open", params: { sessionId: sid } }) + "\n");
        fb.feed(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session.list", params: {} }) + "\n");
        await until(() => !!b.response(3), "session.list response");
        const listed = (b.response(3) as { result: Array<{ id: string; attached: number; running: boolean }> }).result;
        expect(listed.find((s) => s.id === sid)?.attached).toBe(2);

        // A send on a bogus provider fails at getModel — the error event must
        // reach BOTH subscribers, with a seq stamp. Wait for the error on both
        // (fixed settle windows raced under load and saw mid-turn deltas first).
        fa.feed(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.send", params: { sessionId: sid, input: "hi" } }) +
                "\n",
        );
        await until(
            () => a.events().some((e) => e.part.type === "error") && b.events().some((e) => e.part.type === "error"),
            "error event broadcast to a AND b",
        );
        const aEvents = a.events();
        const bEvents = b.events();
        expect(aEvents.length).toBeGreaterThan(0);
        expect(bEvents.length).toBe(aEvents.length);
        expect(aEvents.some((e) => e.part.type === "error")).toBe(true);
        expect(bEvents.some((e) => e.part.type === "error")).toBe(true);
        expect(aEvents[0]!.seq).toBe(1);
        const total = aEvents.length;

        // c attaches with afterSeq 0 → full replay of the ring.
        fc.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session.attach",
                params: { sessionId: sid, afterSeq: 0 },
            }) + "\n",
        );
        await until(() => !!c.response(1) && c.events().length === total, "attach replay to c");
        expect(c.events().length).toBe(total);
        expect((c.response(1) as { result: { resync: boolean; seq: number } }).result).toMatchObject({
            resync: false,
            seq: total,
        });

        // afterSeq beyond the server's counter (client from a previous server
        // life) → resync, no replay.
        const d = fakeTransport();
        const fd = server.attach(d);
        fd.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session.attach",
                params: { sessionId: sid, afterSeq: 9999 },
            }) + "\n",
        );
        await until(() => !!d.response(1), "session.attach response (d, resync)");
        expect((d.response(1) as { result: { resync: boolean } }).result.resync).toBe(true);
        expect(d.events().length).toBe(0);

        // b detaches (transport close); the next failing send reaches a but not b.
        fb.close();
        const aBefore = a.events().length;
        const bBefore = b.events().length;
        fa.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "session.send",
                params: { sessionId: sid, input: "again" },
            }) + "\n",
        );
        await until(() => a.events().length > aBefore, "post-detach error broadcast to a");
        expect(a.events().length).toBeGreaterThan(aBefore);
        expect(b.events().length).toBe(bBefore);
        // Real runTurn spins up a session + fails on the bogus provider; ~240ms
        // locally but a loaded CI runner blows past the 5s default. Give it room.
    }, 30000);
});

// Turn events reach a session's subscribers; `session.status` reaches every
// client, so a list elsewhere learns that a turn started or ended.
// The handshake (protocol.ts), on a real server.
describe("hello", () => {
    const say = async (protocol: unknown) => {
        const server = new RpcServer({ version: "1.2.3", askBridge: false });
        const sent: Array<{ id?: number; result?: any; error?: { message: string } }> = [];
        const { feed } = server.attach({ send: (m) => sent.push(m as never) });
        feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol, client: "test" } }) + "\n");
        for (let i = 0; i < 100 && !sent.some((m) => m.id === 1); i++) await Bun.sleep(10);
        server.dispose();
        return sent.find((m) => m.id === 1)!;
    };

    test("answers with its protocol, its minimum, its release and what it offers", async () => {
        const reply = await say(PROTOCOL_VERSION);
        expect(reply.result.protocol).toEqual([...PROTOCOL_VERSION]);
        expect(reply.result.minClientProtocol).toEqual([...MIN_CLIENT_PROTOCOL]);
        expect(reply.result.version).toBe("1.2.3");
        expect(reply.result.capabilities).toContain("status");
    });

    test("refuses another major with the sentence that says which side to update", async () => {
        const reply = await say([PROTOCOL_VERSION[0] + 1, 0]);
        expect(reply.error?.message).toContain("protocol");
        expect(reply.error?.message).toContain("loop update");
    });
});

// session.history {afterEntryId}: only the branch after what the client holds.
describe("history tails", () => {
    useTempSessionDb();

    test("sends what follows a known entry, and the whole branch for an unknown one", async () => {
        const server = new RpcServer({ askBridge: false });
        const t = fakeTransport();
        const f = server.attach(t);
        const cwd = mkdtempSync(join(tmpdir(), "loop-rpc-"));
        let id = 0;
        const call = async (method: string, params: unknown) => {
            const my = ++id;
            f.feed(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
            await until(() => !!t.response(my), method);
            return (t.response(my) as { result: any }).result;
        };
        const { sessionId } = await call("session.create", { cwd, provider: "nope", model: "nope/model" });
        // A few entries on the branch.
        for (const name of ["one", "two", "three"]) await call("session.rename", { sessionId, name });
        const whole = await call("session.history", { sessionId });
        expect(whole.tail).toBeUndefined();
        const all = whole.entries as Array<{ id?: string }>;
        expect(all.length).toBeGreaterThan(2);

        const anchor = all[1]!.id!;
        const tail = await call("session.history", { sessionId, afterEntryId: anchor });
        expect(tail.tail).toEqual({ afterEntryId: anchor });
        expect((tail.entries as Array<{ id?: string }>).map((e) => e.id)).toEqual(all.slice(2).map((e) => e.id));

        const unknown = await call("session.history", { sessionId, afterEntryId: "not-on-the-branch" });
        expect(unknown.tail).toBeUndefined();
        expect(unknown.entries).toHaveLength(all.length);
        server.dispose();
    });
});

describe("host-wide session status", () => {
    useTempSessionDb();

    test("a new session and its turn are announced to clients not attached to it", async () => {
        const server = new RpcServer();
        const sender = fakeTransport();
        const bystander = fakeTransport();
        const fs = server.attach(sender);
        server.attach(bystander);
        const cwd = mkdtempSync(join(tmpdir(), "loop-rpc-"));
        fs.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session.create",
                params: { cwd, provider: "nope", model: "nope/model" },
            }) + "\n",
        );
        await until(() => !!sender.response(1), "session.create response");
        const sid = (sender.response(1) as { result: { sessionId: string } }).result.sessionId;
        // An unknown provider fails the turn — still a start and an end.
        fs.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.send", params: { sessionId: sid, input: "hi" } }) + "\n");
        const notices = () =>
            bystander.sent
                .filter((m) => m.method === "session.status")
                .map((m) => m.params as { sessionId: string; change: string; running?: boolean });
        await until(() => notices().some((n) => n.change === "running" && n.running === false), "turn end notice");
        expect(notices().map((n) => (n.change === "running" ? `running:${n.running}` : n.change))).toEqual([
            "created",
            "running:true",
            "running:false",
        ]);
        expect(notices().every((n) => n.sessionId === sid)).toBe(true);
        // The bystander never subscribed, so it got no turn events.
        expect(bystander.events()).toHaveLength(0);
        server.dispose();
    });
});

describe("remoteTerminalFor", () => {
    test("paired devices get the terminal unless it was turned off", () => {
        expect(remoteTerminalFor({}, undefined)).toBe(true);
        expect(remoteTerminalFor({}, true)).toBe(true);
        expect(remoteTerminalFor({}, false)).toBe(false);
        // One run's flag beats the setting, either way.
        expect(remoteTerminalFor({ terminal: true }, false)).toBe(true);
        expect(remoteTerminalFor({ "no-terminal": true }, true)).toBe(false);
        expect(remoteTerminalFor({ terminal: true, "no-terminal": true }, undefined)).toBe(false);
    });
});

describe("session.send", () => {
    useTempSessionDb();

    test("an empty message is refused rather than run as a turn", async () => {
        const server = new RpcServer();
        const client = fakeTransport();
        const fs = server.attach(client);
        const cwd = mkdtempSync(join(tmpdir(), "loop-rpc-"));
        fs.feed(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session.create",
                params: { cwd, provider: "nope", model: "nope/model" },
            }) + "\n",
        );
        await until(() => !!client.response(1), "session.create response");
        const sid = (client.response(1) as { result: { sessionId: string } }).result.sessionId;
        fs.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.send", params: { sessionId: sid, input: "  " } }) + "\n");
        fs.feed(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session.send", params: { sessionId: sid, text: "wrong field" } }) + "\n");
        await until(() => !!client.response(2) && !!client.response(3), "send responses");
        for (const id of [2, 3]) {
            expect((client.response(id) as { error?: { message: string } }).error?.message).toContain("needs a message");
        }
        // Nothing ran: no turn events reached the client.
        expect(client.events()).toHaveLength(0);
        server.dispose();
    });
});

describe("startWebServer", () => {
    useTempSessionDb();

    let handle: ServeHandle;
    let token: string;
    const base = () => `http://127.0.0.1:${handle.port}`;

    beforeAll(() => {
        storedToken = undefined;
        // port 0 = OS-assigned free port; keeps parallel test runs collision-free.
        // No UI: these cover the token, the socket and the RPC surface.
        handle = startWebServer({ port: 0, webAppDir: null });
        token = getOrCreateServeToken();
    });
    afterAll(() => {
        handle.stop();
    });

    test("reports the bound port and a token URL", () => {
        expect(handle.port).toBeGreaterThan(0);
        expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/?token=${token}`);
        // Loopback bind has no network face — no LAN URLs to advertise.
        expect(handle.networkUrls).toEqual([]);
    });

    test("with no UI built, pages say how to build it — still behind the token", async () => {
        expect((await fetch(base() + "/")).status).toBe(401);
        expect((await fetch(base() + "/?token=wrong")).status).toBe(401);
        const res = await fetch(base() + `/?token=${token}`);
        expect(res.status).toBe(503);
        expect(await res.text()).toContain("bun run --filter @loop/web build");
    });

    test("the WS upgrade rejects bad tokens", async () => {
        expect((await fetch(base() + "/ws?token=wrong")).status).toBe(401);
        expect((await fetch(base() + "/ws")).status).toBe(401);
    });

    test("usage.steak, cost.stats, settings over WS", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
        const next = () =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
                ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as Record<string, unknown>);
                ws.onerror = () => reject(new Error("ws error"));
            });
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("ws failed to open"));
        });
        const call = async (id: number, method: string, params?: unknown) => {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            return next();
        };

        const steak = (await call(1, "usage.steak")).result as {
            weeks: number;
            cells: number[][];
            tokens: number[][];
            startDay: string;
            monthLabels: string[];
            totalTokens: number;
        };
        expect(steak.weeks).toBeGreaterThan(50);
        expect(steak.cells.length).toBe(7);
        expect(steak.cells[0]!.length).toBe(steak.weeks);
        expect(steak.monthLabels.length).toBe(steak.weeks);
        // Raw per-day tokens + grid origin, for client tooltips/streaks.
        expect(steak.tokens.length).toBe(7);
        expect(steak.tokens[0]!.length).toBe(steak.weeks);
        expect(steak.startDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        const stats = (await call(2, "cost.stats", { cwd: "/nowhere" })).result as Record<string, unknown>;
        for (const k of ["lifetimeUsd", "todayUsd", "last7Usd", "monthUsd", "cwdUsd"]) {
            expect(typeof stats[k]).toBe("number");
        }

        const list = (await call(3, "settings.list")).result as Array<{ key: string; value: boolean }>;
        expect(list.length).toBeGreaterThan(5);
        const memory = list.find((s) => s.key === "memory");
        expect(memory?.value).toBe(true); // default, nothing set in mem store

        // Every setting that gates a TOOL has to reach the web/desktop panel
        // too, or the feature can be switched off in the terminal and nowhere
        // else. backgroundShells was added to the TUI list and missed here.
        for (const key of ["webSearch", "todos", "artifacts", "backgroundShells", "subagents", "mcp"]) {
            expect(list.find((s) => s.key === key)).toBeDefined();
        }
        expect(list.find((s) => s.key === "backgroundShells")?.value).toBe(false); // opt-in, default off

        const set = await call(4, "settings.set", { key: "memory", value: false });
        expect((set.result as { value: boolean }).value).toBe(false);
        expect(memSettings.memory).toBe(false);
        const after = (await call(5, "settings.list")).result as Array<{ key: string; value: boolean }>;
        expect(after.find((s) => s.key === "memory")?.value).toBe(false);

        // Only allowlisted keys are writable; value must be boolean.
        const bad = await call(6, "settings.set", { key: "hooks", value: true });
        expect(bad.error).toBeDefined();
        const badVal = await call(7, "settings.set", { key: "memory", value: "yes" });
        expect(badVal.error).toBeDefined();

        ws.close();
    });

    test("extension.list + context.report over WS", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
        const next = () =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
                ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as Record<string, unknown>);
                ws.onerror = () => reject(new Error("ws error"));
            });
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("ws failed to open"));
        });
        const call = async (id: number, method: string, params?: unknown) => {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            return next();
        };

        // Built-ins always exist, so the list is never empty.
        const exts = (await call(1, "extension.list")).result as Array<{
            name: string;
            enabled: boolean;
            builtin: boolean;
        }>;
        expect(exts.length).toBeGreaterThan(0);
        for (const e of exts) {
            expect(typeof e.name).toBe("string");
            expect(typeof e.enabled).toBe("boolean");
            expect(typeof e.builtin).toBe("boolean");
        }

        // setEnabled validates its inputs before touching any state.
        const unknown = await call(2, "extension.setEnabled", { name: "no-such-extension", value: true });
        expect(unknown.error).toBeDefined();
        const badVal = await call(3, "extension.setEnabled", { name: exts[0]!.name, value: "on" });
        expect(badVal.error).toBeDefined();

        // Draft form (no session): fixed overhead for a cwd + model.
        const report = (await call(4, "context.report", { cwd: "/tmp", model: "nope/model" })).result as {
            categories: Array<{ key: string; tokens: number }>;
            totalTokens: number;
            freeTokens: number;
        };
        expect(Array.isArray(report.categories)).toBe(true);
        expect(report.categories.some((c) => c.key === "systemPrompt")).toBe(true);
        expect(report.totalTokens).toBeGreaterThan(0);

        ws.close();
    });

    test("WS speaks JSON-RPC: server.info handshake + session.list", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
        // The next RESPONSE: create and rename also announce `session.status`
        // to every client (a beat after the reply), and taking one of those
        // for the reply made this test fail now and then.
        const next = () =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
                ws.onmessage = (e) => {
                    const message = JSON.parse(String(e.data)) as Record<string, unknown>;
                    if (message.id !== undefined) resolve(message);
                };
                ws.onerror = () => reject(new Error("ws error"));
                ws.onclose = () => reject(new Error("ws closed"));
            });
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("ws failed to open"));
        });

        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server.info" }));
        const info = await next();
        expect(info.id).toBe(1);
        const result = info.result as { methods: string[]; events: string[]; defaults: { cwd: string } };
        expect(result.methods).toContain("session.send");
        expect(result.events).toContain("text-delta");
        expect(typeof result.defaults.cwd).toBe("string");

        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.list" }));
        const list = await next();
        expect(list.id).toBe(2);
        expect(Array.isArray(list.result)).toBe(true);

        // create -> rename -> history reflects the new name
        ws.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "session.create",
                params: { cwd: "/tmp", model: "xai/test", provider: "xai" },
            }),
        );
        const created = (await next()) as { result: { sessionId: string } };
        const sid = created.result.sessionId;
        ws.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 4,
                method: "session.rename",
                params: { sessionId: sid, name: "my web session" },
            }),
        );
        const renamed = await next();
        expect((renamed as { result: { name: string } }).result.name).toBe("my web session");
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session.history", params: { sessionId: sid } }));
        const hist = (await next()) as { result: { name?: string } };
        expect(hist.result.name).toBe("my web session");

        ws.close();
    });
});

/** A socket to a serve handle that answers calls by id and collects notifications. */
async function openSocket(port: number, token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (typeof msg.id === "number" && waiting.has(msg.id)) {
            waiting.get(msg.id)!(msg);
            waiting.delete(msg.id);
        } else if (typeof msg.method === "string") {
            notifications.push(msg as { method: string; params: Record<string, unknown> });
        }
    };
    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws failed to open"));
    });
    let nextId = 1;
    return {
        notifications,
        call(method: string, params: Record<string, unknown> = {}) {
            const id = nextId++;
            return new Promise<Record<string, unknown>>((resolve) => {
                waiting.set(id, resolve);
                ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
        },
        close: () => ws.close(),
    };
}

describe("serve hosts the desktop app", () => {
    useTempSessionDb();

    let handle: ServeHandle;
    let token: string;
    let appDir: string;
    const base = () => `http://127.0.0.1:${handle.port}`;

    beforeAll(() => {
        storedToken = undefined;
        appDir = mkdtempSync(join(tmpdir(), "loop-web-app-"));
        mkdirSync(join(appDir, "assets"));
        writeFileSync(join(appDir, "index.html"), "<!doctype html><title>desktop app</title>");
        writeFileSync(join(appDir, "assets", "app-abc123.js"), "console.log('app')");
        writeFileSync(join(appDir, "favicon.ico"), "ico");
        handle = startWebServer({ port: 0, webAppDir: appDir });
        token = getOrCreateServeToken();
    });
    afterAll(() => {
        handle.stop();
    });

    test("the page never embeds the token — it arrives in the URL and leaves as a cookie", async () => {
        const html = await (await fetch(base() + `/?token=${token}`)).text();
        expect(html).not.toContain(token);
    });

    test("the token page load serves the app and leaves an HttpOnly cookie", async () => {
        const res = await fetch(base() + `/?token=${token}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("<title>desktop app</title>");
        const cookie = res.headers.get("set-cookie") ?? "";
        expect(cookie).toContain(`loop_serve=${token}`);
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
    });

    test("assets need the token or the cookie, never neither", async () => {
        expect((await fetch(base() + "/assets/app-abc123.js")).status).toBe(401);
        const withCookie = await fetch(base() + "/assets/app-abc123.js", {
            headers: { cookie: `loop_serve=${token}` },
        });
        expect(withCookie.status).toBe(200);
        expect(withCookie.headers.get("content-type")).toContain("text/javascript");
        // Hashed assets are immutable; the shell must always be revalidated.
        expect(withCookie.headers.get("cache-control")).toContain("immutable");
        const wrongCookie = await fetch(base() + "/assets/app-abc123.js", { headers: { cookie: "loop_serve=nope" } });
        expect(wrongCookie.status).toBe(401);
    });

    test("routes get the app shell; missing assets and traversal 404", async () => {
        const cookie = { headers: { cookie: `loop_serve=${token}` } };
        const route = await fetch(base() + "/settings/general", cookie);
        expect(route.status).toBe(200);
        expect(await route.text()).toContain("<title>desktop app</title>");
        expect(route.headers.get("cache-control")).toBe("no-cache");
        expect((await fetch(base() + "/assets/missing.js", cookie)).status).toBe(404);
        expect((await fetch(base() + "/%2e%2e/%2e%2e/etc/passwd.txt", cookie)).status).toBe(404);
    });

    test("the workspace answers over the socket: browse a folder", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-ws-browse-"));
        mkdirSync(join(dir, "alpha"));
        mkdirSync(join(dir, "beta"));
        const sock = await openSocket(handle.port, token);
        const reply = (await sock.call("workspace.fs.browse", { partialPath: dir + "/", cwd: undefined })) as {
            result: { entries: { name: string }[] } | null;
        };
        expect(reply.result?.entries.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
        // The Files panel's pair: list a workspace, read a file in it.
        writeFileSync(join(dir, "alpha", "note.md"), "# hello from the workspace");
        const listed = (await sock.call("workspace.fs.list", { cwd: dir })) as {
            result: { entries: { path: string; kind: string }[] };
        };
        expect(listed.result.entries.map((e) => e.path)).toContain("alpha/note.md");
        const read = (await sock.call("workspace.fs.read", { cwd: dir, relativePath: "alpha/note.md" })) as {
            result: { ok: boolean; contents: string };
        };
        expect(read.result).toMatchObject({ ok: true, contents: "# hello from the workspace" });
        // Unknown workspace methods are an RPC error, not silence.
        const missing = await sock.call("workspace.fs.nope");
        expect((missing.error as { message: string }).message).toContain("Method not found");
        sock.close();
    });

    test("a terminal opened from this machine streams its output as workspace events", async () => {
        const sock = await openSocket(handle.port, token);
        const opened = (await sock.call("workspace.pty.open", {
            threadId: "t1",
            terminalId: "term1",
            cwd: tmpdir(),
            cols: 80,
            rows: 24,
        })) as { result: { status: string; pid: number | null }; error?: unknown };
        expect(opened.error).toBeUndefined();
        expect(opened.result.pid).toBeGreaterThan(0);
        await sock.call("workspace.pty.write", { threadId: "t1", terminalId: "term1", data: "echo served-$((40+2))\r" });
        const output = () =>
            sock.notifications
                .filter((n) => n.method === "workspace.event" && n.params.channel === "loop:terminal")
                .map((n) => (n.params.payload as { data?: string }).data ?? "")
                .join("");
        await until(() => output().includes("served-42"), "terminal output arrives", 500, 20);
        await sock.call("workspace.pty.close", { threadId: "t1", terminalId: "term1" });
        sock.close();
    });
});

describe("serve workspace terminal gate", () => {
    test("a client the terminal is not offered to is refused, not ignored", async () => {
        const { createServeWorkspace } = await import("../src/rpc/serve-workspace");
        const workspace = createServeWorkspace(new RpcServer(), () => {});
        await expect(
            workspace.call("workspace.pty.open", { threadId: "t", terminalId: "x", cwd: tmpdir() }, false),
        ).rejects.toThrow("terminal for other devices");
        // Everything else is still answered for that client.
        const dir = mkdtempSync(join(tmpdir(), "loop-ws-gate-"));
        expect(await workspace.call("workspace.fs.browse", { partialPath: dir + "/" }, false)).not.toBeNull();
        workspace.dispose();
    });
});

describe("the packed web UI", () => {
    test("pack → unpack round-trips every shipped file and leaves out source maps", async () => {
        const { packWebApp, unpackWebApp } = await import("../src/rpc/web-app-pack");
        const dir = mkdtempSync(join(tmpdir(), "loop-web-pack-"));
        mkdirSync(join(dir, "assets", "fonts"), { recursive: true });
        writeFileSync(join(dir, "index.html"), "<title>x</title>");
        writeFileSync(join(dir, "assets", "app.js"), "app()");
        writeFileSync(join(dir, "assets", "app.js.map"), "{}");
        writeFileSync(join(dir, "assets", "fonts", "f.woff2"), new Uint8Array([0, 1, 2, 255]));
        writeFileSync(join(dir, "mockServiceWorker.js"), "msw");
        const files = unpackWebApp(packWebApp(dir));
        expect([...files.keys()].sort()).toEqual(["/assets/app.js", "/assets/fonts/f.woff2", "/index.html"]);
        expect(new TextDecoder().decode(files.get("/assets/app.js"))).toBe("app()");
        expect([...files.get("/assets/fonts/f.woff2")!]).toEqual([0, 1, 2, 255]);
    });

    test("a folder that is not a web build is refused at build time", async () => {
        const { packWebApp } = await import("../src/rpc/web-app-pack");
        expect(() => packWebApp(mkdtempSync(join(tmpdir(), "loop-web-empty-")))).toThrow("index.html");
    });
});

// How another device adds this machine (serve-pairing.ts): the same three
// steps the shared web/mobile client runtime takes.
describe("pairing another device", () => {
    let handle: ServeHandle;
    let base: string;
    beforeAll(() => {
        handle = startWebServer({ port: 0, webAppDir: null, version: "9.9.9" });
        base = `http://127.0.0.1:${handle.port}`;
    });
    afterAll(() => handle.stop());

    const exchange = (subjectToken: string) =>
        fetch(`${base}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: subjectToken,
                subject_token_type: "urn:loop:params:oauth:token-type:bootstrap",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            }),
        });

    test("says who it is without the token, and the same id every time", async () => {
        const first = await (await fetch(`${base}/.well-known/loop/environment`)).json();
        const second = await (await fetch(`${base}/.well-known/loop/environment`)).json();
        expect(first.environmentId).toMatch(/^loop-[0-9a-f]{24}$/);
        expect(second.environmentId).toBe(first.environmentId);
        expect(first.serverVersion).toBe("9.9.9");
        // One-way: the public id never contains the token.
        expect(JSON.stringify(first)).not.toContain(handle.token);
    });

    test("trades the pairing token for an access token, and refuses a wrong one", async () => {
        const ok = await exchange(handle.token);
        expect(ok.status).toBe(200);
        const body = await ok.json();
        expect(body.token_type).toBe("Bearer");
        expect(body.access_token).toBe(handle.token);

        const bad = await exchange("not-the-token");
        expect(bad.status).toBe(400);
        expect((await bad.json()).error).toBe("invalid_grant");
    });

    test("a six-digit code pairs once, for the token, and never works as a credential", async () => {
        const { code } = handle.pairingCode({ fresh: true });
        // Typed with a space, the way the computer shows it.
        const ok = await exchange(`${code.slice(0, 3)} ${code.slice(3)}`);
        expect(ok.status).toBe(200);
        expect((await ok.json()).access_token).toBe(handle.token);
        // Spent.
        const again = await exchange(code);
        expect(again.status).toBe(400);
        expect((await again.json()).error_description).toContain("code");
        // Not a bearer either.
        const session = await (
            await fetch(`${base}/api/auth/session`, { headers: { authorization: `Bearer ${code}` } })
        ).json();
        expect(session.authenticated).toBe(false);
    });

    test("wrong guesses cancel the code, and showing a new one withdraws the old", async () => {
        const first = handle.pairingCode({ fresh: true }).code;
        const second = handle.pairingCode({ fresh: true }).code;
        if (second !== first) expect((await exchange(first)).status).toBe(400);
        const current = handle.pairingCode({ fresh: true }).code;
        const wrong = current === "000000" ? "111111" : "000000";
        for (let i = 0; i < 5; i++) expect((await exchange(wrong)).status).toBe(400);
        // Five misses and even the right code is gone.
        expect((await exchange(current)).status).toBe(400);
        expect(handle.pairingCode().code).not.toBe(current);
    });

    test("a code expires", async () => {
        const { createPairing, PAIRING_CODE_TTL_MS } = await import("../src/rpc/serve-pairing");
        let clock = 1_000_000;
        const pairing = createPairing({
            token: "t".repeat(32),
            version: "1",
            tokenMatches: (candidate) => candidate === "t".repeat(32),
            now: () => clock,
        });
        const { code } = pairing.issueCode();
        clock += PAIRING_CODE_TTL_MS + 1;
        expect(pairing.currentCode()).toBeNull();
        const res = await pairing.handle(
            new Request("http://x/oauth/token", {
                method: "POST",
                body: new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                    subject_token: code,
                }),
            }),
        );
        expect(res?.status).toBe(400);
    });

    test("a ticket opens one socket, once", async () => {
        const issue = await fetch(`${base}/api/auth/websocket-ticket`, {
            method: "POST",
            headers: { authorization: `Bearer ${handle.token}` },
        });
        expect(issue.status).toBe(200);
        const { ticket } = await issue.json();
        expect(ticket).not.toContain(handle.token);

        const open = (t: string) =>
            new Promise<"open" | "refused">((resolve) => {
                const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?wsTicket=${t}`);
                ws.onopen = () => {
                    ws.close();
                    resolve("open");
                };
                ws.onerror = () => resolve("refused");
            });
        expect(await open(ticket)).toBe("open");
        expect(await open(ticket)).toBe("refused");
    });

    test("issues no ticket and reports no session without the token", async () => {
        const issue = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST" });
        expect(issue.status).toBe(401);
        const session = await (await fetch(`${base}/api/auth/session`)).json();
        expect(session.authenticated).toBe(false);
        const authed = await (
            await fetch(`${base}/api/auth/session`, { headers: { authorization: `Bearer ${handle.token}` } })
        ).json();
        expect(authed.authenticated).toBe(true);
    });

    test("answers a browser's preflight, so a tab on another origin can pair", async () => {
        const res = await fetch(`${base}/api/auth/websocket-ticket`, { method: "OPTIONS" });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    test("allows whatever headers the client's preflight asks for (tracing included)", async () => {
        const res = await fetch(`${base}/.well-known/loop/environment`, {
            method: "OPTIONS",
            headers: { "access-control-request-headers": "traceparent, authorization" },
        });
        expect(res.headers.get("access-control-allow-headers")).toBe("traceparent, authorization");
    });
});
