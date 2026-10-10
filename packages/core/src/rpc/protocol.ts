export interface RpcRequest {
    jsonrpc: "2.0";
    id?: number | string;
    method: string;
    params?: unknown;
}

export interface RpcResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}

export const RpcErrorCode = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
} as const;

/**
 * The client↔host protocol version, [major, minor] — versioned apart from
 * loop's release, which ships every few days without touching it (see
 * docs/remote-control.md §4).
 *
 *   major  must match; bumped only for a breaking change.
 *   minor  additive; each side uses what both have.
 *
 * 1.0  the session.* methods and `session.event` stream (no `hello`).
 * 1.1  `hello`, host-wide `session.status`, paged `session.list` +
 *      `session.projects`, live sessions under `/rc`, and
 *      `session.history {afterEntryId}` (only the tail of the branch).
 * 1.2  loop's transcript: `session.messages` (one assistant message per turn,
 *      its parts in written order — packages/core/src/transcript) and the
 *      `user-message` event that opens each turn on the live stream.
 * 1.3  thread teams: `team.get` / `team.stop`, a `team` field on
 *      `session.list` rows, `session.status` change "team", the
 *      `team-message` event and the transcript's `data-team` part.
 *
 * Copied by the web/mobile client (apps/web/src/loop/protocol.ts); a core
 * test keeps the two equal.
 */
export const PROTOCOL_VERSION = [1, 3] as const;
/** The oldest client this host still serves. */
export const MIN_CLIENT_PROTOCOL = [1, 0] as const;
/** What this host offers, for clients to gate features on. */
export const PROTOCOL_CAPABILITIES = ["sessions", "status", "paging", "live-sessions", "pairing", "history-tail", "transcript", "teams"] as const;

export type ProtocolVersion = readonly [number, number];

/** a < b, by major then minor. */
function older(a: ProtocolVersion, b: ProtocolVersion): boolean {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

export function formatProtocol(v: ProtocolVersion): string {
    return `${v[0]}.${v[1]}`;
}

/**
 * Whether a client and a host can talk, and if not, which side to update —
 * the sentence both sides show, so a phone left un-updated for months says
 * "update the app" instead of failing in some method later.
 */
export function negotiateProtocol(input: {
    client: ProtocolVersion;
    host: ProtocolVersion;
    minClient: ProtocolVersion;
}):
    | { ok: true; protocol: ProtocolVersion }
    | { ok: false; update: "client" | "host"; message: string } {
    const { client, host, minClient } = input;
    if (client[0] !== host[0]) {
        const update = client[0] < host[0] ? "client" : "host";
        return {
            ok: false,
            update,
            message:
                update === "client"
                    ? `This loop host speaks protocol ${formatProtocol(host)}; this app speaks ${formatProtocol(client)}. Update the app.`
                    : `This loop host speaks protocol ${formatProtocol(host)}; this app speaks ${formatProtocol(client)}. Update loop on the host (\`loop update\`).`,
        };
    }
    if (older(client, minClient)) {
        return {
            ok: false,
            update: "client",
            message: `This loop host needs protocol ${formatProtocol(minClient)} or newer; this app speaks ${formatProtocol(client)}. Update the app.`,
        };
    }
    return { ok: true, protocol: [client[0], Math.min(client[1], host[1])] };
}

/** A `[major, minor]` from the wire, or null when it is not one. */
export function parseProtocol(value: unknown): ProtocolVersion | null {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [major, minor] = value;
    return Number.isInteger(major) && Number.isInteger(minor) && major >= 0 && minor >= 0
        ? [major as number, minor as number]
        : null;
}
