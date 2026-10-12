/**
 * OAuth 2.0 for MCP servers. Implements the AI SDK's OAuthClientProvider,
 * backed by ~/.loop/mcp-auth.json so tokens survive restarts. The AI SDK's
 * `auth()` helper drives discovery, dynamic client registration, PKCE, and
 * token exchange — this provider just persists each piece and hands the
 * authorization URL to a caller-supplied opener (the browser).
 */
import Configstore from "configstore";
import { randomBytes } from "node:crypto";
import { getConfigDir, PRODUCT_NAME } from "../brand";
import { join } from "node:path";
import type {
    OAuthAuthorizationServerInformation,
    OAuthClientInformation,
    OAuthClientMetadata,
    OAuthClientProvider,
    OAuthTokens,
} from "@ai-sdk/mcp";
import { isHttpServer, resolveSecrets, type HttpServerConfig, type McpServerConfig } from "./config";

/**
 * Optional, user-supplied OAuth client config (from the server entry). When a
 * `clientId` is present we hand it to the SDK as already-registered client
 * information, so it skips dynamic client registration entirely — the escape
 * hatch for servers that gate or forbid anonymous registration (e.g. Figma).
 */
export interface OAuthClientOptions {
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
}

/** Pull the OAuth client options out of a server config, resolving secrets. */
export function oauthClientOptions(cfg: HttpServerConfig): OAuthClientOptions {
    return {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret ? resolveSecrets(cfg.clientSecret) : undefined,
        scopes: cfg.scopes,
    };
}

// Lazy so importing this module never touches the disk (Configstore writes its
// defaults file in the constructor, which would create the config dir as a
// side effect of an import). Raw Configstore (not CachedStore): server
// names are user-chosen and may contain dots, which Configstore treats as
// nested paths — get/set must stay symmetric with existing files.
let _mcpAuthStore: Configstore | null = null;
function mcpAuthStore(): Configstore {
    if (_mcpAuthStore === null) {
        _mcpAuthStore = new Configstore(
            `${PRODUCT_NAME}-agent-mcp-auth`,
            {},
            {
                configPath: join(getConfigDir(), "mcp-auth.json"),
            },
        );
    }
    return _mcpAuthStore;
}

/** Everything we persist for one server's OAuth session. */
export interface StoredAuth {
    clientInformation?: OAuthClientInformation;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    state?: string;
    /**
     * Which authorization server the login was started against.
     *
     * Stored in its own right rather than as fields on `clientInformation`,
     * which is where the SDK puts it if you let it. That default only works
     * when the client information is the stored object — and with a configured
     * `clientId` it is synthesized fresh on every read, so the metadata written
     * before the redirect was invisible by the time the code came back and the
     * exchange failed with "Stored OAuth authorization server metadata is
     * required". Keeping it separate makes the two independent.
     */
    authorizationServer?: OAuthAuthorizationServerInformation;
}

function read(server: string): StoredAuth {
    return (mcpAuthStore().get(server) as StoredAuth | undefined) ?? {};
}

function write(server: string, patch: Partial<StoredAuth>): void {
    mcpAuthStore().set(server, { ...read(server), ...patch });
}

/** True once a server has completed login (used to decide auto-connect). */
export function hasStoredTokens(server: string): boolean {
    return read(server).tokens?.access_token != null;
}

/**
 * Whether signing in applies to this server — the question every UI asks
 * before offering an authorize action.
 *
 * Deliberately NOT just `auth: "oauth"`. Most servers are never configured
 * with that flag: they are added as a plain URL and only reveal that they want
 * OAuth when the first connect comes back 401, which is what `needsAuth`
 * carries. And a server that HAS been signed in stays signed-in-able forever
 * after — the reason this exists at all is the session that expires while the
 * status still reads "ready", where the only fix is to sign in again and the
 * old rule showed no way to.
 *
 * `false` for a stdio server, which has no login of any kind, and for a remote
 * one that has never asked for auth and holds no tokens — an authorize button
 * on a public server is an offer that can only fail.
 */
export function isOAuthServer(server: string, cfg: McpServerConfig, needsAuth = false): boolean {
    if (!isHttpServer(cfg)) return false;
    return cfg.auth === "oauth" || needsAuth || hasStoredTokens(server);
}

/** Forget a server's OAuth session entirely (used on /mcp delete or re-auth). */
export function clearMcpAuth(server: string): void {
    mcpAuthStore().delete(server);
}

/**
 * The whole stored session, so a caller can put it back.
 *
 * Only the login flow needs this: it clears the session before starting (a
 * dynamically-registered client is bound to the redirect URI it registered
 * with) and must be able to undo that when the login doesn't complete.
 * Returns undefined when there was nothing stored.
 */
export function readMcpAuth(server: string): StoredAuth | undefined {
    const stored = mcpAuthStore().get(server) as StoredAuth | undefined;
    return stored && Object.keys(stored).length > 0 ? stored : undefined;
}

/** Put a session read by `readMcpAuth` back, replacing whatever is there now. */
export function restoreMcpAuth(server: string, auth: StoredAuth): void {
    mcpAuthStore().set(server, auth);
}

/**
 * `onRedirect` is called with the provider authorization URL. During a normal
 * background connect it's left undefined, so a server that still needs login
 * surfaces as needs-auth instead of silently popping a browser. The /mcp
 * authorize flow passes a real opener.
 */
export class McpOAuthProvider implements OAuthClientProvider {
    constructor(
        private readonly server: string,
        private readonly redirectUri: string,
        private readonly onRedirect?: (url: URL) => void,
        private readonly opts: OAuthClientOptions = {},
    ) {}

    get redirectUrl(): string {
        return this.redirectUri;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: PRODUCT_NAME,
            redirect_uris: [this.redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            // A configured secret means a confidential client; otherwise we're a
            // public client and authenticate the token request with PKCE alone.
            token_endpoint_auth_method: this.opts.clientSecret ? "client_secret_post" : "none",
            ...(this.opts.scopes?.length ? { scope: this.opts.scopes.join(" ") } : {}),
        };
    }

    clientInformation(): OAuthClientInformation | undefined {
        // A user-supplied client_id short-circuits dynamic registration: hand it
        // straight to the SDK (with the secret for confidential clients). Falls
        // back to whatever a prior registration stored.
        if (this.opts.clientId) {
            return { client_id: this.opts.clientId, client_secret: this.opts.clientSecret };
        }
        return read(this.server).clientInformation;
    }

    saveClientInformation(info: OAuthClientInformation): void {
        write(this.server, { clientInformation: info });
    }

    /**
     * The authorization server the SDK resolved, kept across the two `auth()`
     * passes of a login.
     *
     * Implementing this pair is what makes the code exchange work for a
     * pre-registered client. Without them the SDK falls back to stamping the
     * same metadata onto whatever `saveClientInformation` persists and reading
     * it back off `clientInformation()` — which silently does nothing when a
     * configured `clientId` makes that a fresh literal each time. Slack, Figma
     * and every other server that forbids dynamic registration are exactly the
     * ones that set `clientId`, so the flow failed for precisely the servers
     * that needed it.
     */
    saveAuthorizationServerInformation(info: OAuthAuthorizationServerInformation): void {
        write(this.server, { authorizationServer: info });
    }

    authorizationServerInformation(): OAuthAuthorizationServerInformation | undefined {
        return read(this.server).authorizationServer;
    }

    tokens(): OAuthTokens | undefined {
        return read(this.server).tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        // RFC 6749 §6: a token-refresh response MAY omit refresh_token, which
        // means "keep using the existing one". Saving the response verbatim
        // would drop the stored refresh_token, so the *next* restart has nothing
        // to refresh with — the SDK then wipes the session (invalidateCredentials),
        // which is why MCP auth "expires" on every relaunch. Carry the previous
        // refresh_token forward whenever the new payload doesn't include one.
        const previous = read(this.server).tokens;
        const merged: OAuthTokens = {
            ...tokens,
            refresh_token: tokens.refresh_token ?? previous?.refresh_token,
        };
        write(this.server, { tokens: merged });
    }

    saveCodeVerifier(codeVerifier: string): void {
        write(this.server, { codeVerifier });
    }

    codeVerifier(): string {
        const verifier = read(this.server).codeVerifier;
        if (!verifier) throw new Error("no PKCE code verifier stored — restart the authorization flow");
        return verifier;
    }

    saveState(state: string): void {
        write(this.server, { state });
    }

    /**
     * Mint a fresh, unguessable `state` for each authorization request.
     *
     * This used to return the STORED state, defaulting to `""` — backwards on
     * both counts. The SDK calls `state()` to CREATE the value and
     * `saveState()` to persist it, so reading it back yielded an empty string
     * on every first login; empty is falsy, so the SDK skipped `saveState`
     * and left the `state` parameter off the authorization URL entirely.
     *
     * Two consequences, and both bit. Nothing bound the callback to the request
     * that started it (`storedState()` stayed undefined, so the SDK's CSRF
     * check was skipped every time), and any server that advertises
     * `require_state_parameter` — Figma's authorization server does — rejects a
     * request that arrives without one, so those logins could never complete.
     */
    state(): string {
        return randomBytes(32).toString("base64url");
    }

    storedState(): string | undefined {
        return read(this.server).state;
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        if (!this.onRedirect) {
            // Background connect with no opener: signal "login required" rather
            // than open a browser the user didn't ask for.
            throw new McpAuthRequiredError(this.server);
        }
        this.onRedirect(authorizationUrl);
    }

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
        if (scope === "all") {
            clearMcpAuth(this.server);
            return;
        }
        const patch: Partial<StoredAuth> = {};
        if (scope === "tokens") patch.tokens = undefined;
        else if (scope === "verifier") patch.codeVerifier = undefined;
        else patch.clientInformation = undefined;
        write(this.server, patch);
    }
}

/** Thrown when a server needs interactive login before it can connect. */
export class McpAuthRequiredError extends Error {
    constructor(public readonly server: string) {
        super(`MCP server "${server}" requires authorization — run /mcp and choose Authorize`);
        this.name = "McpAuthRequiredError";
    }
}
