/**
 * Signing in to a provider from a remote client.
 *
 * `auth.login` already covered the easy half — paste an API key, store it. The
 * other half is every login the TUI can do and a socket could not: xAI's
 * SuperGrok OAuth, ChatGPT/Codex, GitHub Copilot's device flow, and the
 * zero-key providers whose "login" is really a probe (Bedrock's AWS chain,
 * Ollama's local daemon).
 *
 * Those flows are *conversations*: they hand back a URL to open, sometimes ask
 * a question mid-flight (Copilot wants the GitHub Enterprise domain first),
 * and finish minutes later. A JSON-RPC request/response cannot hold one open —
 * the TUI gets to await a prompt because it owns the terminal, and a socket
 * client does not.
 *
 * So a flow becomes a small server-side object with an append-only event log
 * the client drains by cursor:
 *
 *     auth.flow.start   → { flowId }
 *     auth.flow.poll    → { events, cursor, status }   (repeat)
 *     auth.flow.answer  → resolves a `prompt` event
 *     auth.flow.cancel  → aborts it
 *
 * Polling rather than pushing is deliberate: loop's notification channel is
 * per-session (`session.event`), and a login belongs to no session.
 */
import { randomBytes } from "node:crypto";
import {
    getAuthMode,
    hasCustomOAuthSession,
    listAuthorizedProviders,
    listCustomProviders,
    loginCustomProviderOAuth,
    loginOAuth,
    loginXaiOAuth,
    loginApiKey,
    normalizeCustomAuth,
    setActiveProvider,
} from "../auth";
import { parseCustomProviderDraft, type CustomProviderDraft } from "./custom-providers";
import { bustCatalogCache, refreshBedrockCatalog } from "../catalog";
import { envName } from "../brand";
import { getExtensionHost } from "../extensions";
import {
    bedrockRegion,
    listOllamaModels,
    NATIVE_AGENT_PROVIDERS,
    ollamaBaseURL,
    peekNativeAgent,
    probeClaudeCode,
    probeCursor,
    resolveAwsCredentials,
} from "../providers";
import { BUILTIN_PROVIDER_IDS, type CustomProviderConfig, type ProviderId } from "../types";

/** How a provider can be signed in to, in the order a picker should offer them. */
export type AuthMethod = "oauth" | "apikey" | "detect";

/**
 * Providers whose OAuth is actually wired into `getModel`. Registering an
 * OAuth implementation is not enough — anthropic has one, but the anthropic
 * branch of `getModel` reads `getApiKey`, so OAuth creds stored under it would
 * never be used. Offering it here would produce a login that appears to work
 * and then fails on the first turn.
 */
const OAUTH_PROVIDERS: Record<string, ProviderId> = {
    // The picker entry is "openai"; the credentials live under the id the
    // model router looks up, exactly as the TUI's /login does.
    openai: "openai-chatgpt",
    "openai-chatgpt": "openai-chatgpt",
    "github-copilot": "github-copilot",
    xai: "xai",
};

/** Providers with no credential to enter: the "login" is a probe. */
const DETECT_PROVIDERS = new Set<ProviderId>(["bedrock", "ollama", ...NATIVE_AGENT_PROVIDERS]);

/** The saved config behind a `custom:<name>` id, or undefined. */
function customConfigFor(provider: string): CustomProviderConfig | undefined {
    if (!provider.startsWith("custom:")) return undefined;
    const name = provider.slice("custom:".length);
    return listCustomProviders().find((config) => config.name === name);
}

/** Which methods a provider offers, most preferred first. */
export function authMethodsFor(provider: string): AuthMethod[] {
    // A gateway's methods are whatever its own config declares, not a guess.
    // Only the oauth kind has a login to run at all — every other kind is
    // established by writing the config, which is `auth.custom.save`, not a
    // credential the user re-enters against an existing id. Offering "apikey"
    // here produced a form whose Save wrote a key into the built-in provider
    // store, where nothing routing a custom gateway ever reads it.
    if (provider.startsWith("custom:")) {
        const custom = customConfigFor(provider);
        return custom && normalizeCustomAuth(custom).kind === "oauth" ? ["oauth"] : [];
    }
    if (DETECT_PROVIDERS.has(provider as ProviderId)) return ["detect"];
    const methods: AuthMethod[] = [];
    if (provider in OAUTH_PROVIDERS) methods.push("oauth");
    // Copilot has no API keys at all; every other OAuth provider also accepts one.
    if (provider !== "github-copilot") methods.push("apikey");
    return methods;
}

/** The env var `getApiKey` falls back to, so the UI can say where a key came from. */
export function apiKeyEnvVar(provider: string): string | undefined {
    // A gateway reads whatever var its own `auth: { kind: "env" }` names, and
    // nothing at all otherwise — never `CUSTOM:FOO_API_KEY`.
    if (provider.startsWith("custom:")) {
        const custom = customConfigFor(provider);
        const auth = custom ? normalizeCustomAuth(custom) : undefined;
        return auth?.kind === "env" ? auth.var : undefined;
    }
    if (DETECT_PROVIDERS.has(provider as ProviderId)) return undefined;
    if (provider === "vercel") return "AI_GATEWAY_API_KEY";
    if (provider === "github-copilot") return undefined;
    return `${provider.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

export interface ProviderDescriptor {
    readonly id: string;
    readonly kind: "builtin" | "custom" | "extension";
    /** Has usable stored credentials right now. */
    readonly authorized: boolean;
    /** How the stored credential was obtained, or "missing". */
    readonly mode: "apikey" | "oauth" | "missing";
    readonly methods: readonly AuthMethod[];
    readonly envVar?: string;
    /** Custom gateways only — enough to describe the endpoint in the UI. */
    readonly baseURL?: string;
    readonly sdk?: string;
}

/**
 * Every provider a client may offer, authorized or not.
 *
 * Deliberately wider than `auth.status`, which answers "what can run now".
 * A settings screen has to list the providers you could sign in to, or there
 * would be nothing to click.
 */
export function listProviderDescriptors(): ProviderDescriptor[] {
    const authorized = new Set<string>(listAuthorizedProviders());
    const builtins = BUILTIN_PROVIDER_IDS.map((id): ProviderDescriptor => {
        const envVar = apiKeyEnvVar(id);
        // A key in the environment authorizes the provider just as a stored one
        // does (see getApiKey), and the TUI treats it that way — so a provider
        // configured by env must not render as "not connected".
        const fromEnv = envVar !== undefined && Boolean(process.env[envVar]);
        return {
            id,
            kind: "builtin",
            authorized: authorized.has(id) || fromEnv,
            mode: getAuthMode(id),
            methods: authMethodsFor(id),
            ...(envVar ? { envVar } : {}),
        };
    });
    // ChatGPT credentials are stored under their own id but presented on the
    // "openai" row, so the separate entry would be a duplicate the user cannot
    // act on. Its authorization is folded into openai instead.
    const chatgptAuthorized = authorized.has("openai-chatgpt");
    const merged = builtins.map((descriptor) =>
        descriptor.id === "openai" && chatgptAuthorized
            ? { ...descriptor, authorized: true, mode: getAuthMode("openai-chatgpt") }
            : descriptor,
    );

    const customs = listCustomProviders().map((config): ProviderDescriptor => {
        const auth = normalizeCustomAuth(config);
        const envVar = auth.kind === "env" ? auth.var : undefined;
        return {
            id: `custom:${config.name}`,
            kind: "custom",
            // A gateway is configured, therefore usable — except an oauth one
            // that has never been signed in to (or whose session was cleared),
            // which has no token to send and must not read as connected.
            authorized: auth.kind !== "oauth" || hasCustomOAuthSession(config.name),
            mode: auth.kind === "oauth" ? "oauth" : auth.kind === "none" ? "missing" : "apikey",
            methods: authMethodsFor(`custom:${config.name}`),
            ...(envVar ? { envVar } : {}),
            baseURL: config.baseURL,
            sdk: config.sdk,
        };
    });

    const builtinIds = new Set<string>(BUILTIN_PROVIDER_IDS);
    const extensions = getExtensionHost()
        .getProviderDescriptors()
        .filter((plugin) => !builtinIds.has(plugin.id))
        .map(
            (plugin): ProviderDescriptor => ({
                id: plugin.id,
                kind: "extension",
                authorized: authorized.has(plugin.id),
                mode: getAuthMode(plugin.id),
                methods: (plugin.auth?.mode ?? "apikey") === "apikey" ? ["apikey"] : [],
                ...(plugin.auth?.envVar ? { envVar: plugin.auth.envVar } : {}),
            }),
        );

    // Native agents never had a login, so they are not BUILTIN_PROVIDER_IDS;
    // they are listed so a settings screen can show (and re-check) whether
    // the CLI is installed and signed in on this machine.
    const natives = NATIVE_AGENT_PROVIDERS.map(
        (id): ProviderDescriptor => ({
            id,
            kind: "builtin",
            authorized: peekNativeAgent(id).loggedIn,
            mode: "missing",
            methods: ["detect"],
        }),
    );

    return [...merged, ...natives, ...customs, ...extensions];
}

// ─── Interactive flows ────────────────────────────────────────────────────────

export type AuthFlowEvent =
    | { type: "auth"; url: string; instructions?: string }
    | { type: "progress"; message: string }
    | { type: "prompt"; promptId: string; message: string; placeholder?: string; allowEmpty: boolean }
    | { type: "done"; message: string }
    | { type: "error"; message: string };

export type AuthFlowStatus = "running" | "done" | "error" | "cancelled";

interface Flow {
    readonly id: string;
    readonly provider: string;
    readonly events: AuthFlowEvent[];
    readonly abort: AbortController;
    status: AuthFlowStatus;
    /** The question currently awaiting `auth.flow.answer`, if any. */
    pending?: { promptId: string; resolve: (value: string) => void };
    finishedAt?: number;
}

const flows = new Map<string, Flow>();
/** A finished flow is kept briefly so a slow poll still sees how it ended. */
const FLOW_RETENTION_MS = 60_000;

function sweep(): void {
    const cutoff = Date.now() - FLOW_RETENTION_MS;
    for (const [id, flow] of flows) {
        if (flow.finishedAt !== undefined && flow.finishedAt < cutoff) flows.delete(id);
    }
}

function emit(flow: Flow, event: AuthFlowEvent): void {
    flow.events.push(event);
}

function finish(flow: Flow, status: AuthFlowStatus, event: AuthFlowEvent): void {
    if (flow.status !== "running") return;
    flow.status = status;
    flow.finishedAt = Date.now();
    emit(flow, event);
    // A prompt nobody will answer must not leave the login half-run.
    flow.pending?.resolve("");
    delete flow.pending;
}

/** The callbacks a core OAuth implementation expects, backed by the event log. */
function callbacksFor(flow: Flow) {
    let promptSeq = 0;
    return {
        onAuth: ({ url, instructions }: { url: string; instructions?: string }) =>
            emit(flow, { type: "auth", url, ...(instructions ? { instructions } : {}) }),
        onProgress: (message: string) => emit(flow, { type: "progress", message }),
        onPrompt: ({
            message,
            placeholder,
            allowEmpty,
        }: {
            message: string;
            placeholder?: string;
            allowEmpty?: boolean;
        }) =>
            new Promise<string>((resolve) => {
                const promptId = `p${++promptSeq}`;
                flow.pending = { promptId, resolve };
                emit(flow, {
                    type: "prompt",
                    promptId,
                    message,
                    ...(placeholder ? { placeholder } : {}),
                    allowEmpty: allowEmpty ?? false,
                });
            }),
        signal: flow.abort.signal,
    };
}

/** Bedrock's login: resolve AWS credentials, then prove the region answers. */
async function runBedrockDetect(flow: Flow): Promise<void> {
    emit(flow, { type: "progress", message: "Resolving AWS credentials…" });
    const creds = await resolveAwsCredentials();
    if (!creds) {
        throw new Error(
            "No AWS credentials found. Sign in with the AWS CLI (`aws configure` or `aws sso login`) or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.",
        );
    }
    const region = bedrockRegion();
    emit(flow, { type: "progress", message: `Listing Bedrock models in ${region}…` });
    const models = await refreshBedrockCatalog();
    if (models === null) {
        throw new Error(
            `Could not list Bedrock models in ${region}. Check the account has Bedrock access there (AWS_REGION or ${envName("BEDROCK_REGION")} switches region).`,
        );
    }
    if (models.length === 0) {
        throw new Error(
            `Bedrock answered but no invokable models in ${region}. Request model access in the AWS console (Bedrock → Model access).`,
        );
    }
    // Credentials stay in the AWS chain; the placeholder is what marks the
    // provider authorized, exactly as the TUI's /login bedrock does.
    loginApiKey("bedrock", "aws");
    setActiveProvider("bedrock");
    finish(flow, "done", {
        type: "done",
        message: `Bedrock connected — ${models.length} model${models.length === 1 ? "" : "s"} in ${region}.`,
    });
}

/** Ollama's login: the daemon has to be up and hold at least one model. */
async function runOllamaDetect(flow: Flow): Promise<void> {
    emit(flow, { type: "progress", message: "Checking the local Ollama daemon…" });
    const models = await listOllamaModels();
    if (models === null) {
        throw new Error(
            `Ollama is not reachable at ${ollamaBaseURL()}. Start it (\`ollama serve\`) or set ${envName("OLLAMA_BASE_URL")}.`,
        );
    }
    if (models.length === 0) {
        throw new Error("Ollama is running but no models are installed. Pull one, e.g. `ollama pull llama3.2`.");
    }
    loginApiKey("ollama", "local");
    setActiveProvider("ollama");
    finish(flow, "done", {
        type: "done",
        message: `Ollama connected — ${models.length} model${models.length === 1 ? "" : "s"} installed.`,
    });
}

/**
 * Claude Code / Cursor: nothing to sign in to here — the CLI's own login is
 * the credential. Re-probe the machine and report what was found, with the
 * exact command to run when something is missing.
 */
async function runNativeAgentDetect(flow: Flow): Promise<void> {
    const claude = flow.provider === "claude-code";
    const label = claude ? "Claude Code" : "Cursor";
    emit(flow, { type: "progress", message: `Looking for ${label} on this machine…` });
    if (claude) {
        const probe = await probeClaudeCode({ refresh: true });
        if (!probe) throw new Error("Claude Code is not installed. Install it (https://claude.com/claude-code), then run `claude auth login`.");
        if (!probe.loggedIn) throw new Error("Claude Code is installed but not signed in. Run `claude auth login`, then check again.");
        bustCatalogCache();
        finish(flow, "done", {
            type: "done",
            message: `Claude Code connected${probe.email ? ` as ${probe.email}` : ""} — ${probe.models.length} models.`,
        });
        return;
    }
    const probe = await probeCursor({ refresh: true });
    if (!probe) throw new Error("Cursor's CLI is not installed. Install it (https://cursor.com/cli), then run `cursor-agent login`.");
    if (!probe.loggedIn) throw new Error("cursor-agent is installed but not signed in. Run `cursor-agent login` (or set CURSOR_API_KEY), then check again.");
    bustCatalogCache();
    finish(flow, "done", {
        type: "done",
        message: `Cursor connected${probe.account ? ` as ${probe.account}` : ""} — ${probe.families.length} models.`,
    });
}

/**
 * A custom gateway's browser sign-in.
 *
 * Runs against a DRAFT when the client is still in the add-a-provider wizard
 * and against the saved config when it is a re-login, which is what lets the
 * app do what the terminal does: sign in first, then discover models with the
 * token the sign-in just produced. The session is persisted by
 * `loginCustomProviderOAuth` under the gateway's name, so it is already in
 * place by the time `auth.custom.save` writes the config around it.
 */
async function runCustomOAuth(flow: Flow, draft: CustomProviderDraft | CustomProviderConfig): Promise<void> {
    emit(flow, { type: "progress", message: `Signing in to ${draft.name}…` });
    await loginCustomProviderOAuth({ name: draft.name, baseURL: draft.baseURL, auth: draft.auth }, callbacksFor(flow));
    bustCatalogCache();
    finish(flow, "done", { type: "done", message: `Signed in to ${draft.name}.` });
}

async function runFlow(flow: Flow, method: AuthMethod, custom?: CustomProviderDraft): Promise<void> {
    if (custom || flow.provider.startsWith("custom:")) {
        const config = custom ?? customConfigFor(flow.provider);
        if (!config) throw new Error(`no custom provider named ${flow.provider}`);
        return runCustomOAuth(flow, config);
    }
    if (method === "detect") {
        if (flow.provider === "bedrock") return runBedrockDetect(flow);
        if (flow.provider === "ollama") return runOllamaDetect(flow);
        if (flow.provider === "claude-code" || flow.provider === "cursor-agent") return runNativeAgentDetect(flow);
        throw new Error(`${flow.provider} has nothing to detect`);
    }
    const target = OAUTH_PROVIDERS[flow.provider];
    if (!target) throw new Error(`${flow.provider} does not support OAuth`);
    if (target === "xai") {
        await loginXaiOAuth((info) => emit(flow, { type: "auth", ...info }));
        setActiveProvider("xai");
    } else {
        await loginOAuth(target, callbacksFor(flow));
        setActiveProvider(target);
    }
    bustCatalogCache();
    finish(flow, "done", { type: "done", message: `Signed in to ${flow.provider}.` });
}

export interface StartAuthFlowInput {
    readonly provider: string;
    readonly method?: AuthMethod;
    /**
     * An unsaved custom gateway to sign in to, as `auth.custom.save` would take
     * it. Present only during the add-a-provider wizard: the endpoints are
     * discovered from the draft's own baseURL, and there is no config on disk
     * to read them from yet. Omit it to re-login a gateway already saved.
     */
    readonly custom?: unknown;
}

/**
 * Begin a login. Returns immediately with the flow's id — the work continues
 * in the background and is observed through `pollAuthFlow`.
 */
export function startAuthFlow(input: StartAuthFlowInput): { flowId: string; provider: string; method: AuthMethod } {
    sweep();
    // A draft names its own provider, so the wizard need not also send an id
    // it has not created yet.
    const draft = input.custom === undefined ? undefined : parseCustomProviderDraft(input.custom);
    if (draft && draft.auth.kind !== "oauth") {
        throw new Error("only an oauth custom provider has an interactive login");
    }
    const provider = draft ? `custom:${draft.name}` : input.provider.trim();
    if (!provider) throw new Error("provider required");
    if (draft) {
        const flow = beginFlow(provider);
        if ("existing" in flow) return { flowId: flow.existing, provider, method: "oauth" };
        void runFlow(flow.flow, "oauth", draft).catch((err: unknown) => {
            finish(flow.flow, "error", { type: "error", message: err instanceof Error ? err.message : String(err) });
        });
        return { flowId: flow.flow.id, provider, method: "oauth" };
    }
    const available = authMethodsFor(provider);
    const method = input.method ?? available.find((candidate) => candidate !== "apikey") ?? available[0];
    if (!method) throw new Error(`${provider} has no interactive login`);
    if (method === "apikey") throw new Error("API-key logins go through auth.login, not auth.flow.start");
    if (!available.includes(method)) throw new Error(`${provider} does not support ${method} login`);

    const started = beginFlow(provider);
    if ("existing" in started) return { flowId: started.existing, provider, method };
    void runFlow(started.flow, method).catch((err: unknown) => {
        finish(started.flow, "error", { type: "error", message: err instanceof Error ? err.message : String(err) });
    });
    return { flowId: started.flow.id, provider, method };
}

/**
 * Register a flow for a provider, or hand back the one already running.
 *
 * A second flow for the same provider would race the first over the same
 * callback port and the same store entry, so joining the running one is the
 * only safe answer to a double-click.
 */
function beginFlow(provider: string): { flow: Flow } | { existing: string } {
    for (const running of flows.values()) {
        if (running.provider === provider && running.status === "running") return { existing: running.id };
    }
    const flow: Flow = {
        id: randomBytes(8).toString("hex"),
        provider,
        events: [],
        abort: new AbortController(),
        status: "running",
    };
    flows.set(flow.id, flow);
    return { flow };
}

export interface PollAuthFlowResult {
    readonly status: AuthFlowStatus;
    readonly cursor: number;
    readonly events: readonly AuthFlowEvent[];
    /** The prompt still awaiting an answer, so a reconnecting client can see it. */
    readonly pendingPromptId?: string;
}

export function pollAuthFlow(flowId: string, cursor = 0): PollAuthFlowResult {
    const flow = flows.get(flowId);
    if (!flow) throw new Error(`unknown login flow: ${flowId}`);
    const from = Math.max(0, Math.min(cursor, flow.events.length));
    return {
        status: flow.status,
        cursor: flow.events.length,
        events: flow.events.slice(from),
        ...(flow.pending ? { pendingPromptId: flow.pending.promptId } : {}),
    };
}

export function answerAuthFlow(flowId: string, promptId: string, value: string): { ok: true } {
    const flow = flows.get(flowId);
    if (!flow) throw new Error(`unknown login flow: ${flowId}`);
    const pending = flow.pending;
    if (!pending) throw new Error("this login is not waiting for an answer");
    if (pending.promptId !== promptId) throw new Error("stale answer — the login has moved on");
    delete flow.pending;
    pending.resolve(value);
    return { ok: true };
}

export function cancelAuthFlow(flowId: string): { ok: true } {
    const flow = flows.get(flowId);
    if (!flow) return { ok: true };
    flow.abort.abort();
    finish(flow, "cancelled", { type: "error", message: "Login cancelled." });
    return { ok: true };
}

/** Test seam: drop every flow so state cannot leak between cases. */
export function resetAuthFlows(): void {
    for (const flow of flows.values()) flow.abort.abort();
    flows.clear();
}
