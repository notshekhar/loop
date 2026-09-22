/**
 * Where a model's limits and pricing come from when the thing serving it is a
 * gateway rather than the vendor itself.
 *
 * A gateway model has no single authority: the user may have written limits in
 * auth.json, the endpoint may report some of its own, and models.dev knows the
 * underlying vendor model. Each knows *some* fields. Spelling that out inline
 * turns into one `a ?? b ?? c ?? default` chain per field, repeated per field
 * and per call site — six chains that have to be kept in the same order by
 * hand, and were not: the custom-provider and Bedrock paths had already
 * drifted to different defaults.
 *
 * So: a source contributes a partial, the layers are merged once, field by
 * field, in one place. Adding a source is adding an element to an array.
 */
import type { ModelInfo, ProviderId } from "../types";

type ModelCost = ModelInfo["cost"];

/**
 * What one source knows about a model. Every field is optional, and absent
 * means "no opinion" — which is not the same as zero. A $0 price and a missing
 * price are different answers, and only the first should stop the search.
 */
export interface ModelMetadata {
    name?: string;
    contextWindow?: number;
    maxOutput?: number;
    cost?: Partial<ModelCost>;
    reasoning?: boolean;
    modalities?: string[];
}

/** The values used for whatever no layer had an opinion on. */
export interface MetadataFloor {
    /** Defaults to the model id when omitted. */
    name?: string;
    contextWindow: number;
    maxOutput: number;
    cost: ModelCost;
    reasoning: boolean;
    modalities: string[];
}

/** Anything that can answer "what do you know about this model id?". */
export interface ModelMetadataResolver {
    resolve(modelId: string): ModelMetadata | undefined;
}

/** A keyed set of already-built models (the catalog, a models.dev slice). */
export interface ModelIndex {
    get(key: string): ModelInfo | undefined;
}

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;

/** First layer with an opinion wins, per field — `cost` merged per sub-field so
 *  a declared input price doesn't discard an inherited cache price. */
export function mergeMetadata(layers: readonly (ModelMetadata | undefined)[]): ModelMetadata {
    const merged: ModelMetadata = {};
    const cost: Partial<ModelCost> = {};
    for (const layer of layers) {
        if (!layer) continue;
        if (merged.name === undefined) merged.name = layer.name;
        if (merged.contextWindow === undefined) merged.contextWindow = layer.contextWindow;
        if (merged.maxOutput === undefined) merged.maxOutput = layer.maxOutput;
        if (merged.reasoning === undefined) merged.reasoning = layer.reasoning;
        if (merged.modalities === undefined) merged.modalities = layer.modalities;
        for (const field of COST_FIELDS) {
            if (cost[field] === undefined) cost[field] = layer.cost?.[field];
        }
    }
    merged.cost = cost;
    return merged;
}

/** Merge the layers over the floor and hand back a complete model. */
export function buildModelInfo(
    id: string,
    provider: ProviderId,
    layers: readonly (ModelMetadata | undefined)[],
    floor: MetadataFloor,
): ModelInfo {
    const meta = mergeMetadata([...layers, floorAsMetadata(floor, id)]);
    return {
        id,
        provider,
        name: meta.name as string,
        contextWindow: meta.contextWindow as number,
        maxOutput: meta.maxOutput as number,
        cost: {
            input: meta.cost?.input as number,
            output: meta.cost?.output as number,
            cacheRead: meta.cost?.cacheRead as number,
            cacheWrite: meta.cost?.cacheWrite as number,
            // Only carried when a layer actually named a distinct reasoning
            // rate; the floor leaves it absent so it bills as plain output.
            ...(meta.cost?.reasoning !== undefined ? { reasoning: meta.cost.reasoning } : {}),
        },
        reasoning: meta.reasoning as boolean,
        modalities: meta.modalities as string[],
        available: true,
    };
}

function floorAsMetadata(floor: MetadataFloor, id: string): ModelMetadata {
    return { ...floor, name: floor.name ?? id };
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** A model entry as the user wrote it in auth.json. */
export function fromDeclaration(entry: {
    name?: string;
    contextWindow?: number;
    maxOutput?: number;
    cost?: Partial<ModelCost>;
}): ModelMetadata {
    return { name: entry.name, contextWindow: entry.contextWindow, maxOutput: entry.maxOutput, cost: entry.cost };
}

/** What the endpoint reported about its own deployment, via model discovery. */
export function fromDiscovery(
    reported: { name?: string; contextWindow?: number; maxOutput?: number } | undefined,
): ModelMetadata | undefined {
    if (!reported) return undefined;
    return { name: reported.name, contextWindow: reported.contextWindow, maxOutput: reported.maxOutput };
}

/** An already-resolved catalog model, borrowed for another id. */
export function fromModelInfo(info: ModelInfo | undefined): ModelMetadata | undefined {
    if (!info) return undefined;
    return {
        name: info.name,
        contextWindow: info.contextWindow,
        maxOutput: info.maxOutput,
        cost: info.cost,
        reasoning: info.reasoning,
        modalities: info.modalities,
    };
}

// ---------------------------------------------------------------------------
// Gateway model ids
// ---------------------------------------------------------------------------

/**
 * Routing labels gateways put in front of a model id, mapped to the models.dev
 * provider they mean. Only aliases belong here — a label that already matches a
 * models.dev key (`azure`, `deepinfra`, …) passes through untouched.
 */
const VENDOR_ALIASES: Record<string, string> = {
    bedrock: "amazon-bedrock",
    "aws-bedrock": "amazon-bedrock",
    vertex: "google-vertex",
    vertex_ai: "google-vertex",
    "vertex-ai": "google-vertex",
    gemini: "google",
    azure_ai: "azure",
    "azure-ai": "azure",
    "azure-openai": "azure",
};

export interface GatewayModelId {
    /** The id exactly as the gateway gave it. */
    raw: string;
    /** The routing label before the first `/`, if there is one. */
    label?: string;
    /** Everything after that label — the id itself when there is no label. */
    tail: string;
    /** `label` resolved through the alias table. */
    vendor?: string;
}

export function parseGatewayModelId(id: string): GatewayModelId {
    const slash = id.indexOf("/");
    if (slash <= 0) return { raw: id, tail: id };
    const label = id.slice(0, slash).toLowerCase();
    return { raw: id, label, tail: id.slice(slash + 1), vendor: VENDOR_ALIASES[label] ?? label };
}

/** `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`. */
function stripDateSuffix(key: string): string {
    return key.replace(/-20\d{6}$/, "");
}

/**
 * The two key spaces a candidate can live in, kept apart on purpose.
 * `qualified` is `<vendor>/<model>`; `short` is a model id on its own.
 * Collapsing them is what made the old lookup resolve `openai/gpt-5.5` off
 * OpenRouter's `openrouter/openai/gpt-5.5` mirror — right answer, wrong reason,
 * and no such mirror exists for `azure/…`.
 */
type KeySpace = "qualified" | "short";

interface Candidate {
    space: KeySpace;
    key: string;
}

type IdStrategy = (parsed: GatewayModelId) => Candidate[];

/** Tried in order; the first that resolves wins. */
const ID_STRATEGIES: readonly IdStrategy[] = [
    // The prefix is a vendor models.dev knows. This is the one that matters for
    // a gateway that routes by deployment: `azure/gpt-5.6-sol` is Azure's entry,
    // priced as Azure prices it, not OpenAI's.
    ({ vendor, tail }) => (vendor ? [{ space: "qualified", key: `${vendor}/${tail}` }] : []),
    // The id verbatim — a bare vendor id, or a `vendor/model` mirror.
    ({ raw }) => [{ space: "short", key: raw }],
    // A routing label nobody has heard of (`fast/…`, a team or deployment
    // group) in front of an id we do know.
    ({ label, tail }) => (label ? [{ space: "short", key: tail }] : []),
];

/** Applied to every candidate key, in order. */
const KEY_NORMALIZERS: readonly ((key: string) => string)[] = [(key) => key, stripDateSuffix];

/**
 * Resolves a gateway's model id against the vendor catalogs.
 *
 * Gateways namespace by route, not by vendor: bifrost renamed its GPT models
 * from `openai/gpt-5.6-sol` to `azure/gpt-5.6-sol` when the deployment moved to
 * Azure, and litellm writes `bedrock/…` and `vertex_ai/…`. That prefix is
 * signal — models.dev is keyed by exactly that pair, and the vendors price the
 * same model differently (Azure bills gpt-5.6-sol's cache at 0.50/6.25 against
 * OpenAI's 0.40/5.00), so the qualified form is tried before the bare one.
 */
export class VendorCatalogResolver implements ModelMetadataResolver {
    constructor(
        private readonly qualified: ModelIndex,
        private readonly short: ModelIndex,
    ) {}

    resolve(modelId: string): ModelMetadata | undefined {
        return fromModelInfo(this.find(modelId));
    }

    private find(modelId: string): ModelInfo | undefined {
        const parsed = parseGatewayModelId(modelId);
        for (const strategy of ID_STRATEGIES) {
            for (const candidate of strategy(parsed)) {
                const index = candidate.space === "qualified" ? this.qualified : this.short;
                for (const normalize of KEY_NORMALIZERS) {
                    const hit = index.get(normalize(candidate.key));
                    if (hit) return hit;
                }
            }
        }
        return undefined;
    }
}

/** Reads several indexes as one, in order. */
export function chainIndexes(...indexes: readonly ModelIndex[]): ModelIndex {
    return {
        get(key) {
            for (const index of indexes) {
                const hit = index.get(key);
                if (hit) return hit;
            }
            return undefined;
        },
    };
}

export function recordIndex(record: Record<string, ModelInfo>): ModelIndex {
    return { get: (key) => record[key] };
}
