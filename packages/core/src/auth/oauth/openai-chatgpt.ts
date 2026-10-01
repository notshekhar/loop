/**
 * Sign in with ChatGPT — OpenAI's official "ChatGPT plan usage" flow for
 * open-source, locally run apps (developers.openai.com/siwc/token-sharing-open-source).
 *
 * The user authorizes loop once in the browser; OpenAI dynamically registers a
 * client for that ChatGPT account + workspace and the issued `client_id`
 * (oaiapp_…) is reused for every later sign-in. Model calls then go to the
 * public Responses API (api.openai.com/v1) with the OAuth access token and are
 * billed to the user's ChatGPT plan, under the per-app limits they set in
 * ChatGPT Settings → Usage. See providers/chatgpt-plan.ts for the request side.
 *
 * Two things persist outside the provider's credential entry, because they
 * must survive sign-out:
 *  - the host id (`ext_agent_host_id`): one stable opaque id per machine;
 *  - registrations: issued client id ↔ verified account, so signing in again
 *    reuses the same client instead of registering a new one.
 */
import { createServer } from "node:http";
import { PRODUCT_NAME } from "../../brand";
import type { GenericOAuthCredentials } from "../../types";
import { authStore } from "../storage";
import { generatePKCE } from "./pkce";
import type { OAuthLoginCallbacks, OAuthProviderInterface } from "./types";

export const CHATGPT_ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`;
const JWKS_URL = `${CHATGPT_ISSUER}/.well-known/jwks.json`;

/** The Responses API resource the plan-usage grant is scoped to. */
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
/** First-time registration entrypoint — never saved, never used for token exchange. */
const DYNAMIC_CLIENT = "dynamic_agent_client";
/** Without this scope a valid login still cannot spend the plan. */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

// OpenAI requires 127.0.0.1 (not localhost) and this exact path; only the port may vary.
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const PREFERRED_PORT = 1455;
const LOGIN_TIMEOUT_MS = 180_000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Where a user sets this app's weekly limit or disconnects it. */
export const CHATGPT_MANAGE_USAGE_URL = "https://chatgpt.com/#settings/Usage";

const HOST_KEY = "chatgptHostId";
const REGISTRATIONS_KEY = "chatgptRegistrations";

/** A dynamic-client registration: one ChatGPT account + workspace. */
export interface ChatgptRegistration {
    clientId: string;
    subject: string;
    email?: string;
    /** Retained for `id_token_hint`; dropped on sign-out. */
    idToken?: string;
}

// ─── Host id + registrations ────────────────────────────────────────────────

/** This machine's stable `ext_agent_host_id`, created once and kept forever. */
export function chatgptHostId(): string {
    const existing = authStore.get(HOST_KEY);
    if (typeof existing === "string" && existing) return existing;
    const id = `urn:uuid:${crypto.randomUUID()}`;
    authStore.set(HOST_KEY, id);
    return id;
}

export function listChatgptRegistrations(): ChatgptRegistration[] {
    const raw = authStore.get(REGISTRATIONS_KEY);
    return Array.isArray(raw) ? (raw as ChatgptRegistration[]) : [];
}

function saveRegistration(reg: ChatgptRegistration): void {
    const rest = listChatgptRegistrations().filter((r) => r.clientId !== reg.clientId);
    // Most recent first — the default for the next sign-in.
    authStore.set(REGISTRATIONS_KEY, [reg, ...rest]);
}

/** Sign-out keeps the registration (so the client is reused) but not the hint. */
function forgetIdToken(clientId: string): void {
    const regs = listChatgptRegistrations();
    if (!regs.some((r) => r.clientId === clientId && r.idToken)) return;
    authStore.set(
        REGISTRATIONS_KEY,
        regs.map((r) => (r.clientId === clientId ? { ...r, idToken: undefined } : r)),
    );
}

// ─── ID token validation (RS256 against OpenAI's JWKS) ──────────────────────

/** A public signing key from OpenAI's JWKS (RSA, RS256). */
type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string };

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlJson(s: string): Record<string, unknown> {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as Record<string, unknown>;
}

/** Decode a JWT payload without verifying it (expiry/scope hints only). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
        return b64urlJson(parts[1]);
    } catch {
        return null;
    }
}

export interface IdTokenExpectations {
    clientId: string;
    nonce: string;
    /** Injected in tests; defaults to OpenAI's published JWKS. */
    jwks?: { keys: Jwk[] };
    now?: number;
}

/** Verify an ID token's signature, issuer, audience, expiry and nonce. Returns its claims. */
export async function verifyIdToken(idToken: string, expect: IdTokenExpectations): Promise<Record<string, unknown>> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("ChatGPT sign-in returned a malformed ID token");
    const header = b64urlJson(parts[0]);
    if (header.alg !== "RS256") throw new Error(`ChatGPT ID token uses unexpected alg ${String(header.alg)}`);

    const jwks = expect.jwks ?? (await fetchJwks());
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error("ChatGPT ID token was signed by an unknown key");
    const key = await crypto.subtle.importKey(
        "jwk",
        { ...jwk, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
    );
    const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        b64urlToBytes(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) throw new Error("ChatGPT ID token signature is invalid");

    const claims = b64urlJson(parts[1]);
    const now = Math.floor((expect.now ?? Date.now()) / 1000);
    const aud = claims.aud;
    if (claims.iss !== CHATGPT_ISSUER) throw new Error("ChatGPT ID token has the wrong issuer");
    if (!(aud === expect.clientId || (Array.isArray(aud) && aud.includes(expect.clientId))))
        throw new Error("ChatGPT ID token was issued for a different client");
    if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("ChatGPT ID token has expired");
    if (claims.nonce !== expect.nonce) throw new Error("ChatGPT ID token nonce mismatch — possible replay");
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("ChatGPT ID token has no subject");
    return claims;
}

async function fetchJwks(): Promise<{ keys: Jwk[] }> {
    const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Could not fetch OpenAI signing keys: ${res.status}`);
    return (await res.json()) as { keys: Jwk[] };
}

// ─── Authorization request ──────────────────────────────────────────────────

export interface AuthorizeParams {
    redirectUri: string;
    challenge: string;
    state: string;
    nonce: string;
    hostId: string;
    /** Omitted for a first-time registration. */
    registration?: ChatgptRegistration;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
    const url = new URL(AUTHORIZE_URL);
    const q = url.searchParams;
    q.set("client_id", p.registration?.clientId ?? DYNAMIC_CLIENT);
    q.set("response_type", "code");
    q.set("redirect_uri", p.redirectUri);
    q.set("scope", SCOPE);
    q.set("resource", CHATGPT_RESOURCE);
    q.set("state", p.state);
    q.set("nonce", p.nonce);
    q.set("code_challenge_method", "S256");
    q.set("code_challenge", p.challenge);
    q.set("ext_agent_host_id", p.hostId);
    if (p.registration) {
        if (p.registration.idToken) q.set("id_token_hint", p.registration.idToken);
        if (p.registration.email) q.set("login_hint", p.registration.email);
    } else {
        q.set("agent_name_hint", PRODUCT_NAME);
    }
    return url.toString();
}

// ─── Loopback callback ──────────────────────────────────────────────────────

interface CallbackResult {
    code?: string;
    state?: string;
    clientId?: string;
    error?: string;
    errorDescription?: string;
}

export function parseCallbackInput(input: string): CallbackResult {
    const v = input.trim();
    if (!v) return {};
    const query = v.includes("://") ? new URL(v).search : v.includes("=") ? v : null;
    if (query === null) return { code: v };
    const p = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
    return {
        code: p.get("code") ?? undefined,
        state: p.get("state") ?? undefined,
        clientId: p.get("client_id") ?? undefined,
        error: p.get("error") ?? undefined,
        errorDescription: p.get("error_description") ?? undefined,
    };
}

async function startCallbackServer() {
    let settle: (r: CallbackResult) => void = () => {};
    const result = new Promise<CallbackResult>((resolve) => (settle = resolve));
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${CALLBACK_HOST}`);
        if (url.pathname !== CALLBACK_PATH) {
            res.writeHead(404).end("Not found");
            return;
        }
        const r = parseCallbackInput(url.toString());
        const ok = !r.error && r.code;
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
            `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center"><p>${
                ok
                    ? `Signed in with ChatGPT. You can close this tab and return to ${PRODUCT_NAME}.`
                    : "ChatGPT sign-in did not complete. You can close this tab."
            }</p></body>`,
        );
        settle(r);
    });
    const listen = (port: number) =>
        new Promise<number>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, CALLBACK_HOST, () => {
                server.removeAllListeners("error");
                const addr = server.address();
                resolve(typeof addr === "object" && addr ? addr.port : port);
            });
        });
    // Only the port may vary between sign-ins, so a busy 1455 is fine.
    const port = await listen(PREFERRED_PORT).catch(() => listen(0));
    return { server, redirectUri: `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`, result };
}

// ─── Token endpoint ─────────────────────────────────────────────────────────

/** OAuth error codes after which the refresh token is dead and only a new sign-in helps. */
const DEAD_REFRESH_ERRORS = new Set([
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
]);

async function postToken(body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
        json = JSON.parse(text) as Record<string, unknown>;
    } catch {
        // non-JSON error body — reported below
    }
    if (!res.ok) {
        const code = typeof json.error === "string" ? json.error : `${res.status}`;
        const err = new Error(
            DEAD_REFRESH_ERRORS.has(code)
                ? `ChatGPT session expired (${code}). Sign in again: /login openai`
                : `ChatGPT token request failed: ${code} ${typeof json.error_description === "string" ? json.error_description : text.slice(0, 200)}`,
        );
        (err as Error & { code?: string }).code = code;
        throw err;
    }
    return json;
}

function grantedScopes(payload: Record<string, unknown>, fallback?: unknown): string[] {
    const s = typeof payload.scope === "string" ? payload.scope : undefined;
    if (s) return s.split(/\s+/).filter(Boolean);
    return Array.isArray(fallback) ? (fallback as string[]) : [];
}

function credsFromTokenResponse(
    payload: Record<string, unknown>,
    base: { clientId: string; hostId: string; subject: string; email?: string; scopes?: unknown },
    prev?: GenericOAuthCredentials,
): GenericOAuthCredentials {
    const access = String(payload.access_token ?? "");
    if (!access) throw new Error("ChatGPT token response is missing access_token");
    // Refresh tokens rotate; RFC 6749 §6 still allows a response without one.
    const refresh = String(payload.refresh_token ?? prev?.refresh ?? "");
    if (!refresh) throw new Error("ChatGPT token response is missing refresh_token");
    const expiresIn = Number(payload.expires_in ?? 3600);
    return {
        access,
        refresh,
        expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
        idToken: String(payload.id_token ?? prev?.idToken ?? ""),
        clientId: base.clientId,
        hostId: base.hostId,
        subject: base.subject,
        ...(base.email ? { email: base.email } : {}),
        scopes: grantedScopes(payload, base.scopes),
    };
}

// Refresh tokens rotate and a reused one is revoked, so two concurrent refreshes
// of the same session (parallel subagents) would sign the user out. Share one.
const refreshInFlight = new Map<string, Promise<GenericOAuthCredentials>>();

// ─── Provider ───────────────────────────────────────────────────────────────

export const openaiChatgptOAuthProvider: OAuthProviderInterface = {
    id: "openai-chatgpt",
    name: "ChatGPT",

    async login(cb: OAuthLoginCallbacks): Promise<GenericOAuthCredentials> {
        const hostId = chatgptHostId();
        const registration = cb.freshRegistration ? undefined : listChatgptRegistrations()[0];
        const { verifier, challenge } = await generatePKCE();
        const state = crypto.randomUUID();
        const nonce = crypto.randomUUID();

        // The listener must be up before the browser opens.
        const callback = await startCallbackServer();
        try {
            cb.onAuth({
                url: buildAuthorizeUrl({
                    redirectUri: callback.redirectUri,
                    challenge,
                    state,
                    nonce,
                    hostId,
                    registration,
                }),
                instructions: registration?.email
                    ? `Continue with ChatGPT as ${registration.email} in the browser, then return to ${PRODUCT_NAME}.`
                    : `Continue with ChatGPT in the browser and approve ${PRODUCT_NAME}, then return here.`,
            });

            const pasted = cb
                .onPrompt({ message: "Paste the redirect URL (or wait for the browser)", allowEmpty: true })
                .then(parseCallbackInput)
                .catch((): CallbackResult => ({}));
            const timeout = new Promise<CallbackResult>((resolve) =>
                setTimeout(() => resolve({ error: "timeout" }), LOGIN_TIMEOUT_MS).unref?.(),
            );
            const r = await Promise.race([callback.result, pasted, timeout]);

            if (cb.signal?.aborted) throw new Error("Login cancelled");
            if (r.error === "timeout") throw new Error("ChatGPT sign-in timed out");
            if (r.state !== state) throw new Error("ChatGPT sign-in state mismatch — possible CSRF");
            if (r.error === "access_denied")
                throw new Error("ChatGPT plan use was not approved. Run /login openai to try again.");
            if (r.error) throw new Error(`ChatGPT sign-in failed: ${r.errorDescription ?? r.error}`);
            if (!r.code) throw new Error("ChatGPT sign-in returned no authorization code");

            // A new registration must hand back its issued client id; a returning
            // one may omit it but must never switch to a different one.
            let clientId: string;
            if (registration) {
                if (r.clientId && r.clientId !== registration.clientId)
                    throw new Error("ChatGPT returned a different client than the one being signed in to");
                clientId = registration.clientId;
            } else {
                if (!r.clientId || r.clientId === DYNAMIC_CLIENT)
                    throw new Error("ChatGPT registration did not return a client id — registration is incomplete");
                clientId = r.clientId;
            }

            const payload = await postToken({
                grant_type: "authorization_code",
                client_id: clientId,
                code: r.code,
                code_verifier: verifier,
                redirect_uri: callback.redirectUri,
                resource: CHATGPT_RESOURCE,
            });

            const idToken = String(payload.id_token ?? "");
            const claims = await verifyIdToken(idToken, { clientId, nonce });
            const subject = claims.sub as string;
            if (registration && registration.subject !== subject)
                throw new Error("Signed in to a different ChatGPT account than the one selected");

            const scopes = grantedScopes(payload);
            if (!scopes.includes(PLAN_SCOPE))
                throw new Error(
                    "Signed in, but ChatGPT plan use was not granted. Run /login openai again and allow plan usage.",
                );

            const email = typeof claims.email === "string" ? claims.email : registration?.email;
            saveRegistration({ clientId, subject, ...(email ? { email } : {}), idToken });
            return credsFromTokenResponse(payload, { clientId, hostId, subject, email, scopes });
        } finally {
            callback.server.close();
        }
    },

    async refreshToken(creds: GenericOAuthCredentials): Promise<GenericOAuthCredentials> {
        const clientId = creds.clientId as string | undefined;
        if (!clientId || !creds.refresh) throw new Error("ChatGPT session is incomplete. Sign in again: /login openai");
        const pending = refreshInFlight.get(creds.refresh);
        if (pending) return pending;
        const run = (async () => {
            const payload = await postToken({
                grant_type: "refresh_token",
                client_id: clientId,
                refresh_token: creds.refresh,
                resource: CHATGPT_RESOURCE,
            });
            return credsFromTokenResponse(
                payload,
                {
                    clientId,
                    hostId: (creds.hostId as string | undefined) ?? chatgptHostId(),
                    subject: String(creds.subject ?? ""),
                    email: creds.email as string | undefined,
                    scopes: creds.scopes,
                },
                creds,
            );
        })();
        refreshInFlight.set(creds.refresh, run);
        try {
            return await run;
        } finally {
            refreshInFlight.delete(creds.refresh);
        }
    },

    getApiKey(creds: GenericOAuthCredentials): string {
        return creds.access;
    },

    async revoke(creds: GenericOAuthCredentials): Promise<void> {
        const clientId = creds.clientId as string | undefined;
        if (clientId) forgetIdToken(clientId);
        if (!clientId || !creds.refresh) return;
        // An empty 200 is success, including for an already-invalid token.
        await fetch(REVOKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: creds.refresh, token_type_hint: "refresh_token", client_id: clientId }),
            signal: AbortSignal.timeout(10_000),
        });
    },
};
