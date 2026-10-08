import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { negotiateProtocol, PROTOCOL_VERSION } from "../src/rpc/protocol";
import { protocolMismatch } from "../src/rpc/remote-host";

describe("protocol negotiation", () => {
    test("same major talks, at the lower minor", () => {
        expect(negotiateProtocol({ client: [1, 3], host: [1, 1], minClient: [1, 0] })).toEqual({
            ok: true,
            protocol: [1, 1],
        });
    });

    test("an older major on the client says: update the app", () => {
        const v = negotiateProtocol({ client: [1, 4], host: [2, 0], minClient: [2, 0] });
        expect(v.ok).toBe(false);
        expect(v.ok === false && v.update).toBe("client");
        expect(v.ok === false && v.message).toContain("Update the app");
    });

    test("an older major on the host says: update loop there", () => {
        const v = negotiateProtocol({ client: [2, 0], host: [1, 1], minClient: [1, 0] });
        expect(v.ok === false && v.update).toBe("host");
        expect(v.ok === false && v.message).toContain("loop update");
    });

    test("a client below the host's minimum is refused within a major", () => {
        const v = negotiateProtocol({ client: [1, 0], host: [1, 5], minClient: [1, 2] });
        expect(v.ok === false && v.update).toBe("client");
    });

    test("a host from before the handshake is 1.0, and takes this loop", () => {
        expect(protocolMismatch({})).toBeNull();
        expect(protocolMismatch({ protocol: [9, 0], minClientProtocol: [9, 0] })).toContain("Update this loop");
    });
});

test("the web/mobile app speaks the protocol core does", () => {
    // The app is a separate build with its own copy (apps/web/src/loop/protocol.ts).
    const source = readFileSync(join(import.meta.dir, "../../../apps/web/src/loop/protocol.ts"), "utf8");
    const match = /CLIENT_PROTOCOL = \[(\d+), (\d+)\]/.exec(source);
    expect(match && [Number(match[1]), Number(match[2])]).toEqual([...PROTOCOL_VERSION]);
});
