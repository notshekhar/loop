/**
 * The client half of serve-pairing.ts: how THIS loop adds another machine
 * running `loop serve` and talks to it — the TUI's `/hosts`, the same thing
 * the desktop's Settings → Connections and the phone's "Add environment" do.
 *
 *   pairRemoteHost(link)     the link `loop serve` prints → a saved host
 *   RemoteHostClient         one WebSocket per host: JSON-RPC calls plus the
 *                            `session.event` stream, reconnecting on its own
 *
 * The protocol is the one every client already speaks (rpc/server.ts):
 * session.list / history / attach {afterSeq} / send / cancel / answer.
 */
import { SERVE_DEFAULT_PORT } from "./serve";
import {
    negotiateProtocol,
    parseProtocol,
    PROTOCOL_VERSION,
    type ProtocolVersion,
} from "./protocol";
import { loadRemoteHosts, saveRemoteHosts, type RemoteHostRecord } from "./remote-host-store";

export type { RemoteHostRecord } from "./remote-host-store";

export interface PairingLink {
    /** `http://host:port`, nothing after it. */
    readonly url: string;
    readonly token: string;
}

/**
 * Read what a person pastes: the URL `loop serve` prints (`?token=` or
 * `#token=`), or a bare `host[:port]` with the token given separately.
 * Null when there is no host or no token to be found.
 */
export function parsePairingLink(input: string, separateToken?: string): PairingLink | null {
    const raw = input.trim();
    if (!raw) return null;
    let parsed: URL;
    try {
        parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const token = (separateToken?.trim() || parsed.searchParams.get("token") || hash.get("token") || "").trim();
    if (!token) return null;
    // A bare `host` means serve's default port; an explicit URL keeps its own
    // (including none, for a tunnel on 80/443).
    const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const port = parsed.port || (hadScheme ? "" : String(SERVE_DEFAULT_PORT));
    const host = parsed.hostname.includes(":") ? `[${parsed.hostname.replace(/^\[|\]$/g, "")}]` : parsed.hostname;
    return { url: `${parsed.protocol}//${host}${port ? `:${port}` : ""}`, token };
}

export interface RemoteEnvironment {
    readonly environmentId: string;
    readonly label: string;
    readonly serverVersion?: string;
    readonly platform?: { os?: string; arch?: string };
    /** The host's protocol; absent on a host older than the handshake (1.0). */
    readonly protocol?: ProtocolVersion;
    readonly minClientProtocol?: ProtocolVersion;
}

/**
 * Whether this loop can talk to that host — null when it can, else the
 * sentence saying which side to update. A host that predates the handshake
 * is protocol 1.0 and takes any client.
 */
export function protocolMismatch(env: Pick<RemoteEnvironment, "protocol" | "minClientProtocol">): string | null {
    const verdict = negotiateProtocol({
        client: PROTOCOL_VERSION,
        host: env.protocol ?? [1, 0],
        minClient: env.minClientProtocol ?? [1, 0],
    });
    return verdict.ok ? null : forThisLoop(verdict.message);
}

/** The protocol messages are written for an app; here the client is a loop. */
function forThisLoop(message: string): string {
    return message.replace("Update the app.", "Update this loop (`loop update`).").replace(/this app/g, "this loop");
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await run(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

/** Who answers at `url`. Public on the host, so this needs no token. */
export async function probeRemoteHost(
    url: string,
    opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<RemoteEnvironment> {
    const doFetch = opts.fetch ?? fetch;
    return withTimeout(opts.timeoutMs ?? 4000, async (signal) => {
        const res = await doFetch(`${url}/.well-known/loop/environment`, { signal });
        if (!res.ok) throw new Error(`${url} answered ${res.status} — is it a loop serve?`);
        const body = (await res.json()) as Partial<RemoteEnvironment>;
        if (typeof body.environmentId !== "string") throw new Error(`${url} is not a loop serve`);
        const protocol = parseProtocol(body.protocol);
        const minClientProtocol = parseProtocol(body.minClientProtocol);
        return {
            environmentId: body.environmentId,
            label: typeof body.label === "string" && body.label ? body.label : new URL(url).hostname,
            serverVersion: body.serverVersion,
            platform: body.platform,
            ...(protocol ? { protocol } : {}),
            ...(minClientProtocol ? { minClientProtocol } : {}),
        };
    });
}

/**
 * Check the link against the host — it must be a loop, and the token must be
 * its token — and save it. Pairing the same machine again (a new address, a
 * rotated token) replaces its entry rather than adding a second.
 */
export async function pairRemoteHost(
    link: PairingLink,
    opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<RemoteHostRecord> {
    const doFetch = opts.fetch ?? fetch;
    const env = await probeRemoteHost(link.url, opts);
    // Refused before it is saved: a host this loop cannot talk to would
    // otherwise sit in /hosts failing on every open.
    const mismatch = protocolMismatch(env);
    if (mismatch) throw new Error(`${env.label}: ${mismatch}`);
    await withTimeout(opts.timeoutMs ?? 4000, async (signal) => {
        const res = await doFetch(`${link.url}/oauth/token`, {
            method: "POST",
            signal,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: link.token,
                subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
            }).toString(),
        });
        if (!res.ok) throw new Error(`${env.label} refused that token — copy the link \`loop serve\` prints there`);
    });
    const hosts = loadRemoteHosts();
    const existing = hosts.find((h) => h.id === env.environmentId);
    const record: RemoteHostRecord = {
        id: env.environmentId,
        // A name given here survives re-pairing; the host's own name otherwise.
        label: existing?.label ?? env.label,
        url: link.url,
        token: link.token,
        addedAt: existing?.addedAt ?? Date.now(),
    };
    saveRemoteHosts([...hosts.filter((h) => h.id !== record.id), record]);
    return record;
}

export function listRemoteHosts(): RemoteHostRecord[] {
    return loadRemoteHosts();
}

/** Forget a host by id or (case-insensitive) label. The removed entry, or null. */
export function removeRemoteHost(idOrLabel: string): RemoteHostRecord | null {
    const hosts = loadRemoteHosts();
    const needle = idOrLabel.trim().toLowerCase();
    const hit = hosts.find((h) => h.id === idOrLabel || h.label.toLowerCase() === needle);
    if (!hit) return null;
    saveRemoteHosts(hosts.filter((h) => h !== hit));
    return hit;
}

export function renameRemoteHost(id: string, label: string): void {
    const name = label.trim();
    if (!name) return;
    saveRemoteHosts(loadRemoteHosts().map((h) => (h.id === id ? { ...h, label: name } : h)));
}

export interface RemoteSessionEvent {
    readonly seq: number;
    readonly part: { readonly type: string; readonly data: unknown };
}

export type RemoteHostStatus = "connecting" | "open" | "reconnecting" | "closed";

interface MinimalSocket {
    readyState: number;
    send(data: string): void;
    close(): void;
    onopen: ((ev: unknown) => void) | null;
    onclose: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface RemoteHostClientOptions {
    fetch?: FetchLike;
    /** Swapped in tests. */
    createSocket?: (url: string) => MinimalSocket;
    callTimeoutMs?: number;
    /** First reconnect delay; doubles to a 30s ceiling. */
    reconnectBaseMs?: number;
}

const OPEN = 1;

/**
 * One live connection to a paired host. Requests are JSON-RPC over the
 * socket; `session.event` notifications fan out to whoever subscribed to that
 * session. A dropped socket reconnects with backoff until close() — on each
 * reconnect `onStatus("open")` fires again, and subscribers re-attach with the
 * last seq they saw (the host replays the gap or says resync).
 */
export class RemoteHostClient {
    private socket: MinimalSocket | null = null;
    private nextId = 1;
    private readonly pending = new Map<
        number,
        { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    private readonly sessionListeners = new Map<string, Set<(e: RemoteSessionEvent) => void>>();
    private readonly statusListeners = new Set<(s: RemoteHostStatus) => void>();
    private opening: Promise<void> | null = null;
    private closed = false;
    private retryMs: number;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    status: RemoteHostStatus = "connecting";

    constructor(
        readonly host: RemoteHostRecord,
        private readonly opts: RemoteHostClientOptions = {},
    ) {
        this.retryMs = opts.reconnectBaseMs ?? 1000;
    }

    /** Resolves once the socket is open; rejects if this attempt fails. */
    connect(): Promise<void> {
        if (this.socket?.readyState === OPEN) return Promise.resolve();
        if (this.opening) return this.opening;
        this.closed = false;
        this.opening = this.open().finally(() => {
            this.opening = null;
        });
        return this.opening;
    }

    private async open(): Promise<void> {
        const doFetch = this.opts.fetch ?? fetch;
        // A one-use ticket, so the socket URL (which proxies log) never
        // carries the token itself.
        const res = await withTimeout(5000, (signal) =>
            doFetch(`${this.host.url}/api/auth/websocket-ticket`, {
                method: "POST",
                signal,
                headers: { authorization: `Bearer ${this.host.token}` },
            }),
        );
        if (res.status === 401) throw new Error(`${this.host.label} no longer accepts this token — pair it again`);
        if (!res.ok) throw new Error(`${this.host.label} answered ${res.status}`);
        const { ticket } = (await res.json()) as { ticket: string };
        const wsUrl = `${this.host.url.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`;
        const socket = this.opts.createSocket
            ? this.opts.createSocket(wsUrl)
            : (new WebSocket(wsUrl) as unknown as MinimalSocket);
        await new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve();
            socket.onerror = () => reject(new Error(`could not open a socket to ${this.host.label}`));
            socket.onclose = () => reject(new Error(`${this.host.label} closed the socket`));
        });
        this.socket = socket;
        this.retryMs = this.opts.reconnectBaseMs ?? 1000;
        socket.onmessage = (ev) => this.handle(String(ev.data));
        socket.onerror = () => {};
        socket.onclose = () => this.dropped(socket);
        // The handshake, before anything else is asked of the host. A host
        // that does not know `hello` predates it — protocol 1.0, served as is.
        try {
            await this.request("hello", { protocol: PROTOCOL_VERSION, client: "loop-tui" });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/method not found/i.test(message)) {
                this.closed = true;
                this.socket = null;
                try {
                    socket.close();
                } catch {}
                this.setStatus("closed");
                throw new Error(`${this.host.label}: ${forThisLoop(message)}`);
            }
        }
        this.setStatus("open");
    }

    private dropped(socket: MinimalSocket): void {
        if (this.socket !== socket) return;
        this.socket = null;
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(`lost the connection to ${this.host.label}`));
            this.pending.delete(id);
        }
        if (this.closed) return;
        this.setStatus("reconnecting");
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.closed || this.retryTimer) return;
        const delay = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect().catch(() => this.scheduleReconnect());
        }, delay);
    }

    private handle(frame: string): void {
        let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
        try {
            msg = JSON.parse(frame);
        } catch {
            return;
        }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message ?? "remote error"));
            else p.resolve(msg.result);
            return;
        }
        if (msg.method === "session.event" && msg.params && typeof msg.params === "object") {
            const { sessionId, seq, part } = msg.params as { sessionId: string } & RemoteSessionEvent;
            for (const l of this.sessionListeners.get(sessionId) ?? []) l({ seq, part });
        }
    }

    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
        await this.connect();
        return this.request<T>(method, params);
    }

    /** One request on the open socket (no connect — `open` uses it mid-handshake). */
    private request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        const socket = this.socket!;
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${this.host.label} did not answer ${method}`));
            }, this.opts.callTimeoutMs ?? 30_000);
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
            socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
        });
    }

    /** Events of one session, as the host stamps them. Subscribing does not attach — call session.attach. */
    onSessionEvent(sessionId: string, listener: (e: RemoteSessionEvent) => void): () => void {
        let set = this.sessionListeners.get(sessionId);
        if (!set) this.sessionListeners.set(sessionId, (set = new Set()));
        set.add(listener);
        return () => {
            set!.delete(listener);
            if (set!.size === 0) this.sessionListeners.delete(sessionId);
        };
    }

    onStatus(listener: (s: RemoteHostStatus) => void): () => void {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    }

    private setStatus(s: RemoteHostStatus): void {
        this.status = s;
        for (const l of this.statusListeners) l(s);
    }

    close(): void {
        this.closed = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const socket = this.socket;
        this.socket = null;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("closed"));
        }
        this.pending.clear();
        try {
            socket?.close();
        } catch {}
        this.setStatus("closed");
    }
}
