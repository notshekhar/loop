import { authStore } from "./storage";
import { clearHelperCache } from "./custom-auth";
import { customOAuthLogin } from "./oauth/custom";
import { clearCustomOAuthCreds, getCustomOAuthCreds, saveCustomOAuthCreds } from "./custom-oauth-store";
import { login as xaiLogin, refresh as xaiRefresh } from "./xai-oauth";
import { XaiErrorCode, XaiOAuthError } from "./errors";
import { getOAuthProvider } from "./oauth/registry";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type {
    AuthEntry,
    CustomProviderConfig,
    GenericOAuthCredentials,
    ProviderId,
    XaiOAuthCredentials,
} from "../types";

export { XaiOAuthError, XaiErrorCode } from "./errors";
export { normalizeCustomAuth, describeCustomAuth, resolveCustomCredential, clearHelperCache } from "./custom-auth";
export { discoverOAuthEndpoints, type OAuthEndpoints } from "./oauth/custom";
export { listChatgptRegistrations, CHATGPT_MANAGE_USAGE_URL, type ChatgptRegistration } from "./oauth/openai-chatgpt";
export { authStore, settingsStore, datasourcesStore, refreshConfigStores, migrateLegacyConfig } from "./storage";
// Moved to the projects table; re-exported here so callers keep their imports.
export { getProjectModel, setProjectModel, getProjectProviderModel } from "../sessions/projects";
// Per-project bash "always allow" grants (the approval prompt's persistence).
export { addProjectBashAllow, getProjectBashAllow, setProjectBashAllow } from "../sessions/projects";

type ProviderMap = Record<string, AuthEntry>;

function readProviders(): ProviderMap {
    return (authStore.get("providers") as ProviderMap) ?? {};
}

function writeProviders(p: ProviderMap): void {
    authStore.set("providers", p);
}

export function listAuthorizedProviders(): ProviderId[] {
    return Object.keys(readProviders()) as ProviderId[];
}

export function getActiveProvider(): ProviderId | null {
    return (authStore.get("active") as ProviderId | null) ?? null;
}

export function setActiveProvider(p: ProviderId): void {
    authStore.set("active", p);
}

export function loginApiKey(provider: ProviderId, apiKey: string): void {
    const providers = readProviders();
    providers[provider] = { mode: "apikey", provider, apiKey };
    writeProviders(providers);
    if (!getActiveProvider()) setActiveProvider(provider);
}

export function getApiKey(provider: ProviderId): string | undefined {
    const entry = readProviders()[provider];
    if (entry?.mode === "apikey") return entry.apiKey;
    // Vercel's canonical env for AI Gateway keys. Deliberately NOT the generic
    // VERCEL_API_KEY fallback: that name is used for platform/deploy tokens,
    // which are not gateway keys.
    if (provider === "vercel") return process.env["AI_GATEWAY_API_KEY"];
    return process.env[`${provider.toUpperCase()}_API_KEY`];
}

export async function loginXaiOAuth(onAuth: (info: { url: string; instructions: string }) => void): Promise<void> {
    const creds = await xaiLogin({ onAuth });
    const providers = readProviders();
    providers.xai = { mode: "oauth", provider: "xai", xai: creds };
    writeProviders(providers);
    if (!getActiveProvider()) setActiveProvider("xai");
}

export function getXaiCreds(): XaiOAuthCredentials | undefined {
    const entry = readProviders().xai;
    if (entry?.mode === "oauth" && "xai" in entry) return entry.xai;
    return undefined;
}

export async function getAccessToken(provider: "xai", opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const creds = getXaiCreds();
    if (!creds) throw new XaiOAuthError("No xAI OAuth credentials.", XaiErrorCode.AUTH_MISSING, true);
    const expired = Date.now() >= creds.expires;
    if (!opts.forceRefresh && !expired) return creds.access;
    const fresh = await xaiRefresh(creds);
    const providers = readProviders();
    providers.xai = { mode: "oauth", provider: "xai", xai: fresh };
    writeProviders(providers);
    return fresh.access;
}

// ─── Generic OAuth (anthropic, github-copilot) ────────────

export async function loginOAuth(provider: ProviderId, cb: OAuthLoginCallbacks): Promise<void> {
    const impl = getOAuthProvider(provider);
    if (!impl) throw new Error(`No OAuth provider registered for ${provider}`);
    const creds = await impl.login(cb);
    const providers = readProviders();
    providers[provider] = { mode: "oauth", provider, creds };
    writeProviders(providers);
    if (!getActiveProvider()) setActiveProvider(provider);
}

/**
 * Returns bearer token for a provider. Resolves stored API key, OAuth creds
 * (auto-refresh + persist), or env var fallback. Pi-mono pattern.
 */
export async function resolveAuthToken(provider: ProviderId): Promise<string | null> {
    const providers = readProviders();
    const entry = providers[provider];

    if (entry?.mode === "apikey") return entry.apiKey;

    if (entry?.mode === "oauth" && "creds" in entry) {
        const impl = getOAuthProvider(provider);
        if (!impl) return null;
        let creds = entry.creds;
        if (Date.now() >= creds.expires) {
            try {
                creds = await impl.refreshToken(creds);
                providers[provider] = { mode: "oauth", provider, creds };
                writeProviders(providers);
            } catch {
                return null;
            }
        }
        return impl.getApiKey(creds);
    }

    // env var fallback (PROVIDER_API_KEY uppercased, with - → _)
    const envKey = `${provider.replace(/-/g, "_").toUpperCase()}_API_KEY`;
    return process.env[envKey] ?? null;
}

/**
 * Like resolveAuthToken but returns the whole credentials object (refreshed +
 * persisted). Needed by callers that read more than the bearer token — e.g.
 * the ChatGPT plan catalog keys its cache by the issued client id.
 */
export async function resolveOAuthCreds(provider: ProviderId): Promise<GenericOAuthCredentials | null> {
    let entry = readProviders()[provider];
    if (entry?.mode !== "oauth" || !("creds" in entry)) return null;
    const impl = getOAuthProvider(provider);
    if (!impl) return null;
    if (Date.now() < entry.creds.expires) return entry.creds;

    // Another loop process may already have refreshed — and with rotating
    // refresh tokens, refreshing again from our stale copy would present a
    // spent token and get the whole session revoked. Re-read the file first.
    authStore.refresh();
    entry = readProviders()[provider];
    if (entry?.mode !== "oauth" || !("creds" in entry)) return null;
    if (Date.now() < entry.creds.expires) return entry.creds;
    try {
        const creds = await impl.refreshToken(entry.creds);
        const providers = readProviders();
        providers[provider] = { mode: "oauth", provider, creds };
        writeProviders(providers);
        return creds;
    } catch {
        return null;
    }
}

/** Best-effort server-side revocation; a failure never blocks signing out locally. */
async function revokeRemote(entry: AuthEntry | undefined): Promise<void> {
    if (entry?.mode !== "oauth" || !("creds" in entry)) return;
    await getOAuthProvider(entry.provider)
        ?.revoke?.(entry.creds)
        .catch(() => {});
}

/**
 * Remove stored credentials. Local removal is immediate; the returned promise
 * settles once any server-side revocation has been attempted (never rejects),
 * so a short-lived CLI can await it before exiting.
 */
export function logout(provider?: ProviderId): Promise<void> {
    if (!provider) {
        const revoking = Object.values(readProviders()).map(revokeRemote);
        writeProviders({});
        authStore.set("active", null);
        return Promise.all(revoking).then(() => {});
    }
    const providers = readProviders();
    const revoking = revokeRemote(providers[provider]);
    delete providers[provider];
    writeProviders(providers);
    if (getActiveProvider() === provider) {
        const remaining = Object.keys(providers) as ProviderId[];
        authStore.set("active", remaining[0] ?? null);
    }
    return revoking;
}

export function getAuthMode(provider: ProviderId): "apikey" | "oauth" | "missing" {
    const entry = readProviders()[provider];
    if (!entry) return "missing";
    return entry.mode;
}

// ─── Custom providers ─────────────────────────────────────────────────────────

function readCustom(): Record<string, CustomProviderConfig> {
    return (authStore.get("customProviders") as Record<string, CustomProviderConfig>) ?? {};
}

function writeCustom(p: Record<string, CustomProviderConfig>): void {
    authStore.set("customProviders", p);
}

export function listCustomProviders(): CustomProviderConfig[] {
    return Object.values(readCustom());
}

export function getCustomProvider(name: string): CustomProviderConfig | undefined {
    return readCustom()[name];
}

/** Legacy flat-key mirror: apikey configs keep `apiKey` populated so loop
 * versions predating `auth` still read them; every other kind blanks it. */
export function withLegacyKeyMirror(config: CustomProviderConfig): CustomProviderConfig {
    if (!config.auth) return config;
    return { ...config, apiKey: config.auth.kind === "apikey" ? config.auth.apiKey : "" };
}

export function saveCustomProvider(config: CustomProviderConfig): void {
    const all = readCustom();
    all[config.name] = withLegacyKeyMirror(config);
    writeCustom(all);
    if (!getActiveProvider()) setActiveProvider(`custom:${config.name}`);
}

/**
 * Browser sign-in for a custom provider configured with `auth.kind: "oauth"`.
 * Persists the resulting session (access + refresh + endpoint/client) so the
 * login survives restarts; requests refresh it automatically from then on.
 */
export async function loginCustomProviderOAuth(
    cfg: Pick<CustomProviderConfig, "name" | "baseURL" | "auth">,
    cb: OAuthLoginCallbacks,
): Promise<void> {
    const creds = await customOAuthLogin(cfg, cb);
    saveCustomOAuthCreds(cfg.name, creds);
}

/** True when a custom oauth provider has a stored session. */
export function hasCustomOAuthSession(name: string): boolean {
    return getCustomOAuthCreds(name) != null;
}

export function deleteCustomProvider(name: string): void {
    const all = readCustom();
    delete all[name];
    writeCustom(all);
    clearHelperCache(name);
    clearCustomOAuthCreds(name);
    if (getActiveProvider() === `custom:${name}`) {
        authStore.set("active", null);
    }
}

export function isCustomProvider(id: string): boolean {
    return id.startsWith("custom:");
}

export function parseCustomProviderId(id: string): string | null {
    return isCustomProvider(id) ? id.slice("custom:".length) : null;
}

/**
 * The vendor API shape a provider actually speaks: custom providers (gateways
 * like bifrost) map to their configured sdk, so e.g. an anthropic-compatible
 * gateway gets anthropic-specific behavior (prompt caching, thinking budget).
 */
export function effectiveSdkProvider(provider: string): string {
    if (!isCustomProvider(provider)) return provider;
    const sdk = getCustomProvider(parseCustomProviderId(provider)!)?.sdk;
    if (!sdk) return provider;
    return sdk === "openai-compatible" ? "openai" : sdk;
}
