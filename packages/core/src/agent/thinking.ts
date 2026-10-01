import type { ProviderId } from "../types";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
    off: "No reasoning",
    minimal: "Very brief reasoning (~1k tokens)",
    low: "Light reasoning (~2k tokens)",
    medium: "Moderate reasoning (~8k tokens)",
    high: "Deep reasoning (~16k tokens)",
    xhigh: "Maximum reasoning (~32k tokens)",
};

/**
 * AI SDK v7's portable `reasoning` effort value. Our ThinkingLevel maps onto it
 * 1:1 (`off` → `none`), so first-party providers translate the level into the
 * right provider-specific request themselves — no hand-rolled per-provider
 * budget/effort tables needed (the SDK owns anthropic adaptive-thinking,
 * openai reasoningEffort, google thinkingConfig, etc).
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Providers where the portable `reasoning` param must NOT be sent — either it
 * doesn't flow through their community AI-SDK package (ollama/glm/zai/
 * openrouter), or the SDK would translate it into a param the backend doesn't
 * take (kimi rides @ai-sdk/deepseek, which maps effort → `reasoning_effort`;
 * Moonshot K2.x doesn't document that param). They keep the hand-built
 * `providerOptions` path in buildProviderOptions. Everything else
 * (anthropic/openai/google/xai/groq/mistral/deepseek/cerebras, plus the
 * gateway routes: zenmux/vercel/github-copilot/chatgpt) uses the native
 * `reasoning` param.
 */
const COMMUNITY_REASONING_PROVIDERS = new Set(["ollama", "glm", "zai", "openrouter", "kimi"]);

const OPENROUTER_EFFORT: Record<Exclude<ThinkingLevel, "off">, "low" | "medium" | "high"> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
};

/**
 * xAI only honors `reasoning_effort` on grok-3-mini-class models. Grok-4 and
 * preview models (grok-build, grok-4.20-*) reason internally and reject the
 * parameter with a 400 (see x.ai/api error: "Model X does not support
 * parameter reasoningEffort.").
 */
function xaiSupportsEffort(modelShortId: string): boolean {
    return /mini/i.test(modelShortId);
}

/**
 * The portable v7 `reasoning` value for a provider + level, or undefined when
 * this provider should NOT use the native param:
 *  - community providers (ollama/glm/zai/kimi) → handled by buildProviderOptions;
 *  - non-mini xAI models that 400 on reasoning effort → omit entirely.
 */
export function reasoningEffort(
    provider: ProviderId | string,
    level: ThinkingLevel,
    modelShortId = "",
): ReasoningEffort | undefined {
    if (COMMUNITY_REASONING_PROVIDERS.has(provider)) return undefined;
    if (provider === "xai" && level !== "off" && !xaiSupportsEffort(modelShortId)) return undefined;
    return level === "off" ? "none" : level;
}

/**
 * Anthropic models that predate *adaptive* thinking and still take the legacy
 * `{type: "enabled", budget_tokens: N}` shape. This set is CLOSED — Anthropic
 * ships only adaptive thinking (`thinking: {type: "adaptive"}` +
 * `output_config.effort`) from Opus 4.6 / Sonnet 4.6 onward — so it never grows.
 *
 * Why we decide this ourselves instead of trusting @ai-sdk/anthropic: the SDK
 * picks the request shape from a model table baked in at its release and keyed
 * on an exact `modelId.includes(...)` match. Any id it predates OR doesn't match
 * (a gateway/custom id, a newer release, or just an older installed binary)
 * falls through to the legacy `enabled` path and 400s ("thinking.type.enabled is
 * not supported for this model. Use thinking.type.adaptive and
 * output_config.effort"). Setting `thinking`/`effort` in providerOptions
 * ourselves (per Vercel's own Sonnet 5 example) makes the SDK skip that table
 * entirely, so adaptive works regardless of SDK version or how the model is
 * named. Older families (Claude 3.x / 2.x) can't think and carry
 * `reasoning: false` in the catalog, so they never reach here.
 */
const ANTHROPIC_LEGACY_THINKING = [
    "opus-4-5",
    "opus-4-1",
    "opus-4-0",
    "opus-4-2025", // claude-opus-4-20250514
    "sonnet-4-5",
    "sonnet-4-0",
    "sonnet-4-2025", // claude-sonnet-4-20250514
    "haiku-4-5",
];

export function anthropicUsesAdaptiveThinking(modelShortId: string): boolean {
    return !ANTHROPIC_LEGACY_THINKING.some((id) => modelShortId.includes(id));
}

const ANTHROPIC_ADAPTIVE_EFFORT: Record<Exclude<ThinkingLevel, "off">, "low" | "medium" | "high" | "xhigh"> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
};

/**
 * Anthropic models where OMITTING the `thinking` field runs adaptive thinking by
 * default (rather than no thinking). For these, sending only `output_config.effort`
 * — with no `thinking` field at all — is equivalent to adaptive thinking on the
 * real Anthropic API. We prefer that shape because it also survives proxies that
 * can't serialize the `thinking` field: e.g. bifrost returns "failed to convert
 * bifrost request" for BOTH thinking:{type:"adaptive"} and {type:"enabled"}, but
 * passes output_config.effort through untouched and Anthropic then runs adaptive.
 * (This is what Claude Code sends, and why it works through the same proxy.)
 *
 * Opus 4.6/4.7/4.8 and Sonnet 4.6 are adaptive-capable but omitting `thinking`
 * there yields NO thinking — they need an explicit thinking:{type:"adaptive"} —
 * so they are deliberately NOT in this set and keep the explicit shape.
 *
 * This set is a SEED, not the contract: whatever it gets wrong (a model shipped
 * after this build, a gateway that mangles the field) is corrected from the
 * endpoint's own rejection and remembered — see providers/anthropic-shape.ts.
 */
const ANTHROPIC_ADAPTIVE_WHEN_OMITTED = /claude-(opus-5|sonnet-5|fable-5|mythos-(5|preview))/;

/**
 * providerOptions for an Anthropic adaptive-thinking model. Setting `thinking`/
 * `effort` ourselves makes the SDK skip its own (table-driven) reasoning→thinking
 * mapping. `off` maps to disabled thinking, except on Fable/Mythos 5 where
 * thinking is always on and an explicit `disabled` is rejected — there we send
 * nothing and let the model default.
 */
function anthropicThinkingOptions(
    modelShortId: string,
    level: ThinkingLevel,
): Record<string, Record<string, unknown>> | undefined {
    if (level === "off") {
        if (/claude-(fable-5|mythos-(5|preview))/.test(modelShortId)) return undefined;
        return { anthropic: { thinking: { type: "disabled" } } };
    }
    // "xhigh" effort exists on Opus 5, Opus 4.7+, Sonnet 5, and Fable/Mythos 5,
    // but not on Opus 4.6 / Sonnet 4.6 — there it falls back to "max".
    const supportsXhigh = /claude-(opus-5|opus-4-[7-9]|sonnet-5|fable-5|mythos-(5|preview))/.test(modelShortId);
    const effort = level === "xhigh" && !supportsXhigh ? "max" : ANTHROPIC_ADAPTIVE_EFFORT[level];
    // Send effort ONLY (no `thinking` field) where omitting it defaults to
    // adaptive — equivalent on Anthropic, and proxy-safe (see the note above).
    // The cost of that shape: `display` lives INSIDE `thinking`, so these
    // models fall back to the API default of "omitted" — they still think (and
    // still bill for it), but the reasoning text streams empty and the UI shows
    // a silent pause. Nothing we can send fixes that without the field.
    if (ANTHROPIC_ADAPTIVE_WHEN_OMITTED.test(modelShortId)) {
        return { anthropic: { effort } };
    }
    // `display` defaults to "omitted" from Opus 4.7 on, which would leave loop's
    // reasoning pane blank on the very models that think the most. loop renders
    // reasoning, so ask for the summary explicitly — visibility only, thinking
    // is billed the same either way.
    return { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort } };
}

/**
 * The reasoning request params for a turn: the portable `reasoning` effort plus
 * any `providerOptions`. Anthropic adaptive-thinking models are driven purely
 * through providerOptions (portable param suppressed) so the request shape does
 * not depend on the SDK's model table; everything else uses the portable
 * `reasoning` param, falling back to providerOptions for community/edge providers.
 */
export function buildReasoningParams(
    provider: ProviderId | string,
    modelShortId: string,
    level: ThinkingLevel,
    reasoningCapable: boolean,
    /** Catalog POSITIVELY knows this model reasons — gates forceReasoning, which
     * must never be guessed onto a non-reasoning model (it would 400). */
    knownReasoningModel = false,
): { reasoning?: ReasoningEffort; providerOptions?: Record<string, Record<string, unknown>> } {
    if (!reasoningCapable) return {};
    if (provider === "anthropic" && anthropicUsesAdaptiveThinking(modelShortId)) {
        return { providerOptions: anthropicThinkingOptions(modelShortId, level) };
    }
    return {
        reasoning: reasoningEffort(provider, level, modelShortId),
        providerOptions: buildProviderOptions(provider, level, {
            // ChatGPT plan slugs come from the account's own catalog, so the
            // SDK's gpt-N prefix guess can't be trusted to recognize them.
            forceReasoning: knownReasoningModel && (isVendorPrefixed(modelShortId) || provider === "openai-chatgpt"),
        }),
    };
}

/**
 * True for gateway-style ids carrying a vendor segment ("openai/gpt-5.6-sol").
 *
 * @ai-sdk/openai decides reasoning support by a literal prefix match on the
 * model id (`startsWith("gpt-5" | "o1" | "o3" | "o4-mini")`), which a vendor
 * prefix defeats: the SDK then silently DROPS the whole `reasoning` block and
 * only records a warning, so thinking disappears with no error. Bifrost- and
 * LiteLLM-style `/v1/models` discovery returns exactly these ids (and loop
 * persists them into the provider's model list), so a custom provider can lose
 * thinking purely from how its gateway names models. `forceReasoning` is the
 * SDK's documented escape hatch for this — "useful for 'stealth' reasoning
 * models (e.g. via a custom baseURL)".
 */
function isVendorPrefixed(modelShortId: string): boolean {
    return modelShortId.includes("/");
}

/**
 * Provider-specific reasoning options the portable `reasoning` param does NOT
 * express. Returns undefined when the native param fully covers the provider.
 *
 *  - openai / github-copilot: `reasoningSummary: "auto"` so reasoning summaries
 *    still surface (additive — composes with the native effort);
 *  - openrouter: `reasoning: { effort }` (community provider, own option shape);
 *  - glm/zai:  zhipu `thinking: { type: enabled|disabled }` (boolean, no budget);
 *  - kimi:     same toggle shape, via the deepseek SDK's `thinking` option;
 *  - ollama:   `think: boolean` (DeepSeek-R1, Qwen3, …; no budget).
 */
export function buildProviderOptions(
    provider: ProviderId | string,
    level: ThinkingLevel,
    opts: { forceReasoning?: boolean } = {},
): Record<string, Record<string, unknown>> | undefined {
    const on = level !== "off";
    switch (provider) {
        case "openai":
        case "openai-chatgpt":
        case "github-copilot":
            // Effort comes from the native `reasoning` param; this only adds the
            // human-readable summary stream. Skip when reasoning is off.
            // forceReasoning overrides the SDK's id-prefix capability guess for
            // gateway-prefixed ids it can't recognize (see isVendorPrefixed).
            return on
                ? { openai: { reasoningSummary: "auto", ...(opts.forceReasoning ? { forceReasoning: true } : {}) } }
                : undefined;
        case "openrouter":
            return on
                ? { openrouter: { reasoning: { effort: OPENROUTER_EFFORT[level as Exclude<ThinkingLevel, "off">] } } }
                : undefined;
        case "glm":
        case "zai":
            // GLM-4.5+ thinking is a boolean toggle (no budget), merged into the
            // request body via the zhipu provider's providerOptions.
            return { zhipu: { thinking: { type: on ? "enabled" : "disabled" } } };
        case "kimi":
            // Moonshot's toggle has the same shape; the deepseek SDK forwards
            // its `thinking` option verbatim (and no reasoning_effort, since
            // the portable param is suppressed above).
            return { deepseek: { thinking: { type: on ? "enabled" : "disabled" } } };
        case "ollama":
            return { ollama: { think: on } };
        default:
            return undefined;
    }
}
