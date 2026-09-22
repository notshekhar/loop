import { getConfigDir, PRODUCT_NAME } from "../brand";
import { CachedStore } from "../auth/storage";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GENERATED_MODELS } from "./generated/models";
import { FALLBACK_MODELS, KIMI_CODE_MODELS, XAI_FALLBACK_MODELS, fallbackModelsForSdk } from "./fallbacks";
import { isVercelChatModel } from "./vercel";
import { getApiKey, getAccessToken, listAuthorizedProviders, listCustomProviders, saveCustomProvider } from "../auth";
import {
    bedrockShortModelId,
    fetchCustomProviderModels,
    hasAwsCredentialSources,
    isKimiSubscriptionKey,
    listBedrockModels,
    listOllamaModels,
    showOllamaModel,
    type BedrockModelSummary,
} from "../providers";
import { getExtensionHost } from "../extensions";
import {
    buildModelInfo,
    chainIndexes,
    fromDeclaration,
    fromDiscovery,
    parseGatewayModelId,
    recordIndex,
    VendorCatalogResolver,
    type MetadataFloor,
} from "./metadata";
import type { ModelInfo, ProviderId } from "../types";

// What a model is worth assuming when no layer knows better. Gateways proxy
// frontier models, so a generous context is the safer guess; Bedrock's own
// catalog runs smaller. $0 either way — an invented price is worse than a
// visible zero, and ~/.loop/models.json can correct it.
const GATEWAY_FLOOR: MetadataFloor = {
    contextWindow: 200_000,
    maxOutput: 16_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    modalities: ["text"],
};
const BEDROCK_FLOOR: MetadataFloor = { ...GATEWAY_FLOOR, contextWindow: 128_000, maxOutput: 8_192 };

const cacheStore = new CachedStore(
    `${PRODUCT_NAME}-agent-catalog`,
    { availability: {}, ts: 0, models: {}, modelsTs: 0 },
    { configPath: join(getConfigDir(), "catalog.json") },
);

const TTL_MS = 60 * 60 * 1000; // 1h

// Model definitions move (new releases, pricing, context bumps) while the
// build-time GENERATED_MODELS snapshot stays frozen until the next loop release.
// We re-fetch models.dev at runtime on the same stale-while-revalidate cycle
// as availability, so a binary keeps learning about new models.
const MODELS_SOURCE = "https://models.dev/api.json";
// Only providers whose models.dev key matches our provider id belong here
// (glm/zai map to models.dev "zhipuai", a different id — they're seeded from
// curated fallbacks instead).
const MODEL_PROVIDERS: ProviderId[] = [
    "xai",
    "anthropic",
    "openai",
    "google",
    "openrouter",
    "deepseek",
    "mistral",
    "groq",
    "cerebras",
    "vercel",
];

interface RawDevModel {
    id?: string;
    name?: string;
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number };
    reasoning?: boolean;
    modalities?: { input?: string[]; output?: string[] };
}

type RawDevPayload = Record<string, { models?: Record<string, RawDevModel> }>;

function toModelInfo(provider: string, rawId: string, m: RawDevModel): ModelInfo {
    const id = `${provider}/${rawId}`;
    return {
        id,
        provider: provider as ProviderId,
        name: m.name ?? rawId,
        contextWindow: m.limit?.context ?? 0,
        maxOutput: m.limit?.output ?? 0,
        cost: {
            input: m.cost?.input ?? 0,
            output: m.cost?.output ?? 0,
            cacheRead: m.cost?.cache_read ?? 0,
            cacheWrite: m.cost?.cache_write ?? 0,
            // Distinct reasoning-token rate (Qwen-style); absent for
            // the many models that bill reasoning as plain output.
            ...(m.cost?.reasoning !== undefined ? { reasoning: m.cost.reasoning } : {}),
        },
        reasoning: m.reasoning ?? false,
        modalities: m.modalities?.input ?? ["text"],
        available: true,
    };
}

interface ModelDefs {
    models: Record<string, ModelInfo>;
    /** The whole models.dev payload, kept so vendor slices can be cut from it
     * AFTER custom-provider rediscovery has settled on its final id list —
     * otherwise a gateway that just renamed `openai/x` to `azure/x` would wait
     * a full refresh cycle before azure's prices were fetched. */
    raw: RawDevPayload;
}

async function fetchModelDefs(): Promise<ModelDefs | null> {
    try {
        const res = await fetch(MODELS_SOURCE, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const raw = (await res.json()) as RawDevPayload;
        const out: Record<string, ModelInfo> = {};
        for (const provider of MODEL_PROVIDERS) {
            for (const [rawId, m] of Object.entries(raw[provider]?.models ?? {})) {
                if (provider === "vercel" && !isVercelChatModel(rawId, m.modalities?.output)) continue;
                out[`${provider}/${rawId}`] = toModelInfo(provider, rawId, m);
            }
        }
        // Sanity floor: a broken/partial payload must not wipe the catalog.
        if (Object.keys(out).length < 20) return null;
        return { models: out, raw };
    } catch {
        return null;
    }
}

/**
 * The models.dev provider slices worth caching for metadata inference: the
 * vendor prefixes custom providers actually use, minus the ones already in the
 * pickable catalog. Demand-driven on purpose — models.dev carries 223 providers
 * and ~8000 models, and a gateway's vendor slice must NOT land in the catalog
 * proper or the model picker fills with models the user cannot call.
 */
function vendorRefs(raw: RawDevPayload): Record<string, ModelInfo> {
    const wanted = new Set<string>();
    for (const cfg of listCustomProviders()) {
        for (const m of cfg.models ?? []) {
            const { vendor } = parseGatewayModelId(m.id);
            if (!vendor) continue; // no routing label, nothing to slice
            if (MODEL_PROVIDERS.includes(vendor as ProviderId)) continue; // already in the catalog
            if (raw[vendor]?.models) wanted.add(vendor);
        }
    }
    const out: Record<string, ModelInfo> = {};
    for (const provider of wanted) {
        for (const [rawId, m] of Object.entries(raw[provider]?.models ?? {})) {
            out[`${provider}/${rawId}`] = toModelInfo(provider, rawId, m);
        }
    }
    return out;
}

function storedModelDefs(): Record<string, ModelInfo> {
    return (cacheStore.get("models") as Record<string, ModelInfo> | undefined) ?? {};
}

/** models.dev slices for gateway vendor prefixes — inference only, never picked. */
function storedVendorRefs(): Record<string, ModelInfo> {
    return (cacheStore.get("refs") as Record<string, ModelInfo> | undefined) ?? {};
}

/** Gateway-reported limits, keyed by full model id (`custom:<name>/<model>`). */
function storedCustomMeta(): Record<string, { name?: string; contextWindow?: number; maxOutput?: number }> {
    return (
        (cacheStore.get("customMeta") as
            Record<string, { name?: string; contextWindow?: number; maxOutput?: number }> | undefined) ?? {}
    );
}

let mergedCache: Record<string, ModelInfo> | null = null;

export function bustCatalogCache(): void {
    mergedCache = null;
}

async function fetchAvailability(provider: ProviderId): Promise<Set<string> | null> {
    try {
        if (provider === "xai") {
            const token = (await getAccessToken("xai").catch(() => null)) ?? getApiKey("xai");
            if (!token) return null;
            const res = await fetch("https://api.x.ai/v1/models", {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return null;
            const body = (await res.json()) as { data?: { id: string }[] };
            return new Set((body.data ?? []).map((m) => `xai/${m.id}`));
        }
        if (provider === "openai") {
            const key = getApiKey("openai");
            if (!key) return null;
            const res = await fetch("https://api.openai.com/v1/models", {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return null;
            const body = (await res.json()) as { data?: { id: string }[] };
            return new Set((body.data ?? []).map((m) => `openai/${m.id}`));
        }
        if (provider === "anthropic") {
            const key = getApiKey("anthropic");
            if (!key) return null;
            const res = await fetch("https://api.anthropic.com/v1/models", {
                headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return null;
            const body = (await res.json()) as { data?: { id: string }[] };
            return new Set((body.data ?? []).map((m) => `anthropic/${m.id}`));
        }
        if (provider === "openrouter") {
            const res = await fetch("https://openrouter.ai/api/v1/models", {
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return null;
            const body = (await res.json()) as { data?: { id: string }[] };
            return new Set((body.data ?? []).map((m) => `openrouter/${m.id}`));
        }
        if (provider === "vercel") {
            // Public, no key needed. `type` distinguishes chat ("language")
            // from the marketplace's embedding/image/video/speech listings.
            const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return null;
            const body = (await res.json()) as { data?: { id: string; type?: string }[] };
            return new Set((body.data ?? []).filter((m) => m.type === "language").map((m) => `vercel/${m.id}`));
        }
        return null;
    } catch {
        return null;
    }
}

async function fetchOllamaCatalog(): Promise<ModelInfo[]> {
    const models = await listOllamaModels();
    if (!models) return [];
    // Query each model's real capabilities (thinking/vision) + context length
    // via /api/show, rather than guessing from the name. Runs in parallel.
    const details = await Promise.all(models.map((m) => showOllamaModel(m.name)));
    return models.map((m, i) => {
        const caps = details[i]?.capabilities ?? [];
        return {
            id: `ollama/${m.name}`,
            provider: "ollama" as ProviderId,
            name: m.name,
            contextWindow: details[i]?.contextLength ?? 8192,
            maxOutput: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            reasoning: caps.includes("thinking"),
            modalities: caps.includes("vision") ? ["text", "image"] : ["text"],
            available: true,
        };
    });
}

// Bedrock is zero-login like ollama, but listing costs credential-chain
// resolution plus two SigV4 AWS calls, so the result is cached (same 1h TTL,
// stale-while-revalidate) instead of probed live on every catalog build.
let bedrockRefreshInFlight: Promise<BedrockModelSummary[] | null> | null = null;

async function refreshBedrockModels(): Promise<BedrockModelSummary[] | null> {
    if (bedrockRefreshInFlight) return bedrockRefreshInFlight;
    bedrockRefreshInFlight = (async () => {
        const models = await listBedrockModels();
        // Failures cache as [] too: a machine with AWS creds but no Bedrock
        // access must not re-pay the probe every session — retried after TTL.
        cacheStore.set("bedrockModels", models ?? []);
        cacheStore.set("bedrockTs", Date.now());
        return models;
    })();
    try {
        return await bedrockRefreshInFlight;
    } finally {
        bedrockRefreshInFlight = null;
    }
}

/** Force re-list Bedrock models (login flow). Null when unreachable/no creds. */
export async function refreshBedrockCatalog(): Promise<BedrockModelSummary[] | null> {
    const models = await refreshBedrockModels();
    mergedCache = null;
    return models;
}

async function bedrockModelSummaries(refresh: boolean): Promise<BedrockModelSummary[]> {
    if (!hasAwsCredentialSources()) return [];
    const cached = cacheStore.get("bedrockModels") as BedrockModelSummary[] | undefined;
    // First detection (no cache yet) blocks once; after that it's served from
    // cache and refreshed in the background when stale, like availability.
    if (refresh || cached === undefined) return (await refreshBedrockModels()) ?? [];
    const ts = (cacheStore.get("bedrockTs") as number | undefined) ?? 0;
    if (Date.now() - ts > TTL_MS) {
        void refreshBedrockModels()
            .then(() => {
                mergedCache = null; // next getCatalog() rebuilds with the fresh list
            })
            .catch(() => {});
    }
    return cached;
}

function userOverridesPath(): string {
    return join(getConfigDir(), "models.json");
}

function readUserOverrides(): Record<string, Partial<ModelInfo>> {
    const path = userOverridesPath();
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, Partial<ModelInfo>>;
    } catch {
        return {};
    }
}

function writeUserOverrides(overrides: Record<string, Partial<ModelInfo>>): void {
    writeFileSync(userOverridesPath(), JSON.stringify(overrides, null, 2) + "\n");
    bustCatalogCache();
}

export interface CustomModelInput {
    provider: ProviderId;
    /** Short id within the provider, e.g. "anthropic/claude-x" → "claude-x". */
    modelId: string;
    name?: string;
    contextWindow?: number;
    maxOutput?: number;
    inputCost?: number;
    outputCost?: number;
}

/**
 * Add a user-defined model to ~/.loop/models.json (the existing override file).
 * No validation against the provider — a wrong id surfaces as an API error at
 * call time, which is acceptable and documented. Returns the full id.
 */
export function addCustomModel(input: CustomModelInput): string {
    const id = `${input.provider}/${input.modelId}`;
    const overrides = readUserOverrides();
    overrides[id] = {
        id,
        provider: input.provider,
        name: input.name ?? input.modelId,
        contextWindow: input.contextWindow ?? 128_000,
        maxOutput: input.maxOutput ?? 8_192,
        cost: {
            input: input.inputCost ?? 0,
            output: input.outputCost ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        reasoning: false,
        modalities: ["text"],
        available: true,
    };
    writeUserOverrides(overrides);
    return id;
}

export function removeCustomModel(id: string): boolean {
    const overrides = readUserOverrides();
    if (!(id in overrides)) return false;
    delete overrides[id];
    writeUserOverrides(overrides);
    return true;
}

/** Ids the user added/overrode locally (for listing in the picker). */
export function listCustomModelIds(): string[] {
    return Object.keys(readUserOverrides());
}

/**
 * Re-discover each custom provider's models from its `/models` endpoint and
 * persist them back into the provider config, so /reload (and the hourly
 * background revalidate) picks up models the gateway gained/lost since the
 * provider was added.
 *
 * Two invariants:
 *  - Endpoint with no model list (null/empty: 404, timeout, manual-only
 *    gateway) → the existing `cfg.models` are left untouched. Manually-entered
 *    models are never wiped by a transient outage.
 *  - Endpoint that DOES list models → refresh to that list, but carry each
 *    stored entry's own fields over so a user's name/pricing overrides survive.
 *
 * What the gateway reports about a model (limits, display name) is deliberately
 * NOT written back into auth.json. Merging it there makes it indistinguishable
 * from something the user typed, and the merge above prefers stored over
 * discovered — so the first refresh would freeze the gateway's own numbers and
 * a later bump on its side could never land. It goes in the catalog cache
 * instead, which every refresh is free to overwrite.
 */
async function refreshCustomProviderModels(): Promise<void> {
    const meta: Record<string, { name?: string; contextWindow?: number; maxOutput?: number }> = {};
    await Promise.all(
        listCustomProviders().map(async (cfg) => {
            try {
                const discovered = await fetchCustomProviderModels(cfg);
                if (!discovered?.length) return; // keep existing models
                const prev = new Map((cfg.models ?? []).map((m) => [m.id, m]));
                const models = discovered.map((m) => {
                    const p = prev.get(m.id);
                    return {
                        id: m.id,
                        ...(p?.name ? { name: p.name } : {}),
                        ...(p?.contextWindow ? { contextWindow: p.contextWindow } : {}),
                        ...(p?.maxOutput ? { maxOutput: p.maxOutput } : {}),
                        ...(p?.cost ? { cost: p.cost } : {}),
                    };
                });
                for (const m of discovered) {
                    if (!m.name && !m.contextWindow && !m.maxOutput) continue;
                    meta[`custom:${cfg.name}/${m.id}`] = {
                        ...(m.name ? { name: m.name } : {}),
                        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
                        ...(m.maxOutput ? { maxOutput: m.maxOutput } : {}),
                    };
                }
                saveCustomProvider({ ...cfg, models });
            } catch {
                // any failure → leave cfg.models as-is
            }
        }),
    );
    cacheStore.set("customMeta", meta);
}

let refreshInFlight: Promise<Record<string, string[]>> | null = null;

async function refreshAvailability(): Promise<Record<string, string[]>> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
        const providers: ProviderId[] = ["xai", "anthropic", "openai", "openrouter", "vercel"];
        // Custom-provider rediscovery runs alongside the availability fetches;
        // it persists cfg.models, which getCatalog re-reads when it rebuilds.
        const customRefresh = refreshCustomProviderModels();
        const [results, modelDefs] = await Promise.all([
            Promise.all(providers.map((p) => fetchAvailability(p))),
            fetchModelDefs(),
        ]);
        await customRefresh;
        const availability: Record<string, string[]> = {};
        for (let i = 0; i < providers.length; i++) {
            const set = results[i];
            if (set) availability[providers[i]] = [...set];
        }
        cacheStore.set("availability", availability);
        cacheStore.set("ts", Date.now());
        if (modelDefs) {
            cacheStore.set("models", modelDefs.models);
            cacheStore.set("modelsTs", Date.now());
            // After `await customRefresh` above, so a gateway that renamed its
            // ids this cycle gets the new vendor's slice in the same pass.
            cacheStore.set("refs", vendorRefs(modelDefs.raw));
        }
        return availability;
    })();
    try {
        return await refreshInFlight;
    } finally {
        refreshInFlight = null;
    }
}

export async function getCatalog(opts: { refresh?: boolean } = {}): Promise<Record<string, ModelInfo>> {
    if (mergedCache && !opts.refresh) return mergedCache;

    const ts = cacheStore.get("ts") as number;
    const stored = (cacheStore.get("availability") as Record<string, string[]>) ?? {};
    let availability: Record<string, string[]> = stored;

    if (opts.refresh) {
        availability = await refreshAvailability();
    } else if (Date.now() - ts > TTL_MS) {
        // Stale-while-revalidate: serve the stored availability immediately and
        // refresh in the background. Blocking here stalled the first prompt of a
        // session by up to 10s (4 provider /models fetches behind one await).
        void refreshAvailability()
            .then(() => {
                mergedCache = null; // next getCatalog() rebuilds with fresh availability
            })
            .catch(() => {});
    }

    const out: Record<string, ModelInfo> = {};
    // curated fallbacks win id collisions over generated catalog
    for (const m of FALLBACK_MODELS) {
        out[m.id] = { ...m };
    }
    // Runtime-fetched defs override the build-time snapshot (newer models,
    // pricing, context); the snapshot fills in when the fetch never succeeded.
    const defs = { ...GENERATED_MODELS, ...storedModelDefs() };
    for (const [id, m] of Object.entries(defs)) {
        if (out[id]) continue;
        const provAvail = availability[m.provider];
        const available = provAvail ? provAvail.includes(id) : true;
        out[id] = { ...m, available };
    }
    // Gate non-public providers by auth presence.
    const authed = new Set(listAuthorizedProviders());
    const hasCopilot = authed.has("github-copilot");
    const hasChatgpt = authed.has("openai-chatgpt");
    for (const m of Object.values(out)) {
        if (m.provider === "github-copilot") m.available = hasCopilot;
        if (m.provider === "openai-chatgpt") m.available = hasChatgpt;
    }

    // A Kimi Code subscription key can only call the plan's own models on its
    // own endpoint — the pay-per-token ids 401/404 there — so swap the seed.
    if (isKimiSubscriptionKey()) {
        for (const [id, m] of Object.entries(out)) if (m.provider === "kimi") delete out[id];
        for (const m of KIMI_CODE_MODELS) out[m.id] = { ...m };
    }

    // Note: we do NOT downmark fallback models based on /v1/models availability.
    // Subscription-only / preview models (e.g. grok-build, grok-4.20-*) are not
    // returned by xai's public /v1/models endpoint but ARE callable with an
    // OAuth bearer token. So fallback entries stay available unconditionally.
    void XAI_FALLBACK_MODELS;

    // custom providers' declared models — falls back to sdk defaults if empty.
    // Pricing: gateways proxy known vendor models, so when the user hasn't set
    // a cost we match the model id against the known catalog (exact short id,
    // or with the -YYYYMMDD date suffix stripped) and inherit real prices —
    // token usage comes back real from the gateway, so cost tracking stays
    // accurate. No match → $0.
    const byShortId = new Map<string, ModelInfo>();
    for (const m of Object.values(out)) {
        const short = m.id.slice(m.id.indexOf("/") + 1);
        if (!byShortId.has(short)) byShortId.set(short, m);
    }
    // Qualified space first (`azure/gpt-5.6-sol`): the models.dev vendor slices
    // fetched for the prefixes in use, then the catalog proper. Short space is
    // every catalog model under its bare id.
    const vendorCatalog = new VendorCatalogResolver(chainIndexes(recordIndex(storedVendorRefs()), recordIndex(out)), {
        get: (key) => byShortId.get(key),
    });

    const customMeta = storedCustomMeta();
    for (const cfg of listCustomProviders()) {
        const provId = `custom:${cfg.name}`;
        const userModels = cfg.models ?? [];
        let entries = userModels;
        if (entries.length === 0) {
            entries = fallbackModelsForSdk(cfg.sdk).map((m) => {
                const localId = m.id.split("/").slice(1).join("/");
                return {
                    id: localId,
                    name: m.name,
                    contextWindow: m.contextWindow,
                    maxOutput: m.maxOutput,
                    cost: m.cost,
                };
            });
        }
        for (const m of entries) {
            const fullId = `${provId}/${m.id}`;
            // Ordered by authority: what the user declared in auth.json, then
            // what the gateway said about its own deployment (pronto serves
            // Claude at 1M where models.dev says 200k — the gateway is right
            // about itself), then the vendor catalog, then the floor.
            out[fullId] = buildModelInfo(
                fullId,
                provId,
                [fromDeclaration(m), fromDiscovery(customMeta[fullId]), vendorCatalog.resolve(m.id)],
                { ...GATEWAY_FLOOR, name: m.id },
            );
        }
    }

    // Extension-registered provider models (api.providers.register declarative
    // `models`, plus api.models.add). Empty when no extensions are loaded, so
    // the catalog is byte-identical to before in a clean install. Placed before
    // user overrides so a user models.json patch still wins.
    for (const info of getExtensionHost().getProviderModelInfos()) {
        out[info.id] = info;
    }

    // Ollama: dynamic, machine-local, zero-login. fetchOllamaCatalog probes the
    // daemon (3s timeout, null when not running) — if it answers, the installed
    // models appear; if not, the provider simply doesn't exist. No /login needed.
    {
        const tags = await fetchOllamaCatalog();
        for (const m of tags) out[m.id] = m;
    }

    // Bedrock: also zero-login — appears automatically when the machine has AWS
    // credentials (aws CLI / env / SSO). Pricing/context/reasoning inherit from
    // the underlying vendor model in the known catalog (us.anthropic.claude-x-…
    // -v1:0 → anthropic's claude-x); unmatched models (Nova, Llama, …) fall
    // back to $0 + a generic context, correctable via ~/.loop/models.json.
    for (const s of await bedrockModelSummaries(opts.refresh ?? false)) {
        const id = `bedrock/${s.id}`;
        out[id] = buildModelInfo(
            id,
            "bedrock" as ProviderId,
            [{ name: s.name }, vendorCatalog.resolve(bedrockShortModelId(s.id))],
            BEDROCK_FLOOR,
        );
    }

    const overrides = readUserOverrides();
    for (const [id, patch] of Object.entries(overrides)) {
        out[id] = { ...(out[id] ?? ({} as ModelInfo)), ...patch, id } as ModelInfo;
    }

    mergedCache = out;
    return out;
}

export async function getModel(id: string): Promise<ModelInfo | undefined> {
    const cat = await getCatalog();
    return cat[id];
}

let FALLBACK_BY_ID: Record<string, ModelInfo> | null = null;
export function getModelSync(id: string): ModelInfo | undefined {
    if (mergedCache?.[id]) return mergedCache[id];
    if (GENERATED_MODELS[id]) return GENERATED_MODELS[id];
    if (!FALLBACK_BY_ID) {
        FALLBACK_BY_ID = {};
        for (const m of FALLBACK_MODELS) FALLBACK_BY_ID[m.id] = m;
    }
    if (FALLBACK_BY_ID[id]) return FALLBACK_BY_ID[id];
    // User-defined models (~/.loop/models.json) resolve before the async catalog
    // has been built — e.g. the footer reading a just-picked custom model.
    const override = readUserOverrides()[id];
    return override ? ({ ...override, id } as ModelInfo) : undefined;
}

/**
 * Which providers the user can actually use right now — the only honest answer
 * to "what may I offer in a model picker".
 *
 * Being logged in is not the same as being usable, and three whole classes of
 * provider have no auth entry at all: ollama (a detected local daemon),
 * bedrock (AWS credentials from the environment), and custom gateways (stored
 * under `customProviders`, keyed `custom:<name>`). Filtering a picker by
 * `listAuthorizedProviders()` silently hides all of them — which is exactly
 * what the Telegram and web model pickers were doing. Lives here, beside the
 * catalog it consults, so every surface agrees.
 */
export async function listUsableProviders(): Promise<ProviderId[]> {
    const providers = [...listAuthorizedProviders()];

    // Zero-login providers announce themselves by landing in the catalog at
    // all: ollama once its daemon answers, bedrock once AWS creds resolve.
    const ZERO_LOGIN = new Set<string>(["ollama", "bedrock"]);
    const catalog = await getCatalog();
    for (const model of Object.values(catalog)) {
        if (model.available && ZERO_LOGIN.has(model.provider) && !providers.includes(model.provider)) {
            providers.push(model.provider);
        }
    }

    for (const custom of listCustomProviders()) {
        const id = `custom:${custom.name}` as ProviderId;
        if (!providers.includes(id)) providers.push(id);
    }

    return providers;
}

export { GENERATED_MODELS };
export { fallbackModelsForSdk, FALLBACK_MODELS } from "./fallbacks";
