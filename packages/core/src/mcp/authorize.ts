/**
 * Drives the interactive OAuth login for one MCP server. Core stays
 * UI-agnostic: the caller supplies `openUrl` (the browser opener lives in the
 * CLI) and we resolve once tokens are stored.
 */
import { CONFIG_DIR_NAME } from "../brand";
import { auth } from "@ai-sdk/mcp";
import { isHttpServer, type McpServerConfig } from "./config";
import { clearMcpAuth, oauthClientOptions, readMcpAuth, restoreMcpAuth, McpOAuthProvider } from "./oauth";
import { startCallbackServer } from "../auth/oauth-callback";
import { McpUnsupportedServerError, unsupportedRemoteServer } from "./providers";

const LOGIN_TIMEOUT_MS = 180_000;

/**
 * Runs discovery → registration → browser consent → token exchange. Throws on
 * failure (bad config, timeout, denied consent); resolves when tokens are
 * persisted and the server is ready to connect.
 */
export async function authorizeServer(
    name: string,
    cfg: McpServerConfig,
    openUrl: (url: string) => void,
): Promise<void> {
    if (!isHttpServer(cfg)) {
        throw new Error(`server "${name}" is not an HTTP server — OAuth only applies to http/sse servers`);
    }

    // The server advertises its authorization server via the 401
    // WWW-Authenticate `resource_metadata` URL. Without it, auth() falls back to
    // treating the MCP URL as the issuer and rejects the real (e.g. Keycloak)
    // auth server. The transport passes this automatically on a live connect;
    // our explicit login must fetch it ourselves.
    const { resourceMetadataUrl, scopes } = await discoverResourceHints(cfg.url);

    const opts = oauthClientOptions(cfg);
    // A server that names the scopes it wants means it. Figma's 401 carries
    // `scope="mcp:connect"` and its resource metadata lists the same, and a
    // consent request that asks for nothing gets a token good for nothing.
    // Configured `scopes` still win — this only fills the gap, so nobody has to
    // read a WWW-Authenticate header to write a working server entry.
    if (!opts.scopes?.length && scopes?.length) opts.scopes = scopes;
    const callback = await startCallbackServer();
    // Start clean: a dynamically-registered client is bound to the redirect URI
    // it was created with. Re-registering against this run's live callback URI
    // avoids a redirect_uri mismatch if a stale client (e.g. from a background
    // connect) was registered on a different port. A pre-configured clientId
    // isn't stored here, so this never drops it.
    //
    // But keep what was there. "Re-authorize" is offered on servers that are
    // working — an expired session looks identical to a live one until a call
    // fails — and wiping first meant a login the user cancelled, or that timed
    // out, or that hit a flaky network, signed them OUT of a session that was
    // fine. The old session goes back if this attempt doesn't finish.
    const previous = readMcpAuth(name);
    let authorized = false;
    try {
        clearMcpAuth(name);
        const provider = new McpOAuthProvider(name, callback.redirectUri, (url) => openUrl(url.toString()), opts);

        // First pass: no auth code yet → provider.redirectToAuthorization fires,
        // the browser opens, and auth() returns "REDIRECT".
        const first = await runAuth(
            () => auth(provider, { serverUrl: cfg.url, resourceMetadataUrl }),
            !opts.clientId,
            cfg.url,
        );
        if (first === "AUTHORIZED") {
            authorized = true;
            return; // already had a valid session
        }

        const { code, state } = await callback.waitForCode(LOGIN_TIMEOUT_MS);

        // Second pass: exchange the code for tokens (saved via saveTokens).
        const result = await runAuth(
            () =>
                auth(provider, {
                    serverUrl: cfg.url,
                    authorizationCode: code,
                    callbackState: state,
                    resourceMetadataUrl,
                }),
            !opts.clientId,
            cfg.url,
        );
        if (result !== "AUTHORIZED") {
            throw new Error("authorization did not complete");
        }
        authorized = true;
    } finally {
        callback.close();
        // Nothing was gained, so give back what was there. Only a session that
        // actually existed is restored — a first-time login that fails leaves
        // the server exactly as unauthorized as it was.
        if (!authorized && previous) restoreMcpAuth(name, previous);
    }
}

/**
 * Run one `auth()` step, translating the SDK's cryptic registration failures
 * into an actionable message. A server that forbids anonymous dynamic client
 * registration answers 403 with a body that isn't JSON, so the SDK's own error
 * is a parse failure several layers from the cause.
 *
 * Two different things look identical here, and the difference decides whether
 * the user has any move at all: a provider that simply wants you to register an
 * app first (set clientId/clientSecret and you're in), and one that allow-lists
 * which products may connect at all. Figma is the second kind — its registration
 * endpoint matches `client_name` against the Figma MCP Catalog and 403s
 * everything else, so no local configuration can help. Say so rather than
 * sending someone to a developer console to make credentials that will also be
 * refused.
 */
async function runAuth<T>(fn: () => Promise<T>, usedDynamicRegistration: boolean, serverUrl: string): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (usedDynamicRegistration && /\b(403|forbidden|registration|invalid oauth error response)\b/i.test(msg)) {
            const unsupported = unsupportedRemoteServer(serverUrl);
            // Nothing here can be configured into working, so the answer IS the
            // message: no HTTP status, no JSON parse error from four layers
            // down, and no stack — those turn an answer back into a crash.
            if (unsupported) throw new McpUnsupportedServerError(unsupported);
            throw new Error(`${msg}\n\n${registrationAdvice(serverUrl)}`);
        }
        throw err;
    }
}

/**
 * What to tell someone whose registration was refused.
 *
 * Two situations look identical at the HTTP layer and the difference decides
 * whether they have a move at all: a provider that wants an OAuth app
 * registered first, and one that allow-lists which products may connect. Only
 * the first is worth a trip to a developer console.
 */
export function registrationAdvice(serverUrl: string): string {
    return (
        unsupportedRemoteServer(serverUrl) ??
        `This server blocks automatic OAuth client registration. Register an OAuth app with the provider, ` +
            `then add "clientId" (and "clientSecret" for confidential clients) to the server entry in ` +
            `~/${CONFIG_DIR_NAME}/settings.json.`
    );
}

/** What an unauthenticated probe of the server tells us about logging in. */
export interface ResourceHints {
    /** RFC 9728 protected-resource metadata document, if advertised. */
    resourceMetadataUrl?: URL;
    /** Scopes the server says this resource needs, if it says. */
    scopes?: string[];
}

/**
 * Ask the server, unauthenticated, what it wants — reading both halves of the
 * 401 it answers with (RFC 9728): the `resource_metadata` URL that names the
 * real authorization server, and the `scope` the resource requires. Everything
 * here is best-effort: a server that advertises neither leaves the caller on
 * the SDK's default well-known discovery, which is the old behaviour.
 */
async function discoverResourceHints(serverUrl: string): Promise<ResourceHints> {
    let response: Response;
    try {
        response = await fetch(serverUrl, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
    } catch {
        return {};
    }
    const header = response.headers.get("www-authenticate") ?? "";
    const resourceMetadataUrl = parseUrl(header.match(/resource_metadata="([^"]+)"/i)?.[1]);
    const headerScope = splitScope(header.match(/\bscope="([^"]+)"/i)?.[1]);
    const scopes = headerScope ?? (await fetchSupportedScopes(resourceMetadataUrl));
    return { resourceMetadataUrl, scopes };
}

/**
 * `scopes_supported` from the protected-resource document — the other place
 * the spec allows a server to state its scopes, and the one Figma fills in when
 * the header is fetched from a cache that dropped it.
 */
async function fetchSupportedScopes(resourceMetadataUrl: URL | undefined): Promise<string[] | undefined> {
    if (!resourceMetadataUrl) return undefined;
    try {
        const response = await fetch(resourceMetadataUrl, { headers: { accept: "application/json" } });
        if (!response.ok) return undefined;
        const body = (await response.json()) as { scopes_supported?: unknown };
        const scopes = body?.scopes_supported;
        if (!Array.isArray(scopes)) return undefined;
        const strings = scopes.filter((s): s is string => typeof s === "string" && s.length > 0);
        return strings.length > 0 ? strings : undefined;
    } catch {
        return undefined;
    }
}

function splitScope(raw: string | undefined): string[] | undefined {
    const parts = raw?.split(/\s+/).filter(Boolean);
    return parts?.length ? parts : undefined;
}

function parseUrl(raw: string | undefined): URL | undefined {
    if (!raw) return undefined;
    try {
        return new URL(raw);
    } catch {
        return undefined;
    }
}
