import { describe, expect, test } from "bun:test";
import {
    buildModelInfo,
    chainIndexes,
    fromDeclaration,
    fromDiscovery,
    mergeMetadata,
    parseGatewayModelId,
    recordIndex,
    VendorCatalogResolver,
    type MetadataFloor,
} from "../src/catalog/metadata";
import type { ModelInfo } from "../src/types";

const model = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
    id,
    provider: id.slice(0, id.indexOf("/")) as ModelInfo["provider"],
    name: id,
    contextWindow: 200_000,
    maxOutput: 64_000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    reasoning: false,
    modalities: ["text"],
    ...over,
});

// The shape that broke: models.dev prices the same model differently per
// vendor, and OpenRouter mirrors `vendor/model` ids so a bare-id match can
// resolve to the wrong one.
const CATALOG: Record<string, ModelInfo> = {
    "openai/gpt-5.6-sol": model("openai/gpt-5.6-sol", {
        cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    }),
    "anthropic/claude-opus-5": model("anthropic/claude-opus-5", { contextWindow: 200_000 }),
    "anthropic/claude-sonnet-4-5": model("anthropic/claude-sonnet-4-5"),
    "openrouter/openai/gpt-5.6-sol": model("openrouter/openai/gpt-5.6-sol", {
        cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
    }),
};
const VENDOR_REFS: Record<string, ModelInfo> = {
    "azure/gpt-5.6-sol": model("azure/gpt-5.6-sol", {
        cost: { input: 4, output: 20, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1_050_000,
        reasoning: true,
    }),
    "amazon-bedrock/claude-opus-5": model("amazon-bedrock/claude-opus-5", { contextWindow: 999 }),
};

const byShortId = new Map<string, ModelInfo>();
for (const m of Object.values(CATALOG)) {
    const short = m.id.slice(m.id.indexOf("/") + 1);
    if (!byShortId.has(short)) byShortId.set(short, m);
}
const resolver = new VendorCatalogResolver(chainIndexes(recordIndex(VENDOR_REFS), recordIndex(CATALOG)), {
    get: (k) => byShortId.get(k),
});

const FLOOR: MetadataFloor = {
    contextWindow: 200_000,
    maxOutput: 16_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    modalities: ["text"],
};

describe("parseGatewayModelId", () => {
    test("splits a routing label off the id", () => {
        expect(parseGatewayModelId("azure/gpt-5.6-sol")).toEqual({
            raw: "azure/gpt-5.6-sol",
            label: "azure",
            tail: "gpt-5.6-sol",
            vendor: "azure",
        });
    });

    test("resolves the labels gateways use to models.dev's own keys", () => {
        expect(parseGatewayModelId("bedrock/claude-opus-5").vendor).toBe("amazon-bedrock");
        expect(parseGatewayModelId("vertex_ai/gemini-3-pro").vendor).toBe("google-vertex");
        expect(parseGatewayModelId("Azure-OpenAI/gpt-5.6-sol").vendor).toBe("azure");
    });

    test("a bare id has no label", () => {
        expect(parseGatewayModelId("claude-opus-5")).toEqual({ raw: "claude-opus-5", tail: "claude-opus-5" });
    });

    test("a leading slash is not a label", () => {
        expect(parseGatewayModelId("/weird").label).toBeUndefined();
    });
});

describe("VendorCatalogResolver", () => {
    test("a vendor-qualified id resolves to THAT vendor's entry, not another's", () => {
        // The regression: bifrost renamed openai/gpt-5.6-sol → azure/gpt-5.6-sol
        // when the deployment moved. Azure bills cache at 0.50/6.25, OpenAI at
        // 0.40/5.00 — inheriting OpenAI's numbers under-reports every turn.
        const meta = resolver.resolve("azure/gpt-5.6-sol");
        expect(meta?.cost?.cacheRead).toBe(0.5);
        expect(meta?.cost?.cacheWrite).toBe(6.25);
        expect(meta?.contextWindow).toBe(1_050_000);
    });

    test("an unknown vendor-qualified id does NOT silently fall through to a mirror", () => {
        // `openai/gpt-5.6-sol` must come from OpenAI, not from OpenRouter's
        // `openrouter/openai/gpt-5.6-sol` mirror — which is where the bare-id
        // match used to land it, right answer by pure coincidence.
        expect(resolver.resolve("openai/gpt-5.6-sol")?.cost?.input).toBe(4);
    });

    test("alias labels reach the aliased vendor's slice", () => {
        expect(resolver.resolve("bedrock/claude-opus-5")?.contextWindow).toBe(999);
    });

    test("a bare vendor id still resolves", () => {
        expect(resolver.resolve("claude-opus-5")?.contextWindow).toBe(200_000);
    });

    test("a routing label nobody knows falls back to the id behind it", () => {
        expect(resolver.resolve("fast-lane/claude-opus-5")?.contextWindow).toBe(200_000);
    });

    test("a dated id matches its undated entry", () => {
        expect(resolver.resolve("claude-sonnet-4-5-20250929")?.name).toBe("anthropic/claude-sonnet-4-5");
        expect(resolver.resolve("some-gateway/claude-sonnet-4-5-20250929")?.name).toBe("anthropic/claude-sonnet-4-5");
    });

    test("an id nothing knows resolves to nothing, rather than to something wrong", () => {
        expect(resolver.resolve("acme/llama-99")).toBeUndefined();
    });
});

describe("mergeMetadata", () => {
    test("first layer with an opinion wins, per field", () => {
        const merged = mergeMetadata([
            { contextWindow: 1_000_000 },
            { contextWindow: 200_000, maxOutput: 64_000, name: "second" },
        ]);
        expect(merged.contextWindow).toBe(1_000_000);
        expect(merged.maxOutput).toBe(64_000);
        expect(merged.name).toBe("second");
    });

    test("cost merges per sub-field, so a partial price keeps the rest", () => {
        const merged = mergeMetadata([{ cost: { input: 9 } }, { cost: { input: 1, output: 2, cacheRead: 0.5 } }]);
        expect(merged.cost).toMatchObject({ input: 9, output: 2, cacheRead: 0.5 });
    });

    test("an explicit zero is an answer and stops the search", () => {
        // A free model priced at $0 must not fall through to a paid layer.
        const merged = mergeMetadata([{ cost: { input: 0, output: 0 } }, { cost: { input: 15, output: 75 } }]);
        expect(merged.cost?.input).toBe(0);
        expect(merged.cost?.output).toBe(0);
    });

    test("undefined layers are skipped", () => {
        expect(mergeMetadata([undefined, { maxOutput: 8 }, undefined]).maxOutput).toBe(8);
    });
});

describe("buildModelInfo layering", () => {
    const build = (layers: Parameters<typeof buildModelInfo>[2]) =>
        buildModelInfo("custom:gw/azure/gpt-5.6-sol", "custom:gw" as ModelInfo["provider"], layers, {
            ...FLOOR,
            name: "azure/gpt-5.6-sol",
        });

    test("declaration beats the gateway, which beats the vendor catalog", () => {
        const m = build([
            fromDeclaration({ contextWindow: 123_456 }),
            fromDiscovery({ contextWindow: 777, maxOutput: 32_000 }),
            resolver.resolve("azure/gpt-5.6-sol"),
        ]);
        expect(m.contextWindow).toBe(123_456); // user's
        expect(m.maxOutput).toBe(32_000); // gateway's — user said nothing
        expect(m.cost.cacheWrite).toBe(6.25); // vendor's — neither said anything
        expect(m.reasoning).toBe(true); // vendor's
    });

    test("the gateway is trusted over models.dev about its own deployment", () => {
        // pronto serves Claude at 1M where models.dev says 200k.
        const m = build([undefined, fromDiscovery({ contextWindow: 1_000_000 }), resolver.resolve("claude-opus-5")]);
        expect(m.contextWindow).toBe(1_000_000);
    });

    test("an unresolvable model lands on the floor, fully formed", () => {
        const m = build([fromDeclaration({}), fromDiscovery(undefined), resolver.resolve("acme/llama-99")]);
        expect(m.contextWindow).toBe(200_000);
        expect(m.maxOutput).toBe(16_000);
        expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        expect(m.name).toBe("azure/gpt-5.6-sol");
        expect(m.modalities).toEqual(["text"]);
        expect(m.available).toBe(true);
    });

    test("the floor never invents a distinct reasoning rate", () => {
        expect(build([resolver.resolve("acme/llama-99")]).cost.reasoning).toBeUndefined();
    });

    test("a declared reasoning rate survives", () => {
        expect(build([fromDeclaration({ cost: { reasoning: 8 } })]).cost.reasoning).toBe(8);
    });
});
