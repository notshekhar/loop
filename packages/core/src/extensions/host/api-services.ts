/**
 * The parts of the extension API backed by stores and CLI services rather than
 * contribution lists: settings, interactive UI and auth.
 */
import { getConfigDir, PRODUCT_NAME } from "../../brand";
import { join } from "node:path";
import { CachedStore, settingsStore } from "../../auth/storage";
import { startCallbackServer } from "../../auth/oauth-callback";
import type { ExtensionAPI, ExtensionUI } from "../api";
import type { ApiContext } from "./api-context";

/**
 * Per-extension secrets (OAuth tokens, API keys). Kept out of settings.json in
 * its own file, mirroring the MCP auth store (mcp/oauth.ts). Shape:
 * `{ <extension>: { <key>: <value> } }`.
 */
const extAuthStore = new CachedStore(
    `${PRODUCT_NAME}-agent-ext-auth`,
    {},
    { configPath: join(getConfigDir(), "ext-auth.json") },
);
type SecretBag = Record<string, Record<string, string>>;

/** How long a loopback OAuth flow waits for the browser redirect by default. */
const LOOPBACK_OAUTH_TIMEOUT_MS = 180_000;

/**
 * Per-extension settings live under one un-dotted top-level key as a
 * nested object: settingsStore uses dot-prop for `.set`, so a dotted key
 * would write a nested path that flat reads can't see. Read-modify-write
 * the whole bag keeps it consistent with CachedStore's flat get.
 */
const OWN_SETTINGS_KEY = "extensionSettings";
type OwnSettingsBag = Record<string, Record<string, unknown>>;

export function settingsApi(name: string): ExtensionAPI["settings"] {
    const readOwn = (k: string) => ((settingsStore.get(OWN_SETTINGS_KEY) as OwnSettingsBag)?.[name] ?? {})[k];
    const writeOwn = (k: string, v: unknown) => {
        // Fresh read before the bag rewrite so a concurrent process's
        // settings write isn't clobbered from a stale cache.
        settingsStore.refresh();
        const bag = { ...((settingsStore.get(OWN_SETTINGS_KEY) as OwnSettingsBag) ?? {}) };
        bag[name] = { ...(bag[name] ?? {}), [k]: v };
        settingsStore.set(OWN_SETTINGS_KEY, bag);
    };
    return {
        get: (key) => settingsStore.get(key as string) as never,
        set: (key, value) => settingsStore.set(key as string, value),
        getOwn: ((key: string, fallback?: unknown) => {
            const v = readOwn(key);
            return (v === undefined ? fallback : v) as never;
        }) as ExtensionAPI["settings"]["getOwn"],
        setOwn: ((key: string, value: unknown) => writeOwn(key, value)) as never,
    };
}

/**
 * api.ui — proxy to the CLI-injected bridge; throw when absent (print
 * mode) so an extension never silently no-ops an interactive flow.
 */
export function uiApi(ctx: ApiContext): ExtensionUI {
    const requireUi = (): ExtensionUI => {
        const ui = ctx.services().ui;
        if (!ui) {
            throw new Error(
                `api.ui is not available in this context (non-interactive / print mode); ` +
                    `extension "${ctx.record.name}" tried to open an interactive UI`,
            );
        }
        return ui;
    };
    return {
        select: (items, title, opts) => requireUi().select(items, title, opts),
        search: (items, title, opts) => requireUi().search(items, title, opts),
        prompt: (label, initial) => requireUi().prompt(label, initial),
        note: (text) => requireUi().note(text),
        error: (text) => requireUi().error(text),
    };
}

/** api.auth — per-extension secrets + browser/OAuth helpers. */
export function authApi(ctx: ApiContext): ExtensionAPI["auth"] {
    const name = ctx.record.name;
    const readSecret = (k: string) => ((extAuthStore.get("secrets") as SecretBag)?.[name] ?? {})[k];
    const writeSecrets = (mutate: (bag: Record<string, string>) => void) => {
        const all = { ...((extAuthStore.get("secrets") as SecretBag) ?? {}) };
        const mine = { ...(all[name] ?? {}) };
        mutate(mine);
        all[name] = mine;
        extAuthStore.set("secrets", all);
    };
    const openExternal = (url: string) => {
        const services = ctx.services();
        if (services.openExternal) services.openExternal(url);
        else ctx.log(`cannot open browser (no opener in this context): ${url}`);
    };
    return {
        getSecret: (key) => readSecret(key),
        setSecret: (key, value) => writeSecrets((bag) => void (bag[key] = value)),
        deleteSecret: (key) => writeSecrets((bag) => void delete bag[key]),
        openExternal,
        loopbackOAuth: async (opts) => {
            const server = await startCallbackServer();
            try {
                openExternal(await opts.buildAuthorizeUrl(server.redirectUri));
                const { code, state } = await server.waitForCode(opts.timeoutMs ?? LOOPBACK_OAUTH_TIMEOUT_MS);
                return { code, state, redirectUri: server.redirectUri };
            } finally {
                server.close();
            }
        },
    };
}
