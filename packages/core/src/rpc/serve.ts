/**
 * `loop serve` — the RPC server over WebSocket, plus an embedded browser UI.
 *
 * Each WS connection wraps into one `Transport` fed to the shared RpcServer:
 * frames are the existing JSONL messages, one JSON message per text frame, so
 * every RPC client (TUI-attach later, the web UI now) speaks the same
 * protocol as the unix-socket daemon.
 *
 * Security model (see settings.serve): possession of the token is full
 * control of this machine. Token required on the WS upgrade AND the page
 * load. The CLI binds 0.0.0.0 by default (LAN reach is the point); beyond
 * the LAN bring your own network (Tailscale / SSH -L / cloudflared), which
 * also provides TLS.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { RpcServer, type LiveSessionProvider } from "./server";
import { loadWebApp, serveWebApp, webAppMissing } from "./serve-web-app";
import { createServeWorkspace, WORKSPACE_EVENT, WORKSPACE_PREFIX } from "./serve-workspace";
import { getStoredServeToken, storeServeToken } from "./serve-token-store";
import { bearerToken, createPairing } from "./serve-pairing";

/** The cookie a token page load leaves, so the app's own asset and socket
 * requests are authorised without the token in every URL. */
const TOKEN_COOKIE = "loop_serve";

function cookieToken(req: Request): string | null {
    const header = req.headers.get("cookie");
    if (!header) return null;
    for (const part of header.split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name === TOKEN_COOKIE) return decodeURIComponent(rest.join("="));
    }
    return null;
}

/**
 * JSON renders a Uint8Array as one key per byte; a file asset (an image the
 * desktop reads straight into a blob) becomes `{ $bytes: <base64> }` instead.
 */
function bytesAsBase64(_key: string, value: unknown): unknown {
    return value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : value;
}

/** A `workspace.*` request, or null for anything the RpcServer should get. */
function parseWorkspaceRequest(
    frame: string,
): { id: number | string; method: string; params: Record<string, unknown> } | null {
    // Cheap reject first: nearly every frame is a session call.
    if (!frame.includes(`"${WORKSPACE_PREFIX}`)) return null;
    try {
        const msg = JSON.parse(frame) as { id?: number | string; method?: unknown; params?: unknown };
        if (typeof msg.method !== "string" || !msg.method.startsWith(WORKSPACE_PREFIX) || msg.id === undefined) {
            return null;
        }
        const params = msg.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};
        return { id: msg.id, method: msg.method, params };
    } catch {
        return null;
    }
}

/** Keypad-spellable default: 5667 = "loop". */
export const SERVE_DEFAULT_PORT = 5667;

/** Existing token from auth.json, or a fresh one persisted for next time —
 * the printed URL stays stable across restarts. */
export function getOrCreateServeToken(): string {
    const existing = getStoredServeToken();
    if (existing) return existing;
    const token = randomBytes(24).toString("hex");
    storeServeToken(token);
    return token;
}

export function isLoopbackHost(host: string): boolean {
    // An IPv4 peer on a dual-stack socket reports itself IPv4-mapped.
    return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "::ffff:127.0.0.1";
}

/** Non-internal IPv4 addresses of this machine — the LAN faces of a serve
 * bound to a wildcard host. */
export function lanAddresses(): string[] {
    const out: string[] = [];
    for (const infos of Object.values(networkInterfaces())) {
        for (const info of infos ?? []) {
            if (info.family === "IPv4" && !info.internal) out.push(info.address);
        }
    }
    return out;
}

/** Constant-time compare via digests — no length or prefix leak. */
function tokenMatches(candidate: string | null, token: string): boolean {
    if (!candidate) return false;
    const a = createHash("sha256").update(candidate).digest();
    const b = createHash("sha256").update(token).digest();
    return timingSafeEqual(a, b);
}

export interface ServeHandle {
    hostname: string;
    port: number;
    /** The access token guarding this server — the caller may need it to
     * print prospective URLs (e.g. the LAN URL that a network bind would
     * serve). It is stable across restarts. */
    token: string;
    /** Ready-to-open URL including the token. Never log it server-side. */
    url: string;
    /** LAN URLs (one per non-internal IPv4). Only usable when the bind host
     * actually faces the network — empty for a loopback bind. */
    networkUrls: string[];
    /**
     * Feed for sessions the caller runs itself (`live` below): a turn's events
     * and running flag go out to every client watching, exactly as if this
     * server had run it.
     */
    live: {
        publish(sessionId: string, part: { type: string; data: unknown }): void;
        setRunning(sessionId: string, running: boolean): void;
    };
    stop(): void;
}

interface WsData {
    /** Whether this connection may open terminals (see startWebServer). */
    terminal: boolean;
    /** JSONL feed into the shared RpcServer; wired in open(). */
    feed: ((chunk: string) => void) | null;
    /** Unsubscribes this connection from every session on close. */
    close: (() => void) | null;
}

export function startWebServer(
    opts: {
        host?: string;
        port?: number;
        webAppDir?: string | null;
        /**
         * Offer the terminal to clients on other machines too. Off by default:
         * the token already means full control, but a shell is the one thing
         * that turns a leaked URL into an interactive session, so reaching it
         * across the network is a separate, deliberate choice.
         */
        remoteTerminal?: boolean;
        /** Reported to pairing clients (see serve-pairing.ts). */
        version?: string;
        /**
         * Sessions the caller runs itself — the TUI under `/rc` — so a client's
         * message to one runs there, on screen, instead of as a second copy.
         */
        live?: LiveSessionProvider;
    } = {},
): ServeHandle {
    const hostname = opts.host ?? "127.0.0.1";
    // Loaded once, on the first page request: unpacking the embedded UI is
    // work a serve nobody opens should not pay at startup.
    let webApp: ReturnType<typeof loadWebApp> | null = null;
    const port = opts.port ?? SERVE_DEFAULT_PORT;
    const token = getOrCreateServeToken();
    // Reachable over the network, so artifact.* is refused — see RpcServer.remote.
    // Embedded in a TUI (`live` given), the ask tool stays the TUI's: its
    // bridge is process-global, and the TUI's own questions belong on its
    // screen.
    const rpc = new RpcServer({
        remote: true,
        ...(opts.live ? { live: opts.live, askBridge: false } : {}),
    });
    // Every open socket: workspace events (terminal output, git progress) go
    // to all of them, and each client picks out the terminals it shows.
    const sockets = new Set<{ send(data: string): unknown }>();
    const workspace = createServeWorkspace(rpc, (channel, payload) => {
        const frame = JSON.stringify({ jsonrpc: "2.0", method: WORKSPACE_EVENT, params: { channel, payload } });
        for (const ws of sockets) {
            try {
                ws.send(frame);
            } catch {}
        }
    });

    // How other devices add this machine — see serve-pairing.ts.
    const pairing = createPairing({
        token,
        version: opts.version?.trim() || "dev",
        tokenMatches: (candidate) => tokenMatches(candidate, token),
    });

    const unauthorized = () =>
        new Response("Unauthorized: token required (start with `serve` and use the printed URL)", { status: 401 });

    const server = Bun.serve<WsData, never>({
        hostname,
        port,
        async fetch(req, srv) {
            const paired = await pairing.handle(req);
            if (paired) return paired;
            const url = new URL(req.url);
            const fromQuery = tokenMatches(url.searchParams.get("token"), token);
            // A paired device's socket carries a one-use ticket instead of the
            // token; its other requests carry the token as a bearer.
            const fromTicket = url.pathname === "/ws" && pairing.redeemTicket(url.searchParams.get("wsTicket"));
            if (!fromQuery && !fromTicket && !tokenMatches(cookieToken(req), token) && !tokenMatches(bearerToken(req), token)) {
                return unauthorized();
            }
            if (url.pathname === "/ws") {
                const local = isLoopbackHost(srv.requestIP(req)?.address ?? "");
                const data: WsData = { terminal: local || opts.remoteTerminal === true, feed: null, close: null };
                if (srv.upgrade(req, { data })) return undefined;
                return new Response("WebSocket upgrade failed", { status: 400 });
            }
            if (req.method !== "GET" && req.method !== "HEAD") return new Response("Not found", { status: 404 });
            const app = await (webApp ??= loadWebApp(opts.webAppDir));
            if (!app) return webAppMissing();
            const res = await serveWebApp(app, url.pathname);
            // A page opened with the token keeps it as a cookie: HttpOnly (page
            // script never sees it), SameSite=Strict (no other site can ride
            // it), scoped to this origin.
            if (fromQuery && res.headers.get("content-type")?.startsWith("text/html")) {
                res.headers.append("set-cookie", `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
            }
            return res;
        },
        websocket: {
            open(ws) {
                // One Transport per connection, alive for the socket's
                // lifetime. Turn events for sessions this connection opened
                // keep flowing here; after close, sends are dropped by the
                // dead-socket guard below (until per-session subscriber sets —
                // the multi-client phase — replace this wiring).
                const transport = {
                    send(msg: unknown) {
                        // A turn event can fire between close and GC; Bun
                        // returns -1 on a dead socket, but stay defensive.
                        try {
                            ws.send(JSON.stringify(msg));
                        } catch {}
                    },
                };
                const attached = rpc.attach(transport);
                ws.data.feed = attached.feed;
                ws.data.close = attached.close;
                sockets.add(ws);
            },
            message(ws, message) {
                if (typeof message !== "string") return;
                // workspace.* is answered here (it is the desktop's host table,
                // not an RpcServer method); everything else is the RpcServer's.
                const request = parseWorkspaceRequest(message);
                if (request) {
                    void workspace.call(request.method, request.params, ws.data.terminal).then(
                        (result) =>
                            ws.send(
                                JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result ?? null }, bytesAsBase64),
                            ),
                        (err: unknown) =>
                            ws.send(
                                JSON.stringify({
                                    jsonrpc: "2.0",
                                    id: request.id,
                                    error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
                                }),
                            ),
                    );
                    return;
                }
                // One JSON message per text frame; the JSONL feed just needs
                // its newline delimiter appended.
                const { feed } = ws.data;
                if (feed) feed(message + "\n");
            },
            close(ws) {
                sockets.delete(ws);
                // Detach from every session so broadcasts stop going to a dead
                // socket and `attached` counts stay honest.
                if (ws.data.close) ws.data.close();
            },
        },
    });

    const boundPort = server.port ?? port;
    // Wildcard binds aren't clickable — the local URL always shows loopback.
    const wildcard = hostname === "0.0.0.0" || hostname === "::";
    const localHost = wildcard ? "127.0.0.1" : hostname;
    // A specific non-loopback bind has exactly one network face; a wildcard
    // bind faces every LAN address.
    const networkHosts = wildcard ? lanAddresses() : isLoopbackHost(hostname) ? [] : [hostname];
    return {
        hostname,
        port: boundPort,
        token,
        url: `http://${localHost}:${boundPort}/?token=${token}`,
        networkUrls: networkHosts.map((h) => `http://${h}:${boundPort}/?token=${token}`),
        live: {
            publish: (sessionId, part) => rpc.publishLive(sessionId, part),
            setRunning: (sessionId, running) => rpc.setLiveRunning(sessionId, running),
        },
        // Killing the HTTP server closes the sockets; disposing the RPC
        // server is what kills the background shells its sessions started,
        // which nothing else in this process will do.
        stop: () => {
            workspace.dispose();
            rpc.dispose();
            server.stop(true);
        },
    };
}
