import { brandEnv, PRODUCT_NAME } from "../brand";
import type { LanguageModel } from "ai";
import {
    getAccessToken,
    getApiKey,
    getCustomProvider,
    isCustomProvider,
    parseCustomProviderId,
    resolveAuthToken,
    resolveOAuthCreds,
} from "../auth";
import { COPILOT_HEADERS, getCopilotBaseUrl } from "../auth/oauth/github-copilot";
import {
    createCustomAuthFetch,
    customAuthHeaders,
    normalizeCustomAuth,
    type CustomAuthConfig,
} from "../auth/custom-auth";
import { accountIdFromIdToken, CODEX_BASE_URL, OPENAI_CHATGPT_HEADERS } from "../auth/oauth/openai-chatgpt";
import type { CustomProviderConfig, ProviderId } from "../types";
import { getExtensionHost, type ProviderPlugin } from "../extensions";
import { anthropicShapeFetch } from "./anthropic-shape";
import { bedrockRegion } from "./bedrock";

export {
    bedrockRegion,
    bedrockShortModelId,
    hasAwsCredentialSources,
    listBedrockModels,
    resolveAwsCredentials,
    type BedrockModelSummary,
} from "./bedrock";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/**
 * Carry `fetch.preconnect` across a fetch wrapper — where the runtime has one.
 *
 * **`preconnect` is a Bun extension; Node's fetch has no such property.** The
 * AI SDK only reads it opportunistically, so the right behaviour on Node is
 * simply not to define it — but the unguarded `fetch.preconnect.bind(fetch)`
 * threw `Cannot read properties of undefined (reading 'bind')` and took down
 * the very first turn core ran inside Electron's main process.
 */
function withPreconnect(fn: (input: FetchInput, init?: FetchInit) => Promise<Response>): typeof fetch {
    const wrapped = fn as typeof fetch & { preconnect?: typeof fetch.preconnect };
    const preconnect = (fetch as typeof fetch & { preconnect?: typeof fetch.preconnect }).preconnect;
    if (preconnect) wrapped.preconnect = preconnect.bind(fetch);
    return wrapped as typeof fetch;
}

function copilotAuthFetch(): typeof fetch {
    return withPreconnect(async (input, init) => {
        const token = await resolveAuthToken("github-copilot");
        if (!token) throw new Error("No GitHub Copilot credentials. Run: /login github-copilot");
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        for (const [k, v] of Object.entries(COPILOT_HEADERS)) headers.set(k, v);
        headers.set("X-Initiator", "user");
        headers.set("Openai-Intent", "conversation-edits");
        return fetch(input, { ...(init as RequestInit), headers });
    });
}

/**
 * Auth + request shaping for the ChatGPT/Codex backend. Beyond the bearer
 * token it needs the `chatgpt-account-id` header, and the backend only accepts
 * stateless Responses calls — so we force `store:false` and ask for encrypted
 * reasoning so multi-step turns keep their reasoning context. The system prompt
 * (loop's instructions) is left intact; set LOOP_CODEX_INSTRUCTIONS to override it
 * if the backend rejects a request for non-Codex instructions.
 */
/** Responses API message content is a string or an array of text parts. */
function messageContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
            .join("");
    }
    return "";
}

function openaiChatgptAuthFetch(): typeof fetch {
    const overrideInstructions = brandEnv("CODEX_INSTRUCTIONS");
    return withPreconnect(async (input, init) => {
        const creds = await resolveOAuthCreds("openai-chatgpt");
        if (!creds) throw new Error("No ChatGPT credentials. Run: /login openai-chatgpt");
        const accountId = (creds.accountId as string | undefined) ?? accountIdFromIdToken(creds.idToken as string);

        const headers = new Headers(init?.headers);
        headers.delete("x-api-key");
        headers.set("authorization", `Bearer ${creds.access}`);
        if (accountId) headers.set("chatgpt-account-id", accountId);
        for (const [k, v] of Object.entries(OPENAI_CHATGPT_HEADERS)) headers.set(k, v);

        let body = init?.body;
        if (typeof body === "string") {
            try {
                const json = JSON.parse(body) as Record<string, unknown>;
                json.store = false; // backend only accepts stateless calls
                const include = new Set<string>(Array.isArray(json.include) ? (json.include as string[]) : []);
                include.add("reasoning.encrypted_content"); // required when store:false
                json.include = [...include];
                // The Codex backend rejects requests without a top-level
                // `instructions` ("Instructions are required"). The SDK encodes
                // loop's system prompt as a developer message in `input`, so lift
                // that out into `instructions` (removing the duplicate) unless an
                // override is supplied.
                if (!json.instructions) {
                    if (overrideInstructions) {
                        json.instructions = overrideInstructions;
                    } else if (Array.isArray(json.input)) {
                        const input = json.input as Array<{ role?: string; content?: unknown }>;
                        const idx = input.findIndex((m) => m?.role === "developer" || m?.role === "system");
                        if (idx >= 0) {
                            json.instructions = messageContentToText(input[idx].content);
                            input.splice(idx, 1);
                        }
                    }
                    if (!json.instructions) json.instructions = "You are a helpful coding assistant.";
                }
                body = JSON.stringify(json);
            } catch {
                // not JSON (shouldn't happen for the Responses API) — leave as-is
            }
        }
        return fetch(input, { ...(init as RequestInit), headers, body });
    });
}

/**
 * Kimi reports cache hits OpenAI-style as a top-level `usage.cached_tokens`
 * (both endpoints; caching is automatic), but the DeepSeek SDK the kimi
 * provider rides only parses DeepSeek's `prompt_cache_hit_tokens` — and its
 * zod schema strips unknown keys, so the count is unrecoverable downstream.
 * Rewrite the usage payload before the SDK sees it: hit = cached_tokens,
 * miss = prompt_tokens - cached_tokens.
 */
function rewriteKimiUsage(obj: unknown): unknown {
    const usage = (obj as { usage?: Record<string, unknown> } | null)?.usage;
    if (usage && typeof usage.cached_tokens === "number" && usage.prompt_cache_hit_tokens == null) {
        const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
        usage.prompt_cache_hit_tokens = usage.cached_tokens;
        usage.prompt_cache_miss_tokens = Math.max(0, prompt - usage.cached_tokens);
    }
    return obj;
}

/** Line-buffered SSE transform: rewrite usage on data lines that carry it. */
function kimiSseRewrite(): TransformStream<string, string> {
    let buf = "";
    const rewriteLine = (line: string): string => {
        if (!line.includes('"cached_tokens"')) return line;
        const eol = line.endsWith("\r") ? "\r" : "";
        const body = eol ? line.slice(0, -1) : line;
        if (!body.startsWith("data:")) return line;
        const payload = body.slice(5).trimStart();
        if (!payload || payload === "[DONE]") return line;
        try {
            return `data: ${JSON.stringify(rewriteKimiUsage(JSON.parse(payload)))}${eol}`;
        } catch {
            return line;
        }
    };
    return new TransformStream({
        transform(chunk, controller) {
            buf += chunk;
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) controller.enqueue(`${rewriteLine(line)}\n`);
        },
        flush(controller) {
            if (buf) controller.enqueue(rewriteLine(buf));
        },
    });
}

export function kimiCacheFetch(): typeof fetch {
    return withPreconnect(async (input, init) => {
        const res = await fetch(input, init as RequestInit);
        const ctype = res.headers.get("content-type") ?? "";
        if (!res.ok || !res.body) return res;
        // Content-length no longer matches after a rewrite.
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        if (ctype.includes("text/event-stream")) {
            const body = res.body
                .pipeThrough(new TextDecoderStream())
                .pipeThrough(kimiSseRewrite())
                .pipeThrough(new TextEncoderStream());
            return new Response(body, { status: res.status, statusText: res.statusText, headers });
        }
        if (ctype.includes("application/json")) {
            const json = rewriteKimiUsage(await res.json());
            return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
        }
        return res;
    });
}

/**
 * Kimi Code subscription keys (sk-kimi-…) only work on api.kimi.com/coding/v1
 * — the pay-per-token platform endpoint 401s them (and vice versa), with its
 * own model ids (kimi-for-coding, k3). Platform keys are plain sk-… .
 */
export function isKimiSubscriptionKey(): boolean {
    return getApiKey("kimi")?.startsWith("sk-kimi-") ?? false;
}

/** Endpoint matching the stored key's kind; LOOP_KIMI_BASE_URL overrides. */
export function kimiBaseURL(): string {
    return (
        brandEnv("KIMI_BASE_URL") ||
        (isKimiSubscriptionKey() ? "https://api.kimi.com/coding/v1" : "https://api.moonshot.ai/v1")
    );
}

/** Ollama host root (no /api suffix). Override with LOOP_OLLAMA_BASE_URL. */
export function ollamaBaseURL(): string {
    return (brandEnv("OLLAMA_BASE_URL") || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

export interface OllamaModelTag {
    name: string;
    details?: { family?: string; parameter_size?: string };
}

/**
 * Lists models installed on the local Ollama daemon via GET /api/tags.
 * Returns null when the daemon is unreachable (not running), [] when running
 * with no models pulled.
 */
export async function listOllamaModels(): Promise<OllamaModelTag[] | null> {
    try {
        const res = await fetch(`${ollamaBaseURL()}/api/tags`, {
            signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { models?: OllamaModelTag[] };
        return body.models ?? [];
    } catch {
        return null;
    }
}

export interface OllamaModelDetail {
    capabilities: string[];
    contextLength?: number;
}

/**
 * Inspects one installed model via POST /api/show. Returns its capability list
 * ("thinking", "vision", "tools", …) and trained context length. Null on error.
 */
export async function showOllamaModel(name: string): Promise<OllamaModelDetail | null> {
    try {
        const res = await fetch(`${ollamaBaseURL()}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: name }),
            signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
            capabilities?: string[];
            model_info?: Record<string, unknown>;
        };
        const info = body.model_info ?? {};
        const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
        const ctx = ctxKey ? Number(info[ctxKey]) : undefined;
        return {
            capabilities: body.capabilities ?? [],
            contextLength: Number.isFinite(ctx) ? ctx : undefined,
        };
    } catch {
        return null;
    }
}

export function parseModelId(full: string): { provider: ProviderId; model: string } {
    // custom provider ids look like "custom:bifrost/claude-opus-4-7"
    if (full.startsWith("custom:")) {
        const slash = full.indexOf("/", "custom:".length);
        if (slash < 0) throw new Error(`custom model id must be "custom:<name>/model": ${full}`);
        return { provider: full.slice(0, slash), model: full.slice(slash + 1) };
    }
    const idx = full.indexOf("/");
    if (idx < 0) throw new Error(`model id must be "provider/model": ${full}`);
    return { provider: full.slice(0, idx) as ProviderId, model: full.slice(idx + 1) };
}

function xaiAuthFetch(): typeof fetch {
    return withPreconnect(async (input, init) => {
        let token: string;
        try {
            token = await getAccessToken("xai");
        } catch {
            const key = getApiKey("xai");
            if (!key) throw new Error(`No xAI credentials. Run: ${PRODUCT_NAME} login xai`);
            token = key;
        }
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        const res = await fetch(input, { ...(init as RequestInit), headers });
        if (res.status === 401) {
            try {
                const fresh = await getAccessToken("xai", { forceRefresh: true });
                headers.set("authorization", `Bearer ${fresh}`);
                return fetch(input, { ...(init as RequestInit), headers });
            } catch {
                return res;
            }
        }
        return res;
    });
}

function customFetch(cfg: CustomAuthConfig): typeof fetch | undefined {
    const authFetch = createCustomAuthFetch(cfg);
    return authFetch ? withPreconnect(authFetch) : undefined;
}

function normalizeBaseURL(sdk: CustomProviderConfig["sdk"], baseURL: string): string {
    const trimmed = baseURL.replace(/\/+$/, "");
    // ai-sdk providers expect baseURL to already include the API version segment.
    // Auto-append the conventional path when missing so users don't have to know.
    const hasVersion = /\/v\d+(\b|\/)/.test(trimmed);
    if (hasVersion) return trimmed;
    switch (sdk) {
        case "anthropic":
            return `${trimmed}/v1`;
        case "openai":
        case "openai-compatible":
            return `${trimmed}/v1`;
        case "google":
            return `${trimmed}/v1beta`;
        default:
            return trimmed;
    }
}

// Provider SDKs are dynamic-imported so plain CLI commands (--version, sessions,
// login) never pay their module-eval cost — only the first model call does.
async function customModel(cfg: CustomProviderConfig, model: string): Promise<LanguageModel> {
    const fetchOverride = customFetch(cfg);
    const baseURL = normalizeBaseURL(cfg.sdk, cfg.baseURL);
    // A plain stored key rides on the SDK's own header handling (pre-`auth`
    // behavior, unchanged). Every other kind resolves per request inside the
    // fetch wrapper, and the SDK gets an empty key it never really uses.
    const auth = normalizeCustomAuth(cfg);
    const apiKey = auth.kind === "apikey" ? auth.apiKey : "";
    switch (cfg.sdk) {
        case "openai":
        case "openai-compatible": {
            const { createOpenAI } = await import("@ai-sdk/openai");
            return createOpenAI({ apiKey, baseURL, fetch: fetchOverride })(model);
        }
        case "anthropic": {
            const { createAnthropic } = await import("@ai-sdk/anthropic");
            // Gateways are exactly where the thinking params get rewritten in
            // flight — see anthropic-shape.ts. Learned per custom provider.
            const shaped = anthropicShapeFetch(`custom:${cfg.name}`, fetchOverride ?? fetch);
            return createAnthropic({ apiKey, baseURL, fetch: shaped })(model);
        }
        case "google": {
            const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
            return createGoogleGenerativeAI({ apiKey, baseURL, fetch: fetchOverride })(model);
        }
        default:
            throw new Error(`Unknown custom SDK: ${cfg.sdk}`);
    }
}

export interface DiscoveredModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxOutput?: number;
}

/**
 * Model discovery for custom providers (gateways like bifrost, litellm, or any
 * compatible endpoint). Hits the sdk-appropriate models listing with the
 * provider's auth + custom headers. Returns null when the endpoint doesn't
 * support listing (404/timeout/parse error) — caller falls back to asking the
 * user for model ids.
 */
export async function fetchCustomProviderModels(
    cfg: Pick<CustomProviderConfig, "name" | "sdk" | "baseURL" | "apiKey" | "auth" | "headers">,
): Promise<DiscoveredModel[] | null> {
    const base = normalizeBaseURL(cfg.sdk, cfg.baseURL);
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
    // Resolved credential (any auth kind) — explicit user headers still win,
    // compared case-insensitively so "Authorization" blocks "authorization".
    const userSet = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
    for (const [k, v] of Object.entries(await customAuthHeaders(cfg))) {
        if (!userSet.has(k)) headers[k] = v;
    }
    try {
        if (cfg.sdk === "anthropic") {
            headers["anthropic-version"] ??= "2023-06-01";
            const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return null;
            const body = (await res.json()) as {
                data?: Array<{ id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number }>;
            };
            if (!body.data?.length) return null;
            return body.data.map((m) => ({
                id: m.id,
                name: m.display_name,
                contextWindow: m.max_input_tokens,
                maxOutput: m.max_tokens,
            }));
        }
        if (cfg.sdk === "google") {
            // Legacy flat keys also ride the query param (some gateways only
            // read that); other kinds arrive via the x-goog-api-key header.
            const query = cfg.apiKey ? `?key=${encodeURIComponent(cfg.apiKey)}` : "";
            const res = await fetch(`${base}/models${query}`, {
                headers,
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return null;
            const body = (await res.json()) as {
                models?: Array<{
                    name: string;
                    displayName?: string;
                    inputTokenLimit?: number;
                    outputTokenLimit?: number;
                }>;
            };
            if (!body.models?.length) return null;
            return body.models.map((m) => ({
                id: m.name.replace(/^models\//, ""),
                name: m.displayName,
                contextWindow: m.inputTokenLimit,
                maxOutput: m.outputTokenLimit,
            }));
        }
        // openai + openai-compatible — credential already placed above.
        // OpenAI's own /v1/models returns nothing but ids, but the gateways
        // that use this dialect (bifrost, litellm, openrouter-likes) do report
        // limits, under a handful of spellings. Whatever a gateway says about
        // its own deployment beats anything we can infer from a model id, so
        // take it when it's there.
        const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        const body = (await res.json()) as {
            data?: Array<{
                id: string;
                display_name?: string;
                context_window?: number;
                context_length?: number;
                max_input_tokens?: number;
                max_output_tokens?: number;
                max_completion_tokens?: number;
                max_tokens?: number;
            }>;
        };
        if (!body.data?.length) return null;
        return body.data.map((m) => ({
            id: m.id,
            name: m.display_name,
            contextWindow: m.context_window ?? m.context_length ?? m.max_input_tokens,
            maxOutput: m.max_output_tokens ?? m.max_completion_tokens ?? m.max_tokens,
        }));
    } catch {
        return null;
    }
}

/** Interpolate `$VAR` / `${VAR}` from the environment; leave literals as-is. */
function interpolateEnv(value: string): string {
    return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => process.env[a ?? b] ?? "");
}

/**
 * Resolve an extension provider's API key, in order: explicit config (with env
 * interpolation) → loop's auth store (`loop login <id>`) → the declared env var.
 * Returns undefined for keyless providers (e.g. auth.mode "none" / local).
 */
function resolveExtProviderKey(plugin: ProviderPlugin): string | undefined {
    if (plugin.apiKey) return interpolateEnv(plugin.apiKey);
    const stored = getApiKey(plugin.id);
    if (stored) return stored;
    if (plugin.auth?.envVar) return process.env[plugin.auth.envVar];
    return undefined;
}

/**
 * Build the ai-sdk model for a host-registered extension provider. Imperative
 * `getModel` wins; otherwise the declarative fields reuse loop's existing
 * custom-provider builder, so an extension provider behaves exactly like a
 * built-in or gateway provider at the call site (Liskov).
 */
async function extensionModel(plugin: ProviderPlugin, model: string): Promise<LanguageModel> {
    const apiKey = resolveExtProviderKey(plugin);
    if (plugin.getModel) return plugin.getModel(model, { apiKey, fetch });
    if (!plugin.sdk || !plugin.baseURL) {
        throw new Error(`extension provider "${plugin.id}" needs sdk + baseURL (or an imperative getModel)`);
    }
    return customModel(
        { name: plugin.id, sdk: plugin.sdk, baseURL: plugin.baseURL, apiKey: apiKey ?? "", headers: plugin.headers },
        model,
    );
}

export async function getModel(fullId: string): Promise<LanguageModel> {
    const { provider, model } = parseModelId(fullId);
    if (isCustomProvider(provider)) {
        const name = parseCustomProviderId(provider)!;
        const cfg = getCustomProvider(name);
        if (!cfg) throw new Error(`Custom provider not configured: ${name}`);
        return customModel(cfg, model);
    }
    // Extension-registered providers are consulted before the builtin switch, so
    // adding a provider never touches the switch (Open/Closed). With no
    // extensions loaded getProvider() returns undefined and this is skipped.
    const extProvider = getExtensionHost().getProvider(provider);
    if (extProvider) return extensionModel(extProvider, model);
    switch (provider) {
        case "xai": {
            const { createXai } = await import("@ai-sdk/xai");
            const xai = createXai({
                apiKey: getApiKey("xai") ?? "placeholder",
                baseURL: brandEnv("XAI_BASE_URL") || "https://api.x.ai/v1",
                fetch: xaiAuthFetch(),
            });
            return xai(model);
        }
        case "anthropic": {
            const key = getApiKey("anthropic");
            if (!key) throw new Error(`No Anthropic API key. Run: ${PRODUCT_NAME} login anthropic`);
            const { createAnthropic } = await import("@ai-sdk/anthropic");
            // First-party too: a model newer than the installed SDK's table
            // still gets its thinking shape corrected from the API's own
            // rejection instead of failing the turn (see anthropic-shape.ts).
            return createAnthropic({ apiKey: key, fetch: anthropicShapeFetch("anthropic") })(model);
        }
        case "openai": {
            const key = getApiKey("openai");
            if (!key) throw new Error(`No OpenAI API key. Run: ${PRODUCT_NAME} login openai`);
            const { createOpenAI } = await import("@ai-sdk/openai");
            return createOpenAI({ apiKey: key })(model);
        }
        case "google": {
            const key = getApiKey("google");
            if (!key) throw new Error(`No Google API key. Run: ${PRODUCT_NAME} login google`);
            const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
            return createGoogleGenerativeAI({ apiKey: key })(model);
        }
        case "openrouter": {
            // The community @openrouter/ai-sdk-provider (v3.x, @ai-sdk/provider@4
            // spec) surfaces OpenRouter's real usage.cost (see cost.ts) plus
            // provider-routing/reasoning options the OpenAI-compatible route
            // would drop.
            const key = getApiKey("openrouter");
            if (!key) throw new Error(`No OpenRouter API key. Run: ${PRODUCT_NAME} login openrouter`);
            const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
            return createOpenRouter({ apiKey: key })(model);
        }
        case "deepseek": {
            const key = getApiKey("deepseek");
            if (!key) throw new Error(`No DeepSeek API key. Run: ${PRODUCT_NAME} login deepseek`);
            const { createDeepSeek } = await import("@ai-sdk/deepseek");
            return createDeepSeek({ apiKey: key })(model);
        }
        case "mistral": {
            const key = getApiKey("mistral");
            if (!key) throw new Error(`No Mistral API key. Run: ${PRODUCT_NAME} login mistral`);
            const { createMistral } = await import("@ai-sdk/mistral");
            return createMistral({ apiKey: key })(model);
        }
        case "glm": {
            // Zhipu GLM models via the BigModel endpoint (open.bigmodel.cn).
            const key = getApiKey("glm");
            if (!key) throw new Error(`No GLM (Zhipu) API key. Run: ${PRODUCT_NAME} login glm`);
            const { createZhipu } = await import("zhipu-ai-provider");
            return createZhipu({ apiKey: key })(model);
        }
        case "zai": {
            // Same Zhipu GLM models via the international z.ai endpoint.
            const key = getApiKey("zai");
            if (!key) throw new Error(`No z.ai API key. Run: ${PRODUCT_NAME} login zai`);
            const { createZhipu } = await import("zhipu-ai-provider");
            return createZhipu({ apiKey: key, baseURL: "https://api.z.ai/api/paas/v4" })(model);
        }
        case "kimi": {
            // Moonshot AI (Kimi) — OpenAI-compatible with DeepSeek-shaped
            // reasoning_content, so the DeepSeek SDK extracts (and round-trips)
            // K2.6/K2.7/K3 thinking for free. The base URL follows the key kind
            // (see kimiBaseURL); LOOP_KIMI_BASE_URL overrides both (e.g.
            // https://api.moonshot.cn/v1 for the China endpoint).
            const key = getApiKey("kimi");
            if (!key) throw new Error(`No Kimi (Moonshot AI) API key. Run: ${PRODUCT_NAME} login kimi`);
            const { createDeepSeek } = await import("@ai-sdk/deepseek");
            return createDeepSeek({ apiKey: key, baseURL: kimiBaseURL(), fetch: kimiCacheFetch() })(model);
        }
        case "groq": {
            const key = getApiKey("groq");
            if (!key) throw new Error(`No Groq API key. Run: ${PRODUCT_NAME} login groq`);
            const { createGroq } = await import("@ai-sdk/groq");
            return createGroq({ apiKey: key })(model);
        }
        case "zenmux": {
            // OpenAI-compatible gateway (https://zenmux.ai/api/v1), author/model ids.
            const key = getApiKey("zenmux");
            if (!key) throw new Error(`No ZenMux API key. Run: ${PRODUCT_NAME} login zenmux`);
            const { createOpenAI } = await import("@ai-sdk/openai");
            return createOpenAI({ apiKey: key, baseURL: "https://zenmux.ai/api/v1" })(model);
        }
        case "vercel": {
            // Vercel AI Gateway (creator/model ids) via the first-party
            // @ai-sdk/gateway provider — it speaks the AI SDK's own wire
            // protocol, so reasoning/usage/providerOptions round-trip natively
            // instead of being squeezed through an OpenAI-compatible shim.
            // Key comes from `login vercel` or AI_GATEWAY_API_KEY (see
            // getApiKey); LOOP_VERCEL_BASE_URL overrides the endpoint (tests).
            const key = getApiKey("vercel");
            if (!key) throw new Error(`No Vercel AI Gateway API key. Run: ${PRODUCT_NAME} login vercel`);
            const { createGateway } = await import("@ai-sdk/gateway");
            return createGateway({ apiKey: key, baseURL: process.env["LOOP_VERCEL_BASE_URL"] })(model);
        }
        case "cerebras": {
            const key = getApiKey("cerebras");
            if (!key) throw new Error(`No Cerebras API key. Run: ${PRODUCT_NAME} login cerebras`);
            const { createCerebras } = await import("@ai-sdk/cerebras");
            return createCerebras({ apiKey: key })(model);
        }
        case "github-copilot": {
            const token = await resolveAuthToken("github-copilot");
            if (!token) throw new Error("No GitHub Copilot credentials. Run: /login github-copilot");
            const baseURL = getCopilotBaseUrl(token);
            const { createOpenAI } = await import("@ai-sdk/openai");
            return createOpenAI({ apiKey: "placeholder", baseURL, fetch: copilotAuthFetch() })(model);
        }
        case "openai-chatgpt": {
            // ChatGPT subscription via the Codex backend. It speaks the Responses
            // API (POST <baseURL>/responses), so use the SDK's .responses() model.
            const creds = await resolveOAuthCreds("openai-chatgpt");
            if (!creds) throw new Error("No ChatGPT credentials. Run: /login openai-chatgpt");
            const { createOpenAI } = await import("@ai-sdk/openai");
            return createOpenAI({
                apiKey: "placeholder",
                baseURL: CODEX_BASE_URL,
                fetch: openaiChatgptAuthFetch(),
            }).responses(model);
        }
        case "ollama": {
            // Local daemon — no auth. createOllama wants the /api root.
            const { createOllama } = await import("ollama-ai-provider-v2");
            return createOllama({ baseURL: `${ollamaBaseURL()}/api` })(model);
        }
        case "bedrock": {
            // AWS credentials come from the standard chain (env → shared
            // config → SSO → IMDS) — the same sources the aws CLI uses;
            // nothing lives in loop's auth store. A Bedrock API key
            // (AWS_BEARER_TOKEN_BEDROCK) wins when set, so the chain is only
            // wired up in its absence — matching the SDK's own precedence.
            const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
            if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
                return createAmazonBedrock({ region: bedrockRegion() })(model);
            }
            const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
            return createAmazonBedrock({
                region: bedrockRegion(),
                credentialProvider: fromNodeProviderChain(),
            })(model);
        }
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}
