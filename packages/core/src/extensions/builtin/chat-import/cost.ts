/**
 * What an imported chat cost: its calls (usage.ts) priced at the catalog's
 * $/MTok for the model each one ran on — the rates loop bills its own calls
 * at, so an imported chat and a loop session compare like for like.
 *
 * Every call becomes one ledger row on save (sessions/chat-imports.ts),
 * dated when it happened, with the prices it was computed from — the
 * ledger's audit can recompute each row from its own columns.
 */
import type { ImportCostEstimate } from "../../../commands/registry";
import type { ImportedCallCost } from "../../../sessions/chat-imports";
import { fmtUsd } from "../../../format";
import type { ModelInfo, UsageBlock } from "../../../types";
import type { ChatSource, ImportedChat } from "./source";
import { estimatedCalls, type CallTokens, type ImportedCall } from "./usage";

type Prices = ModelInfo["cost"];

interface PricedModel {
    /** The name the ledger files the calls under, after the agent's id. */
    name: string;
    prices: Prices | undefined;
    /** Not the model the calls ran on: loop's current one, because the source never said. */
    standIn: boolean;
}

/** Where $/MTok come from — the catalog in loop, a fixed table in tests. */
export interface ModelPricer {
    /** A model as a vendor names it: `anthropic/claude-opus-5-5`, or bare `gpt-5.5`. */
    vendorPrices(modelId: string): Promise<Prices | undefined>;
    /** One of loop's own model ids. */
    loopPrices(modelId: string): Promise<Prices | undefined>;
}

// Loaded on use: the catalog imports the extension host, which imports this extension.
const catalog = () => import("../../../catalog");

export const catalogPricer: ModelPricer = {
    vendorPrices: async (modelId) => (await catalog()).vendorModelPrices(modelId),
    loopPrices: async (modelId) => (await catalog()).getModelSync(modelId)?.cost,
};

/**
 * `fallbackModel` is loop's current model id: it prices the calls of a source
 * that records no model (Cursor), and the result says so.
 */
export async function estimateChatCost(
    chat: ImportedChat,
    source: ChatSource,
    fallbackModel: string,
    pricer: ModelPricer = catalogPricer,
): Promise<ImportCostEstimate> {
    const calls = chat.calls?.length ? chat.calls : estimatedCalls(chat.entries);
    const models = await priceModels(calls, source, fallbackModel, pricer);
    const priced = calls.map((call) => priceCall(call, source.pricing.agent, models.get(call.model ?? "")!));
    return summarize(calls, priced, models);
}

async function priceModels(
    calls: readonly ImportedCall[],
    source: ChatSource,
    fallbackModel: string,
    pricer: ModelPricer,
): Promise<Map<string, PricedModel>> {
    const models = new Map<string, PricedModel>();
    for (const name of new Set(calls.map((c) => c.model ?? ""))) {
        models.set(name, name ? await namedModel(name, source, pricer) : await standInModel(fallbackModel, pricer));
    }
    return models;
}

async function namedModel(name: string, source: ChatSource, pricer: ModelPricer): Promise<PricedModel> {
    const qualified = source.pricing.vendor ? await pricer.vendorPrices(`${source.pricing.vendor}/${name}`) : undefined;
    return { name, prices: qualified ?? (await pricer.vendorPrices(name)), standIn: false };
}

async function standInModel(fallbackModel: string, pricer: ModelPricer): Promise<PricedModel> {
    const name = fallbackModel.slice(fallbackModel.indexOf("/") + 1);
    return { name, prices: await pricer.loopPrices(fallbackModel), standIn: true };
}

function priceCall(call: ImportedCall, agent: string, model: PricedModel): ImportedCallCost {
    const p = model.prices;
    const t = call.tokens;
    const usd = p
        ? (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6
        : 0;
    return {
        ts: call.ts,
        model: `${agent}/${model.name}`,
        usage: usageBlock(t),
        usd,
        prices: p ? { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite } : {},
        estimated: call.estimated,
    };
}

function usageBlock(t: CallTokens): UsageBlock {
    return {
        inputTokens: t.input + t.cacheRead + t.cacheWrite,
        outputTokens: t.output,
        inputTokenDetails: { noCacheTokens: t.input, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite },
        ...(t.reasoning ? { outputTokenDetails: { reasoningTokens: t.reasoning } } : {}),
    };
}

function summarize(
    calls: readonly ImportedCall[],
    priced: ImportedCallCost[],
    models: Map<string, PricedModel>,
): ImportCostEstimate {
    const sum = (pick: (t: CallTokens) => number) => calls.reduce((n, c) => n + pick(c.tokens), 0);
    const byModel = [...models.entries()].map(([key, model]) => {
        const mine = priced.filter((_, i) => (calls[i].model ?? "") === key);
        const usd = mine.reduce((n, c) => n + c.usd, 0);
        const price = !model.prices
            ? "no price known"
            : `${fmtUsd(usd)}${model.standIn ? ` at ${model.name}'s prices` : ""}`;
        return `${model.name} · ${mine.length} call${mine.length === 1 ? "" : "s"} · ${price}`;
    });
    const unpriced = [...models.values()].some((m) => !m.prices);
    return {
        usd: priced.reduce((n, c) => n + c.usd, 0),
        inputTokens: sum((t) => t.input + t.cacheRead + t.cacheWrite),
        outputTokens: sum((t) => t.output),
        cacheReadTokens: sum((t) => t.cacheRead),
        approximate: calls.some((c) => c.estimated) || [...models.values()].some((m) => m.standIn) || unpriced,
        byModel,
        calls: priced,
    };
}
