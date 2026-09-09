export type BuiltinProviderId =
    | "xai"
    | "anthropic"
    | "openai"
    | "openai-chatgpt"
    | "google"
    | "openrouter"
    | "github-copilot"
    | "deepseek"
    | "mistral"
    | "glm"
    | "zai"
    | "kimi"
    | "groq"
    | "cerebras"
    | "zenmux"
    | "vercel"
    | "bedrock"
    | "ollama";
export type ProviderId = BuiltinProviderId | (string & {});

// Note: "openai-chatgpt" is intentionally NOT listed — it's not a standalone
// entry in the /login picker. The single "openai" entry asks API-key vs ChatGPT
// subscription, and the subscription path stores creds under "openai-chatgpt"
// (used for model routing + catalog), mirroring how xAI offers OAuth-or-key.
export const BUILTIN_PROVIDER_IDS: BuiltinProviderId[] = [
    "xai",
    "anthropic",
    "openai",
    "google",
    "openrouter",
    "github-copilot",
    "deepseek",
    "mistral",
    "glm",
    "zai",
    "kimi",
    "groq",
    "cerebras",
    "zenmux",
    "vercel",
    "bedrock",
    "ollama",
];
export const PROVIDER_IDS = BUILTIN_PROVIDER_IDS;

export type CustomProviderSdk = "openai" | "anthropic" | "google" | "openai-compatible";

/**
 * How a custom provider authenticates. `apikey` is the classic stored key sent
 * in the vendor header; `bearer` forces `Authorization: Bearer` (gateways);
 * `env` reads the key from the environment at request time (never stored);
 * `helper` runs a shell command whose stdout is the key (vault/SSO short-lived
 * tokens — cached for ttlMs, re-run on 401); `oauth` is a browser sign-in
 * (PKCE) against the gateway's authorization server — tokens live in the auth
 * store and refresh automatically, so one login survives restarts; `none` is
 * for headers-only/mTLS/open endpoints. Legacy configs without `auth`
 * normalize from the flat apiKey.
 */
export type CustomProviderAuth =
    | { kind: "apikey"; apiKey: string }
    | { kind: "bearer"; token: string }
    | { kind: "env"; var: string }
    | { kind: "helper"; command: string; ttlMs?: number }
    | { kind: "oauth"; oauth?: CustomOAuthOptions }
    | { kind: "none" };

/**
 * Config-driven OAuth for a custom provider. Everything is optional: with no
 * options the endpoints are discovered from the provider baseURL (RFC 8414 /
 * OIDC well-known) and the client is registered dynamically (RFC 7591). Fields
 * exist as escape hatches for servers that don't support discovery or
 * anonymous registration.
 */
export interface CustomOAuthOptions {
    /** Authorization-server issuer to discover against; default: the baseURL. */
    issuer?: string;
    /** Explicit endpoints — skips discovery entirely when both are set. */
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    /** Pre-registered client. Omit to use dynamic client registration. */
    clientId?: string;
    clientSecret?: string;
    /** Scopes to request (include "offline_access" on OIDC servers that gate
     * refresh tokens behind it — that's what keeps you signed in). */
    scopes?: string[];
}

export interface CustomProviderConfig {
    name: string;
    sdk: CustomProviderSdk;
    baseURL: string;
    /** Legacy flat key. Kept mirrored (apikey kind → the key, else "") so
     * pre-auth loop versions reading the same auth.json keep working. */
    apiKey: string;
    /** How to authenticate; absent on legacy configs (normalized on read). */
    auth?: CustomProviderAuth;
    headers?: Record<string, string>;
    /** Model IDs the user wants to expose, with optional name + pricing overrides */
    models?: Array<{
        id: string;
        name?: string;
        contextWindow?: number;
        maxOutput?: number;
        cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    }>;
}

export interface ModelInfo {
    id: string;
    provider: ProviderId;
    name: string;
    contextWindow: number;
    maxOutput: number;
    /** $/MTok. `reasoning` is the rate for reasoning output tokens on models
     * that price them differently (e.g. Qwen: up to 4-10x the output rate);
     * absent = reasoning bills at the plain output rate. */
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };
    reasoning: boolean;
    modalities: string[];
    available: boolean;
}

export interface UsageBlock {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    // Flat fields kept for sessions persisted under ai-sdk v6 (it populated
    // these directly). v7 reports them nested under *TokenDetails below; readers
    // prefer the nested values and fall back to these for old sessions.
    cachedInputTokens?: number;
    reasoningTokens?: number;
    cost?: number;
    // ai-sdk v7 detail blocks. inputTokenDetails is needed to bill cache writes
    // (1.25x on Anthropic); outputTokenDetails carries reasoning token counts.
    inputTokenDetails?: {
        noCacheTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
    outputTokenDetails?: {
        textTokens?: number;
        reasoningTokens?: number;
    };
    /** True when this block is an estimate, not provider-reported — set for the
     * in-flight request of an interrupted turn (the AI SDK reports no usage on
     * abort; vercel/ai#7805). Estimated usage is summed into the session total
     * only, never the persistent lifetime/daily/cwd cost store. */
    estimated?: boolean;
    /** USD this block was billed at when it ran, stamped at persist time with
     * the pricing of the model that produced it. Resume seeding prefers this
     * over re-pricing against the current catalog, so historical cost stays
     * correct across model switches and catalog drift. Absent on entries
     * persisted before stamping existed — those fall back to catalog pricing. */
    usd?: number;
    /** Per-component split of `usd`, mirroring the token detail blocks. */
    usdDetails?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
}

export interface CostBreakdown {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    usd: number;
    /** True when the session total includes an estimated (interrupted-turn)
     * amount — the footer renders a leading `~` so the number isn't read as
     * exact. */
    estimated?: boolean;
}

export interface XaiOAuthCredentials {
    refresh: string;
    access: string;
    expires: number;
    tokenEndpoint?: string;
    discovery?: { authorization_endpoint: string; token_endpoint: string };
    idToken?: string;
    tokenType?: string;
    baseUrl?: string;
}

export interface GenericOAuthCredentials {
    refresh: string;
    access: string;
    expires: number;
    enterpriseUrl?: string;
    [key: string]: unknown;
}

export type AuthEntry =
    | { mode: "apikey"; provider: ProviderId; apiKey: string }
    | { mode: "oauth"; provider: "xai"; xai: XaiOAuthCredentials }
    | { mode: "oauth"; provider: ProviderId; creds: GenericOAuthCredentials };

export interface SessionInfoData {
    id: string;
    createdAt: number;
    cwd: string;
    provider: ProviderId;
    model: string;
    /** Canonical transcript address of the source of a fork or handoff. */
    parentSession?: string;
}

/** One step of a subagent's run, in stream order. Structured (not a flat
 * string) so renderers can style text / reasoning / tool lines differently. */
export type SubagentActivityPart =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool"; name: string; summary: string };

/**
 * One tool call's wall clock inside a step. `startedAt` is the stream's
 * `tool-call` part (the SDK invokes execute right after it); `endedAt` the
 * matching `tool-result` / `tool-error`, absent when the step was cut off
 * before the tool returned.
 */
export interface ToolTiming {
    toolCallId: string;
    toolName: string;
    startedAt: number;
    endedAt?: number;
    error?: boolean;
}

/**
 * Wall-clock stamps for one step of a turn (one model round-trip plus the
 * tools it called). All values are epoch ms taken when the stream part was
 * CONSUMED by the turn loop, not when the provider produced it — under a
 * heavy TUI render a stamp can land tens of ms late, so these are "observed"
 * timings good for a trace, not a latency benchmark.
 */
export interface StepTiming {
    /** `start-step` part — the request went out. */
    startedAt: number;
    /** First streamed part (text, reasoning or tool input); absent if the
     * step produced nothing before it ended. */
    firstTokenAt?: number;
    /** When the model finished talking: the last `tool-call` when the step
     * called tools (execution follows), else the same as `endedAt`. */
    modelEndedAt: number;
    /** `finish-step` part — tools have returned — or the abort instant. */
    endedAt: number;
    /** Wall time spent waiting out stream-resume backoff before this
     * attempt, when the step is the first of a resumed stream. Kept apart
     * from the model bar because it's a different cause. */
    retryWaitMs?: number;
    tools?: ToolTiming[];
}

/**
 * Tree structure: every entry is a node with an id and a parent
 * pointer. Optional on read (legacy flat sessions get ids assigned and a
 * linear chain on load); always set on write.
 */
export interface EntryTreeFields {
    id?: string;
    parentId?: string | null;
}

export type Entry = EntryTreeFields &
    (
        | ({ type: "session-info"; ts: number } & SessionInfoData)
        | {
              type: "message";
              role: "user" | "assistant" | "tool";
              content: unknown;
              ts: number;
              usage?: UsageBlock;
              /** Model that produced this message — pins cost to the right pricing
               * even after a mid-session model switch. */
              model?: string;
              /** True when the user interrupted before the turn completed. The
               * content holds whatever streamed; toModelMessages appends an
               * interruption note so the next turn's context reflects it (and
               * never silently drops an empty aborted turn). */
              interrupted?: boolean;
              /** Wall-clock ms per reasoning part of this assistant message, in
               * part order — display metadata ("Thought for 3s" on resume).
               * Kept OUTSIDE content: reasoning parts round-trip verbatim to
               * the provider, and unknown keys on them risk strict-API 400s. */
              reasoningMs?: number[];
              /** Wall-clock stamps for the step this assistant message closed —
               * display metadata for the trace view, never sent to the provider
               * (kept outside content for the same reason as reasoningMs).
               * Absent on sessions recorded before timing existed: a trace must
               * then say "not recorded", never infer bars from message ts. */
              timing?: StepTiming;
          }
        | {
              type: "subagent";
              ts: number;
              agent: string;
              prompt: string;
              result: string;
              /** Ordered run log (text/reasoning/tool parts, stream order). */
              activity?: SubagentActivityPart[];
              usage?: UsageBlock;
              /** Model that ran the subagent — pins its cost to the right pricing. */
              model?: string;
              /** The task tool call that launched this run — the handle a later
               * `follow_up` uses to continue it with context intact. */
              toolCallId?: string;
              /** toolCallId of the run this one continued (follow-up chains). */
              followUpOf?: string;
              /** Billed steps and wall-clock duration — replay renders the same
               * `N steps · Xs · $` line the live box showed. */
              steps?: number;
              durationMs?: number;
          }
        | { type: "model-change"; from: string; to: string; ts: number }
        // usage/model on compact + branch-summary: their generateText calls are
        // real billed spend (source of the once-unbilled compact bug).
        | {
              type: "compact";
              /** Empty on a rollover — `handoff` carries the replacement block instead. */
              summary: string;
              cutAt: number;
              ts: number;
              tokensBefore: number;
              tokensAfter: number;
              usage?: UsageBlock;
              model?: string;
              /** Set by a no-summary rollover: a mechanically-built recovery
               * record (inputs, todos, files touched, unconsumed tool results)
               * that replaces the summary block in the fresh window. Built with
               * no model call, so a rollover entry carries no usage/cost. */
              handoff?: string;
              /** Discriminates a rollover from a summarizing compaction for UI
               * and the context report. Implied by `handoff`, explicit so a
               * reader never has to infer it from an empty summary. */
              rollover?: true;
          }
        | { type: "branch-summary"; summary: string; ts: number; fromId?: string; usage?: UsageBlock; model?: string }
        | { type: "label"; targetId: string; label?: string; ts: number }
        // User-set session display name:
        // latest wins, empty/absent name clears.
        | { type: "session-name"; name?: string; ts: number }
        | { type: "custom"; payload: unknown; ts: number }
    );
