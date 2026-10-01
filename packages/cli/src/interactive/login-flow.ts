import { type SelectItem, type TUI } from "@notshekhar/loop-tui";
import {
    bedrockRegion,
    envName,
    bustCatalogCache,
    CHATGPT_MANAGE_USAGE_URL,
    listChatgptRegistrations,
    deleteCustomProvider,
    discoverOAuthEndpoints,
    fetchCustomProviderModels,
    getActiveProvider,
    listAuthorizedProviders,
    listCustomProviders,
    loginApiKey,
    loginCustomProviderOAuth,
    loginOAuth,
    loginXaiOAuth,
    logout,
    listOllamaModels,
    ollamaBaseURL,
    refreshBedrockCatalog,
    resolveAwsCredentials,
    getExtensionHost,
    PROVIDER_IDS,
    saveCustomProvider,
    setActiveProvider,
    type CustomProviderAuth,
    type CustomProviderConfig,
    type OAuthEndpoints,
    type ProviderId,
} from "@notshekhar/loop-core";
import type { ChatHistory } from "./components/chat-history";
import { providerLabel } from "./provider-labels";
import { openBrowser } from "../open-browser";
import { accent, dim, err, ok, warn } from "./ui/text";

export interface LoginDeps {
    tui: TUI;
    history: ChatHistory;
    selectOnce: (items: SelectItem[], title?: string) => Promise<SelectItem | null>;
    searchOnce: (items: SelectItem[], title?: string, opts?: { initialIndex?: number }) => Promise<SelectItem | null>;
    promptOnce: (label?: string) => Promise<string>;
}

type StepResult = "done" | "back" | "cancel";

function presentAuth(deps: LoginDeps, label: string, url: string, instructions?: string): void {
    const { tui, history } = deps;
    if (instructions) history.addSystem(instructions);
    history.addSystem(accent(url));
    const opened = openBrowser(url);
    history.addSystem(dim(opened ? `(opened in browser — ${label})` : `(open this URL in a browser — ${label})`));
    tui.requestRender();
}

/**
 * Extension-registered providers that authenticate with an API key. They use
 * the generic apiKeyLogin path (the auth store is keyed by provider id). OAuth
 * extension providers self-manage via an imperative getModel + their own
 * command, so they're not listed here. Empty when no extensions are loaded.
 */
function extensionProviderItems(): SelectItem[] {
    const builtin = new Set(PROVIDER_IDS as readonly string[]);
    return getExtensionHost()
        .getProviderDescriptors()
        .filter((d) => (d.auth?.mode ?? "apikey") === "apikey" && !builtin.has(d.id))
        .map((d) => ({ value: d.id, label: d.id, description: `${d.name} (extension)` }));
}

async function pickProvider(deps: LoginDeps): Promise<ProviderId | null> {
    const items: SelectItem[] = [
        ...PROVIDER_IDS.map((id) => ({
            value: id as string,
            label: id as string,
            description: providerLabel(id),
        })),
        ...extensionProviderItems(),
        {
            value: "custom",
            label: "custom",
            description:
                "Any compatible endpoint/gateway — bifrost, litellm, proxies (OpenAI/Anthropic/Google compatible)",
        },
    ];
    const pick = await deps.searchOnce(items, "Sign in to provider (type to filter)");
    return pick ? (pick.value as ProviderId) : null;
}

/**
 * Auth-method step of the custom wizard: pick how the endpoint authenticates,
 * then the one prompt that method needs. Null = user backed out (Esc).
 */
async function pickCustomAuth(deps: LoginDeps, name: string, baseURL: string): Promise<CustomProviderAuth | null> {
    const { tui, history, promptOnce, selectOnce } = deps;
    const pick = await selectOnce(
        [
            {
                value: "apikey",
                label: "API key",
                description: "Stored key, sent in the vendor header (x-api-key / Bearer / x-goog-api-key)",
            },
            {
                value: "bearer",
                label: "Bearer token",
                description: "Always sent as Authorization: Bearer — gateways/proxies with their own tokens",
            },
            {
                value: "oauth",
                label: "OAuth / SSO (sign in with browser)",
                description: "Endpoints discovered from the base URL — one login, tokens refresh automatically",
            },
            {
                value: "env",
                label: "Environment variable",
                description: "Key read from an env var at request time — nothing stored on disk",
            },
            {
                value: "helper",
                label: "Command (key helper)",
                description: "Shell command whose output is the key — vault/SSO tokens; re-run every 5m and on 401",
            },
            {
                value: "none",
                label: "None / headers only",
                description: "No credential — auth via custom headers, mTLS, or an open endpoint",
            },
        ],
        `custom:${name} — how does the endpoint authenticate?`,
    );
    if (!pick) return null;
    switch (pick.value) {
        case "apikey": {
            const apiKey = (await promptOnce("apiKey: ")).trim();
            if (!apiKey) return null;
            return { kind: "apikey", apiKey };
        }
        case "bearer": {
            const token = (await promptOnce("token: ")).trim();
            if (!token) return null;
            return { kind: "bearer", token };
        }
        case "env": {
            history.addSystem("Name of the environment variable holding the key (e.g. MY_GATEWAY_KEY).");
            tui.requestRender();
            const varName = (await promptOnce("env var: ")).trim();
            if (!varName) return null;
            if (!process.env[varName]) {
                history.addSystem(warn(`note: $${varName} is not set in this shell right now`));
                tui.requestRender();
            }
            return { kind: "env", var: varName };
        }
        case "helper": {
            history.addSystem(
                "Command whose stdout is the key (runs through your shell, e.g. `op read op://vault/key`).\n" +
                    'Stdout may also be JSON: {"key": "…", "expiresAt": epoch-ms or ISO} — the key persists across restarts until it expires.',
            );
            tui.requestRender();
            const command = (await promptOnce("command: ")).trim();
            if (!command) return null;
            return { kind: "helper", command };
        }
        case "oauth": {
            history.addSystem(
                `Issuer URL for endpoint discovery — Enter to discover from ${baseURL} (.well-known metadata).`,
            );
            tui.requestRender();
            const issuer = (await promptOnce("issuer (optional): ")).trim();
            history.addSystem("Client ID — Enter to auto-register (needs dynamic client registration support).");
            tui.requestRender();
            let clientId = (await promptOnce("clientId (optional): ")).trim();
            let clientSecret = "";
            if (clientId) clientSecret = (await promptOnce("clientSecret (optional): ")).trim();
            history.addSystem(
                'Scopes, space-separated — Enter for none. Tip: "offline_access" is often required for refresh tokens.',
            );
            tui.requestRender();
            const scopes = (await promptOnce("scopes (optional): ")).trim().split(/\s+/).filter(Boolean);

            // Pre-flight discovery here in the wizard, where the fix is a
            // prompt away — customOAuthLogin would otherwise throw mid-login
            // telling the user to set fields this wizard never offered.
            let authorizationEndpoint = "";
            let tokenEndpoint = "";
            let discovered: OAuthEndpoints | null = null;
            history.addSystem(dim(`checking ${issuer || baseURL} for OAuth endpoint metadata…`));
            tui.requestRender();
            try {
                discovered = await discoverOAuthEndpoints(issuer || baseURL);
            } catch {
                history.addSystem(
                    `${warn("no .well-known OAuth metadata found")} at ${issuer || baseURL} — enter the endpoints from the provider's docs.`,
                );
                tui.requestRender();
                authorizationEndpoint = (await promptOnce("authorization endpoint URL: ")).trim();
                if (!authorizationEndpoint) return null;
                tokenEndpoint = (await promptOnce("token endpoint URL: ")).trim();
                if (!tokenEndpoint) return null;
            }
            // Same up-front treatment for client registration: no clientId and
            // no registration endpoint means the login is guaranteed to fail.
            if (!clientId && (authorizationEndpoint || !discovered?.registration_endpoint)) {
                history.addSystem(
                    `${warn("the server supports no dynamic client registration")} — register an OAuth app with the provider and enter its client id.`,
                );
                tui.requestRender();
                clientId = (await promptOnce("clientId: ")).trim();
                if (!clientId) return null;
                clientSecret = (await promptOnce("clientSecret (optional): ")).trim();
            }
            const oauth = {
                ...(issuer ? { issuer } : {}),
                ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
                ...(tokenEndpoint ? { tokenEndpoint } : {}),
                ...(clientId ? { clientId } : {}),
                ...(clientSecret ? { clientSecret } : {}),
                ...(scopes.length ? { scopes } : {}),
            };
            return { kind: "oauth", ...(Object.keys(oauth).length ? { oauth } : {}) };
        }
        default:
            return { kind: "none" };
    }
}

/**
 * Custom provider wizard: name → compat sdk → baseURL → auth method → headers, then
 * model discovery (sdk-appropriate /models call). When the gateway can't list
 * models, falls back to asking the user for model ids — that manual path is
 * always available, discovery is just the happy path.
 */
async function loginCustom(deps: LoginDeps): Promise<StepResult> {
    const { tui, history, promptOnce, selectOnce } = deps;

    history.addSystem("Custom provider — name (lowercase, e.g. bifrost). Esc to go back.");
    tui.requestRender();
    const rawName = await promptOnce("name: ");
    if (!rawName) return "back";
    const name = rawName.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) {
        history.addError("name must be lowercase letters, digits, hyphens");
        tui.requestRender();
        return "back";
    }

    const sdkPick = await selectOnce(
        [
            { value: "anthropic", label: "Anthropic-compatible", description: "Claude API shape (/v1/messages)" },
            {
                value: "openai",
                label: "OpenAI-compatible",
                description: "Chat completions shape (/v1/chat/completions)",
            },
            { value: "google", label: "Google-compatible", description: "Gemini API shape (/v1beta)" },
        ],
        `custom:${name} — which API is the endpoint compatible with?`,
    );
    if (!sdkPick) return "back";
    const sdk = sdkPick.value as CustomProviderConfig["sdk"];

    history.addSystem("Base URL of the endpoint (e.g. http://bifrost.internal/anthropic).");
    tui.requestRender();
    const baseURL = (await promptOnce("baseURL: ")).trim();
    if (!baseURL) return "back";

    const auth = await pickCustomAuth(deps, name, baseURL);
    if (!auth) return "back";

    // OAuth signs in now — model discovery below already needs the token, and
    // the stored session means this is the last time the browser opens.
    if (auth.kind === "oauth") {
        try {
            await loginCustomProviderOAuth(
                { name, baseURL, auth },
                {
                    onAuth: ({ url, instructions }) => presentAuth(deps, `custom:${name}`, url, instructions),
                    onPrompt: async ({ message }) => {
                        history.addSystem(message);
                        tui.requestRender();
                        return promptOnce("");
                    },
                    onProgress: (msg) => {
                        history.addSystem(msg);
                        tui.requestRender();
                    },
                },
            );
            history.addSystem(ok(`signed in to ${name}.`));
            tui.requestRender();
        } catch (err) {
            history.addError(`OAuth sign-in failed: ${(err as Error).message}`);
            tui.requestRender();
            return "back";
        }
    }

    history.addSystem('Extra headers, optional. Format: "X-Header: value; Other-Header: value". Enter to skip.');
    tui.requestRender();
    const headersRaw = (await promptOnce("headers: ")).trim();
    const headers: Record<string, string> = {};
    for (const pair of headersRaw.split(";")) {
        const idx = pair.indexOf(":");
        if (idx > 0) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }

    const cfg: CustomProviderConfig = {
        name,
        sdk,
        baseURL,
        apiKey: auth.kind === "apikey" ? auth.apiKey : "",
        auth,
        ...(Object.keys(headers).length ? { headers } : {}),
    };

    history.addSystem("Discovering models from the endpoint…");
    tui.requestRender();
    const discovered = await fetchCustomProviderModels(cfg);

    if (discovered?.length) {
        cfg.models = discovered.map((m) => ({
            id: m.id,
            ...(m.name ? { name: m.name } : {}),
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            ...(m.maxOutput ? { maxOutput: m.maxOutput } : {}),
        }));
        history.addSystem(ok(`found ${discovered.length} models:`));
        for (const m of discovered.slice(0, 12)) history.addSystem(dim(`  • ${m.id}`));
        if (discovered.length > 12) history.addSystem(dim(`  … +${discovered.length - 12} more`));
    } else {
        history.addSystem(warn("Endpoint doesn't expose a model list — enter model ids manually (comma-separated)."));
        tui.requestRender();
        const ids = (await promptOnce("model ids: "))
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
        if (ids.length === 0) {
            history.addError("no models given — custom provider not saved");
            tui.requestRender();
            return "back";
        }
        cfg.models = ids.map((id) => ({ id }));
    }

    saveCustomProvider(cfg);
    setActiveProvider(`custom:${name}`);
    bustCatalogCache();
    history.addSystem(ok(`custom provider "${name}" saved (${cfg.models!.length} models) and set active.`));
    tui.requestRender();
    return "done";
}

async function loginXai(deps: LoginDeps): Promise<StepResult> {
    const { tui, history, promptOnce } = deps;
    const mode = await deps.selectOnce(
        [
            { value: "oauth", label: "Sign in with xAI (SuperGrok subscription)", description: "OAuth, opens browser" },
            { value: "apikey", label: "Use API key", description: "Paste your XAI_API_KEY" },
        ],
        "xAI — authentication method (Esc to go back)",
    );
    if (!mode) return "back";
    if (mode.value === "oauth") {
        history.addSystem("xAI login: launching OAuth in your browser…");
        tui.requestRender();
        try {
            await loginXaiOAuth(({ url, instructions }) => presentAuth(deps, "xAI", url, instructions));
            setActiveProvider("xai");
            history.addSystem(ok("xAI subscription connected."));
        } catch (err) {
            history.addError(`xAI login failed: ${(err as Error).message}`);
        }
        tui.requestRender();
        return "done";
    }
    return apiKeyLogin(deps, "xai", promptOnce);
}

async function loginCopilot(deps: LoginDeps): Promise<StepResult> {
    const { tui, history, promptOnce } = deps;
    history.addSystem("GitHub Copilot: starting device flow…");
    tui.requestRender();
    try {
        await loginOAuth("github-copilot", {
            onAuth: ({ url, instructions }) => presentAuth(deps, "GitHub Copilot", url, instructions),
            onPrompt: async ({ message }) => {
                history.addSystem(message);
                tui.requestRender();
                return promptOnce("");
            },
            onProgress: (msg) => {
                history.addSystem(msg);
                tui.requestRender();
            },
        });
        setActiveProvider("github-copilot");
        bustCatalogCache();
        history.addSystem(ok("GitHub Copilot connected."));
    } catch (err) {
        history.addError(`Copilot login failed: ${(err as Error).message}`);
    }
    tui.requestRender();
    return "done";
}

async function loginOpenAI(deps: LoginDeps): Promise<StepResult> {
    const { promptOnce } = deps;
    const mode = await deps.selectOnce(
        [
            {
                value: "oauth",
                label: "Continue with ChatGPT",
                description: "Sign in in the browser — usage comes from your ChatGPT plan",
            },
            { value: "apikey", label: "Use API key", description: "Paste your OPENAI_API_KEY (pay-as-you-go)" },
        ],
        "OpenAI — authentication method (Esc to go back)",
    );
    if (!mode) return "back";
    if (mode.value === "oauth") return loginChatgpt(deps);
    return apiKeyLogin(deps, "openai", promptOnce);
}

async function loginChatgpt(deps: LoginDeps): Promise<StepResult> {
    const { tui, history, promptOnce } = deps;
    // A saved registration is reused by default so the same ChatGPT client (and
    // its usage limits) carries over; a different account registers anew.
    let freshRegistration = false;
    const saved = listChatgptRegistrations()[0];
    if (saved) {
        const pick = await deps.selectOnce(
            [
                {
                    value: "saved",
                    label: `Continue as ${saved.email ?? "your saved ChatGPT account"}`,
                    description: "Reuse this account's existing connection",
                },
                {
                    value: "new",
                    label: "Use a different ChatGPT account",
                    description: "Connect another account or workspace",
                },
            ],
            "ChatGPT — account (Esc to go back)",
        );
        if (!pick) return "back";
        freshRegistration = pick.value === "new";
    }
    history.addSystem("ChatGPT: opening browser for sign-in…");
    tui.requestRender();
    try {
        await loginOAuth("openai-chatgpt", {
            freshRegistration,
            onAuth: ({ url, instructions }) => presentAuth(deps, "ChatGPT", url, instructions),
            onPrompt: async ({ message }) => {
                history.addSystem(dim(message));
                tui.requestRender();
                return promptOnce("");
            },
            onProgress: (msg) => {
                history.addSystem(msg);
                tui.requestRender();
            },
        });
        setActiveProvider("openai-chatgpt");
        bustCatalogCache();
        history.addSystem(ok("Connected — using your ChatGPT plan."));
        history.addSystem(dim(`Set loop's usage limit or disconnect it any time: ${CHATGPT_MANAGE_USAGE_URL}`));
    } catch (err) {
        history.addError(`ChatGPT sign-in failed: ${(err as Error).message}`);
    }
    tui.requestRender();
    return "done";
}

async function loginOllama(deps: LoginDeps): Promise<StepResult> {
    const { tui, history } = deps;
    history.addSystem("Ollama: checking local daemon…");
    tui.requestRender();
    const models = await listOllamaModels();
    if (models === null) {
        history.addError(
            `Ollama not reachable at ${ollamaBaseURL()}. Start it (\`ollama serve\`) or set ${envName("OLLAMA_BASE_URL")}.`,
        );
        tui.requestRender();
        return "done";
    }
    if (models.length === 0) {
        history.addSystem(
            warn("Ollama is running but no models are installed. Pull one, e.g. `ollama pull llama3.2`, then retry."),
        );
        tui.requestRender();
        return "done";
    }
    // Local provider has no key; store a placeholder so it counts as authorized.
    loginApiKey("ollama", "local");
    setActiveProvider("ollama");
    bustCatalogCache();
    history.addSystem(ok(`Ollama connected — ${models.length} model${models.length === 1 ? "" : "s"} installed.`));
    tui.requestRender();
    return "done";
}

async function loginBedrock(deps: LoginDeps): Promise<StepResult> {
    const { tui, history } = deps;
    history.addSystem("Amazon Bedrock: resolving AWS credentials…");
    tui.requestRender();
    const creds = await resolveAwsCredentials();
    if (!creds) {
        history.addError(
            "No AWS credentials found. Sign in with the AWS CLI (`aws configure` or `aws sso login`) or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, then retry.",
        );
        tui.requestRender();
        return "done";
    }
    const region = bedrockRegion();
    history.addSystem(`AWS credentials found — listing Bedrock models in ${region}…`);
    tui.requestRender();
    const models = await refreshBedrockCatalog();
    if (models === null) {
        history.addError(
            `Couldn't list Bedrock models in ${region}. Check the account has Bedrock access in this region (set AWS_REGION or ${envName("BEDROCK_REGION")} to switch).`,
        );
        tui.requestRender();
        return "done";
    }
    if (models.length === 0) {
        history.addSystem(
            warn(
                `Bedrock answered but no invokable models in ${region}. Request model access in the AWS console (Bedrock → Model access), then retry.`,
            ),
        );
        tui.requestRender();
        return "done";
    }
    // Credentials stay in the AWS chain — store a placeholder so bedrock
    // counts as authorized, same as ollama.
    loginApiKey("bedrock", "aws");
    setActiveProvider("bedrock");
    bustCatalogCache();
    history.addSystem(ok(`Bedrock connected — ${models.length} model${models.length === 1 ? "" : "s"} in ${region}.`));
    tui.requestRender();
    return "done";
}

async function apiKeyLogin(
    deps: LoginDeps,
    p: ProviderId,
    promptOnce: (label?: string) => Promise<string>,
): Promise<StepResult> {
    const { tui, history } = deps;
    history.addSystem(`${p}: paste API key, then press Enter. Esc to go back.`);
    tui.requestRender();
    const key = await promptOnce(`${p.toUpperCase().replace(/-/g, "_")}_API_KEY: `);
    if (!key) return "back";
    loginApiKey(p, key);
    setActiveProvider(p);
    bustCatalogCache();
    history.addSystem(ok(`${p} key saved.`));
    tui.requestRender();
    return "done";
}

async function loginForProvider(deps: LoginDeps, p: ProviderId): Promise<StepResult> {
    switch (p) {
        case "custom":
            return loginCustom(deps);
        case "xai":
            return loginXai(deps);
        case "openai":
            return loginOpenAI(deps);
        case "github-copilot":
            return loginCopilot(deps);
        case "ollama":
            return loginOllama(deps);
        case "bedrock":
            return loginBedrock(deps);
        default:
            return apiKeyLogin(deps, p, deps.promptOnce);
    }
}

export async function startLogin(deps: LoginDeps, target?: string): Promise<void> {
    const { tui, history } = deps;

    // Validate explicit `target` once; if invalid, surface and exit. Extension
    // providers (apikey) are valid targets too.
    if (target) {
        const isExtProvider = getExtensionHost()
            .getProviderDescriptors()
            .some((d) => d.id === target && (d.auth?.mode ?? "apikey") === "apikey");
        if (!(PROVIDER_IDS as readonly string[]).includes(target) && target !== "custom" && !isExtProvider) {
            history.addSystem(`unknown provider: ${target}. options: ${[...PROVIDER_IDS, "custom"].join(", ")}`);
            tui.requestRender();
            return;
        }
        const r = await loginForProvider(deps, target as ProviderId);
        if (r !== "back") return;
        // fall through to interactive picker if user pressed Esc
    }

    // Loop: provider picker → provider-specific flow → may return "back" to here.
    while (true) {
        const p = await pickProvider(deps);
        if (!p) return; // Esc at outermost picker exits the login wizard
        const r = await loginForProvider(deps, p);
        if (r !== "back") return;
        // r === "back": loop and re-open provider picker
    }
}

export async function startLogout(deps: LoginDeps, target?: string): Promise<void> {
    const { tui, history, searchOnce } = deps;
    let pick = target;
    if (!pick) {
        const authed: string[] = [
            ...listAuthorizedProviders(),
            ...listCustomProviders().map((c) => `custom:${c.name}`),
        ];
        if (authed.length === 0) {
            history.addSystem("no providers to sign out from");
            tui.requestRender();
            return;
        }
        const items: SelectItem[] = [
            ...authed.map((id) => ({
                value: id,
                label: id,
                description: id === getActiveProvider() ? "(active)" : "",
            })),
            { value: "__all__", label: err("all providers"), description: "Sign out from every provider" },
        ];
        const sel = await searchOnce(items, "Sign out of provider (type to filter)");
        if (!sel) return;
        pick = sel.value;
    }
    if (pick === "__all__") {
        logout();
        for (const c of listCustomProviders()) deleteCustomProvider(c.name);
        history.addSystem("signed out of all providers");
    } else if (pick.startsWith("custom:")) {
        deleteCustomProvider(pick.slice("custom:".length));
        bustCatalogCache();
        history.addSystem(`removed custom provider ${pick}`);
    } else {
        logout(pick as ProviderId);
        history.addSystem(`signed out of ${pick}`);
    }
    tui.requestRender();
}
