import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { useTempSessionDb } from "./helpers/temp-db";

// Nothing here may touch the real ~/.loop/auth.json: the serve token and the
// paired-host list both live there.
let storedToken: string | undefined;
mock.module("../src/rpc/serve-token-store", () => ({
    getStoredServeToken: () => storedToken,
    storeServeToken: (t: string) => {
        storedToken = t;
    },
}));
let storedHosts: unknown[] = [];
mock.module("../src/rpc/remote-host-store", () => ({
    loadRemoteHosts: () => storedHosts,
    saveRemoteHosts: (hosts: unknown[]) => {
        storedHosts = hosts;
    },
}));

const { startWebServer } = await import("../src/rpc/serve");
const { listRemoteHosts, pairRemoteHost, parsePairingLink, removeRemoteHost, renameRemoteHost, RemoteHostClient } =
    await import("../src/rpc/remote-host");
import type { RemoteHostRecord, RemoteSessionEvent } from "../src/rpc/remote-host";
import type { ServeHandle } from "../src/rpc/serve";

async function until(cond: () => boolean, label: string, tries = 1000, ms = 10): Promise<void> {
    for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, ms));
    }
    throw new Error(`until: condition not met: ${label}`);
}

describe("parsePairingLink", () => {
    test("the URL `loop serve` prints", () => {
        expect(parsePairingLink("http://192.168.1.4:5667/?token=abc")).toEqual({
            url: "http://192.168.1.4:5667",
            token: "abc",
        });
    });

    test("a token in the fragment, as the phone's QR may carry it", () => {
        expect(parsePairingLink("http://studio.tail1.ts.net:5667/#token=abc")).toEqual({
            url: "http://studio.tail1.ts.net:5667",
            token: "abc",
        });
    });

    test("a bare host gets serve's port; the token may come separately", () => {
        expect(parsePairingLink("studio", "t0k")).toEqual({ url: "http://studio:5667", token: "t0k" });
        expect(parsePairingLink("studio:6000", "t0k")).toEqual({ url: "http://studio:6000", token: "t0k" });
    });

    test("an explicit URL keeps its own port, or none (a tunnel on 443)", () => {
        expect(parsePairingLink("https://loop.example.com/?token=x")).toEqual({
            url: "https://loop.example.com",
            token: "x",
        });
    });

    test("no token, or not http, is not a link", () => {
        expect(parsePairingLink("http://studio:5667/")).toBeNull();
        expect(parsePairingLink("ftp://studio/?token=x")).toBeNull();
        expect(parsePairingLink("   ")).toBeNull();
    });
});

describe("pairing and driving another machine", () => {
    useTempSessionDb();
    let handle: ServeHandle;
    let base: string;
    beforeAll(() => {
        storedToken = undefined;
        storedHosts = [];
        handle = startWebServer({ port: 0, webAppDir: null, version: "1.2.3" });
        base = `http://127.0.0.1:${handle.port}`;
    });
    afterAll(() => handle.stop());

    test("pairs with the printed link and remembers the machine once", async () => {
        const record = await pairRemoteHost(parsePairingLink(handle.url)!);
        expect(record.url).toBe(base);
        expect(record.token).toBe(handle.token);
        expect(record.id).toMatch(/^loop-[0-9a-f]{24}$/);
        // Pairing again (a new address, a rotated token) replaces, never duplicates.
        renameRemoteHost(record.id, "studio");
        const again = await pairRemoteHost(parsePairingLink(handle.url)!);
        expect(listRemoteHosts()).toHaveLength(1);
        expect(again.label).toBe("studio");
    });

    test("pairs with the six-digit code and keeps the token, not the code", async () => {
        storedHosts = [];
        const { code } = handle.pairingCode({ fresh: true });
        const record = await pairRemoteHost(parsePairingLink(base, code)!);
        expect(record.token).toBe(handle.token);
    });

    test("refuses a wrong token and saves nothing", async () => {
        storedHosts = [];
        await expect(pairRemoteHost({ url: base, token: "nope" })).rejects.toThrow("not valid");
        expect(listRemoteHosts()).toHaveLength(0);
    });

    test("forgets a machine by name", async () => {
        const record = await pairRemoteHost(parsePairingLink(handle.url)!);
        renameRemoteHost(record.id, "Studio");
        expect(removeRemoteHost("studio")?.id).toBe(record.id);
        expect(listRemoteHosts()).toHaveLength(0);
    });

    test("lists, creates, attaches and streams a turn over the socket", async () => {
        const record = await pairRemoteHost(parsePairingLink(handle.url)!);
        const client = new RemoteHostClient(record);
        try {
            const { sessionId } = await client.call<{ sessionId: string }>("session.create", {
                cwd: process.cwd(),
                provider: "nope",
                model: "nope/none",
            });
            const rows = await client.call<Array<{ id: string }>>("session.list", {});
            expect(rows.map((r) => r.id)).toContain(sessionId);

            const events: RemoteSessionEvent[] = [];
            client.onSessionEvent(sessionId, (e) => events.push(e));
            await client.call("session.attach", { sessionId, afterSeq: 0 });
            // An unknown provider fails the turn — which is still a whole turn
            // as a client sees it: started, an error, ended.
            await client.call("session.send", { sessionId, input: "hi" });
            await until(
                () => events.some((e) => e.part.type === "session-running" && !(e.part.data as { running: boolean }).running),
                "turn end",
            );
            const types = events.map((e) => e.part.type);
            expect(types[0]).toBe("session-running");
            expect(types).toContain("error");
            // Seqs are the host's, strictly increasing — what a reconnect resumes from.
            const seqs = events.map((e) => e.seq);
            expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        } finally {
            client.close();
        }
    });

    test("reconnects on its own after the socket drops", async () => {
        const record: RemoteHostRecord = await pairRemoteHost(parsePairingLink(handle.url)!);
        const sockets: Array<{ close(): void }> = [];
        const client = new RemoteHostClient(record, {
            reconnectBaseMs: 20,
            createSocket: (url) => {
                const ws = new WebSocket(url);
                sockets.push(ws);
                return ws as never;
            },
        });
        const statuses: string[] = [];
        client.onStatus((s) => statuses.push(s));
        try {
            await client.call("session.list", {});
            sockets[0]!.close();
            await until(() => statuses.filter((s) => s === "open").length === 2, "reopened");
            expect(statuses).toContain("reconnecting");
            expect(Array.isArray(await client.call("session.list", {}))).toBe(true);
        } finally {
            client.close();
        }
    });
});
