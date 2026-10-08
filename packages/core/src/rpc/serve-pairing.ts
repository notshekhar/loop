/**
 * Pairing for `loop serve`: how another device — the phone, a browser tab
 * with a second machine added, another loop — adds THIS machine as a host.
 *
 * The client runtime the web and mobile apps share (apps/web/src/loop/runtime)
 * pairs with a host in three steps, and these are the endpoints it calls:
 *
 *   GET  /.well-known/loop/environment   who this host is (id, name, platform)
 *   POST /oauth/token                    pairing token → access token
 *   POST /api/auth/websocket-ticket      access token → one-use socket ticket
 *   GET  /api/auth/session               is this access token still good
 *
 * The pairing token is the serve token: the URL `loop serve` prints, or its
 * QR code, is the pairing link. Possession of it was already full control of
 * this machine, so the access token handed out is that same token — there is
 * no weaker credential to mint, and a separate one would only be a second
 * secret to leak. Revoking every device is rotating the serve token.
 *
 * Tickets are the one new secret: random, single-use and short-lived, so the
 * socket URL a client opens (and a proxy may log) never carries the token.
 */
import { createHash, randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from "./protocol";

/** How long a socket ticket stays redeemable. Clients redeem immediately. */
export const WS_TICKET_TTL_MS = 60_000;
/** What the access token claims for its lifetime; it lasts as long as the serve token. */
const ACCESS_TOKEN_EXPIRES_IN_S = 365 * 24 * 60 * 60;

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const STANDARD_SCOPES = ["orchestration:read", "orchestration:operate", "terminal:operate", "review:write"];

/** The routes this module answers. Everything else stays with serve. */
const PAIRING_PATHS = new Set([
    "/.well-known/loop/environment",
    "/oauth/token",
    "/api/auth/session",
    "/api/auth/websocket-ticket",
]);

export function isPairingPath(pathname: string): boolean {
    return PAIRING_PATHS.has(pathname);
}

/**
 * This host's id: stable for as long as its serve token is, and derived from
 * it one-way so the id (which is public) says nothing about the token.
 */
export function environmentIdFor(token: string): string {
    return `loop-${createHash("sha256").update(`loop-environment:${token}`).digest("hex").slice(0, 24)}`;
}

function platform(): { os: "darwin" | "linux" | "windows" | "unknown"; arch: "arm64" | "x64" | "other" } {
    const os =
        process.platform === "darwin"
            ? "darwin"
            : process.platform === "linux"
              ? "linux"
              : process.platform === "win32"
                ? "windows"
                : "unknown";
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "other";
    return { os, arch };
}

const AUTH_DESCRIPTOR = {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "loop_serve",
} as const;

/** Any origin may pair: the token, not the origin, is the lock. */
const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, dpop",
    "access-control-max-age": "600",
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
}

/** OAuth's error shape, which the client decodes. */
function oauthError(error: string, description: string, status = 400): Response {
    return json({ error, error_description: description }, status);
}

export function bearerToken(req: Request): string | null {
    const header = req.headers.get("authorization");
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1]!.trim() : null;
}

export interface PairingOptions {
    readonly token: string;
    readonly version: string;
    readonly label?: string;
    readonly tokenMatches: (candidate: string | null) => boolean;
    readonly now?: () => number;
}

export interface Pairing {
    /** Answer a pairing route; null when `req` is not one. */
    handle(req: Request): Promise<Response | null>;
    /** Redeem a socket ticket. True once per ticket, and only before it expires. */
    redeemTicket(ticket: string | null): boolean;
}

export function createPairing(opts: PairingOptions): Pairing {
    const now = opts.now ?? Date.now;
    const environmentId = environmentIdFor(opts.token);
    const label = opts.label ?? (osHostname().replace(/\.local$/, "") || "loop");
    /** ticket → expiry. Swept on every issue, so it cannot grow unbounded. */
    const tickets = new Map<string, number>();

    const sweep = () => {
        const t = now();
        for (const [ticket, expiresAt] of tickets) if (expiresAt <= t) tickets.delete(ticket);
    };

    return {
        async handle(req) {
            const url = new URL(req.url);
            if (!isPairingPath(url.pathname)) return null;
            if (req.method === "OPTIONS") {
                // Echo what the client means to send: its runtime adds tracing
                // headers (`traceparent`) on top of auth, and a fixed list
                // would refuse the next one it grows. The token is the lock.
                const requested = req.headers.get("access-control-request-headers");
                return new Response(null, {
                    status: 204,
                    headers: {
                        ...CORS_HEADERS,
                        ...(requested ? { "access-control-allow-headers": requested } : {}),
                    },
                });
            }

            switch (url.pathname) {
                // Public on purpose: a client has to learn who it is talking
                // to before it can be asked for the token.
                case "/.well-known/loop/environment":
                    return json({
                        environmentId,
                        label,
                        platform: platform(),
                        serverVersion: opts.version,
                        // The client↔host protocol (protocol.ts), so a client
                        // can say "update" before it pairs, not after.
                        protocol: PROTOCOL_VERSION,
                        minClientProtocol: MIN_CLIENT_PROTOCOL,
                        capabilities: { repositoryIdentity: false, connectionProbe: true },
                    });

                case "/oauth/token": {
                    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
                    const form = new URLSearchParams(await req.text());
                    if (form.get("grant_type") !== TOKEN_EXCHANGE_GRANT) {
                        return oauthError("unsupported_grant_type", "Only token exchange is supported.");
                    }
                    if (!opts.tokenMatches(form.get("subject_token"))) {
                        return oauthError("invalid_grant", "That pairing link is not valid for this loop.", 400);
                    }
                    return json({
                        access_token: opts.token,
                        issued_token_type: ACCESS_TOKEN_TYPE,
                        token_type: "Bearer",
                        expires_in: ACCESS_TOKEN_EXPIRES_IN_S,
                        scope: STANDARD_SCOPES.join(" "),
                    });
                }

                case "/api/auth/session": {
                    const authenticated = opts.tokenMatches(bearerToken(req));
                    return json({
                        authenticated,
                        auth: AUTH_DESCRIPTOR,
                        ...(authenticated
                            ? { scopes: STANDARD_SCOPES, sessionMethod: "bearer-access-token" }
                            : {}),
                    });
                }

                case "/api/auth/websocket-ticket": {
                    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
                    if (!opts.tokenMatches(bearerToken(req))) {
                        return json({ _tag: "EnvironmentAuthenticationError", message: "Not paired." }, 401);
                    }
                    sweep();
                    const ticket = randomBytes(24).toString("hex");
                    const expiresAt = now() + WS_TICKET_TTL_MS;
                    tickets.set(ticket, expiresAt);
                    return json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
                }
            }
            return null;
        },

        redeemTicket(ticket) {
            if (!ticket) return false;
            const expiresAt = tickets.get(ticket);
            if (expiresAt === undefined) return false;
            tickets.delete(ticket);
            return expiresAt > now();
        },
    };
}
