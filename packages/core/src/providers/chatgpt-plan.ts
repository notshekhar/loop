/**
 * Request side of Sign in with ChatGPT: model calls billed to the user's
 * ChatGPT plan through the public Responses API (api.openai.com/v1), as
 * documented at developers.openai.com/siwc/token-sharing-open-source.
 *
 * The plan route accepts a strict subset of the Responses API. Rather than
 * teaching every call site about it, the model is wrapped once:
 *
 *  - middleware (`chatgptPlanMiddleware`) reshapes the SDK-level call — every
 *    function tool goes into one namespace (the route rejects bare top-level
 *    function tools), replayed tool calls carry that namespace too (so history
 *    survives regardless of what metadata the transcript kept), `store:false`,
 *    the system prompt as a developer message, and no sampling/limit knobs;
 *  - `generate` calls are served by streaming, because `stream:true` is
 *    mandatory on this route and loop makes plain generateText calls too;
 *  - the fetch (`chatgptPlanFetch`) injects the fresh OAuth token, strips any
 *    field the route rejects as a backstop, and turns the plan's structured
 *    errors into messages a user can act on.
 */
import type { LanguageModelMiddleware } from "ai";
import { CHATGPT_MANAGE_USAGE_URL, CHATGPT_RESOURCE } from "../auth/oauth/openai-chatgpt";

export const CHATGPT_PLAN_BASE_URL = CHATGPT_RESOURCE;

/** The one namespace every loop tool is grouped under on this route. */
export const CHATGPT_TOOL_NAMESPACE = {
    name: "loop",
    description: "Tools provided by the loop coding agent running on the user's machine.",
};

/** Top-level Responses fields the plan route rejects ("Unsupported fields" in the docs). */
const REJECTED_FIELDS = [
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
] as const;

/** @ai-sdk/openai provider options that would produce a rejected field. */
const REJECTED_OPENAI_OPTIONS = [
    "conversation",
    "maxToolCalls",
    "metadata",
    "previousResponseId",
    "promptCacheRetention",
    "safetyIdentifier",
    "truncation",
    "user",
] as const;

type Params = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
type GenerateResult = Awaited<
    ReturnType<Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0]["doGenerate"]>
>;
type StreamPart =
    Awaited<
        ReturnType<Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["doStream"]>
    >["stream"] extends ReadableStream<infer P>
        ? P
        : never;

type Json = Record<string, unknown>;

function withOpenAI(options: Json | undefined, patch: Json): Json {
    return { ...(options ?? {}), openai: { ...((options?.openai as Json | undefined) ?? {}), ...patch } };
}

/** Reshape one SDK call for the plan route. Pure — exported for tests. */
export function transformChatgptPlanParams(params: Params): Params {
    const openai: Json = { ...((params.providerOptions?.openai as Json | undefined) ?? {}) };
    for (const key of REJECTED_OPENAI_OPTIONS) delete openai[key];
    openai.store = false; // required; also makes the SDK request encrypted reasoning
    openai.systemMessageMode = "developer"; // explicit `system` items are rejected

    const tools = params.tools?.map((tool) =>
        tool.type === "function"
            ? {
                  ...tool,
                  providerOptions: withOpenAI(tool.providerOptions as Json | undefined, {
                      namespace: CHATGPT_TOOL_NAMESPACE,
                  }) as typeof tool.providerOptions,
              }
            : tool,
    );

    // A replayed function_call must name the namespace its tool lives in.
    const prompt = params.prompt.map((message) =>
        message.role === "assistant"
            ? {
                  ...message,
                  content: message.content.map((part) =>
                      part.type === "tool-call"
                          ? {
                                ...part,
                                providerOptions: withOpenAI(part.providerOptions as Json | undefined, {
                                    namespace: CHATGPT_TOOL_NAMESPACE.name,
                                }) as typeof part.providerOptions,
                            }
                          : part,
                  ),
              }
            : message,
    ) as Params["prompt"];

    return {
        ...params,
        prompt,
        ...(tools ? { tools } : {}),
        maxOutputTokens: undefined,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        seed: undefined,
        providerOptions: { ...(params.providerOptions ?? {}), openai } as Params["providerOptions"],
    };
}

/** Fold a finished stream into the shape `doGenerate` returns. Exported for tests. */
export async function collectStream(
    stream: ReadableStream<StreamPart>,
    extra: { request?: GenerateResult["request"]; headers?: Record<string, string> } = {},
): Promise<GenerateResult> {
    const content: GenerateResult["content"] = [];
    const open = new Map<string, { kind: "text" | "reasoning"; index: number }>();
    const warnings: GenerateResult["warnings"] = [];
    let finish: Extract<StreamPart, { type: "finish" }> | undefined;
    let meta: Json = {};

    const reader = stream.getReader();
    for (;;) {
        const { done, value: part } = await reader.read();
        if (done) break;
        switch (part.type) {
            case "stream-start":
                warnings.push(...part.warnings);
                break;
            case "text-start":
            case "reasoning-start": {
                const kind = part.type === "text-start" ? "text" : "reasoning";
                open.set(`${kind}:${part.id}`, { kind, index: content.length });
                content.push({
                    type: kind,
                    text: "",
                    ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
                } as GenerateResult["content"][number]);
                break;
            }
            case "text-delta":
            case "reasoning-delta": {
                const kind = part.type === "text-delta" ? "text" : "reasoning";
                const slot = open.get(`${kind}:${part.id}`);
                if (slot) (content[slot.index] as { text: string }).text += part.delta;
                else content.push({ type: kind, text: part.delta } as GenerateResult["content"][number]);
                break;
            }
            case "text-end":
            case "reasoning-end": {
                const kind = part.type === "text-end" ? "text" : "reasoning";
                const slot = open.get(`${kind}:${part.id}`);
                // The end part carries the final metadata (e.g. encrypted reasoning).
                if (slot && part.providerMetadata)
                    (content[slot.index] as { providerMetadata?: unknown }).providerMetadata = part.providerMetadata;
                open.delete(`${kind}:${part.id}`);
                break;
            }
            case "tool-input-start":
            case "tool-input-delta":
            case "tool-input-end":
            case "raw":
                break;
            case "response-metadata": {
                const { type: _type, ...rest } = part;
                meta = { ...meta, ...rest };
                break;
            }
            case "finish":
                finish = part;
                break;
            case "error":
                throw part.error;
            default:
                // tool-call, tool-result, source, file, custom, approval requests
                content.push(part as GenerateResult["content"][number]);
        }
    }
    if (!finish) throw new Error("ChatGPT stream ended without a completed response");
    return {
        content,
        finishReason: finish.finishReason,
        usage: finish.usage,
        ...(finish.providerMetadata ? { providerMetadata: finish.providerMetadata } : {}),
        ...(extra.request ? { request: extra.request } : {}),
        response: { ...meta, ...(extra.headers ? { headers: extra.headers } : {}) },
        warnings,
    };
}

export const chatgptPlanMiddleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    transformParams: async ({ params }) => transformChatgptPlanParams(params),
    // stream:true is mandatory on this route, so a generate call streams too.
    wrapGenerate: async ({ doStream }) => {
        const { stream, request, response } = await doStream();
        return collectStream(stream, { request, headers: response?.headers as Record<string, string> | undefined });
    },
    wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return {
            ...result,
            stream: result.stream.pipeThrough(
                new TransformStream<StreamPart, StreamPart>({
                    transform(part, controller) {
                        if (part.type === "error") {
                            const friendly = planErrorMessage(part.error);
                            if (friendly) {
                                controller.enqueue({ type: "error", error: new Error(friendly) });
                                return;
                            }
                        }
                        controller.enqueue(part);
                    },
                }),
            ),
        };
    },
};

// ─── Errors ─────────────────────────────────────────────────────────────────

const PLAN_ERRORS: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: `ChatGPT plan usage limit reached for loop. Manage usage: ${CHATGPT_MANAGE_USAGE_URL}`,
    subscription_sharing_user_not_eligible: "This ChatGPT account isn't eligible to use its plan in third-party apps.",
    subscription_sharing_usage_unavailable: "ChatGPT plan usage is temporarily unavailable. Try again shortly.",
    subscription_sharing_user_unavailable: "ChatGPT is temporarily unavailable for this account. Try again shortly.",
    subscription_sharing_invalid_user: "ChatGPT access was revoked. Sign in again: /login openai",
    subscription_sharing_route_not_supported: "The ChatGPT plan route rejected this request type.",
};

function errorCode(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined;
    const e = err as { code?: unknown; error?: { code?: unknown }; data?: { error?: { code?: unknown } } };
    const code = e.code ?? e.error?.code ?? e.data?.error?.code;
    return typeof code === "string" ? code : undefined;
}

/** A user-facing message for a plan-route error, or undefined to keep the original. */
export function planErrorMessage(err: unknown, param?: string): string | undefined {
    const code = errorCode(err);
    if (!code) return undefined;
    if (code === "subscription_sharing_unsupported_capability") {
        const p = param ?? (err as { param?: unknown }).param;
        return `The ChatGPT plan route doesn't support ${typeof p === "string" ? `\`${p}\`` : "a feature this request used"}.`;
    }
    return PLAN_ERRORS[code];
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

/**
 * Final JSON-body pass: drop rejected fields and pin store/stream. The
 * middleware already shaped the call; this catches anything the SDK adds on
 * its own. Exported for tests.
 */
export function sanitizeChatgptPlanBody(json: Json): Json {
    for (const key of REJECTED_FIELDS) delete json[key];
    json.store = false;
    json.stream = true;
    return json;
}

export function chatgptPlanFetch(getAccessToken: () => Promise<string>): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${await getAccessToken()}`);
        let body = init?.body;
        if (typeof body === "string" && body.startsWith("{")) {
            try {
                body = JSON.stringify(sanitizeChatgptPlanBody(JSON.parse(body) as Json));
            } catch {
                // not JSON — send unchanged
            }
        }
        const res = await fetch(input, { ...init, headers, body });
        if (res.ok) return res;

        // Rewrite structured plan errors in place so the SDK's error carries
        // the actionable text (status and code are preserved).
        const text = await res.text();
        let rewritten = text;
        try {
            const json = JSON.parse(text) as { error?: { message?: string; code?: string; param?: string } };
            const friendly = json.error ? planErrorMessage(json.error, json.error.param) : undefined;
            if (friendly && json.error) {
                json.error.message = friendly;
                rewritten = JSON.stringify(json);
            }
        } catch {
            // non-JSON error body
        }
        return new Response(rewritten, { status: res.status, statusText: res.statusText, headers: res.headers });
    }) as typeof fetch;
}

// ─── Model list ─────────────────────────────────────────────────────────────

export interface ChatgptPlanModel {
    slug: string;
    displayName: string;
    /** Tokens, when the catalog states it. */
    contextWindow?: number;
    /** e.g. ["text", "image"], when the catalog states it. */
    modalities?: string[];
}

/**
 * The catalog is filtered by `client_version` against each model's
 * `minimal_client_version` (a Codex version). Without it the server returns an
 * older subset — measured 2026-10-01: no gpt-6.1-sol / gpt-6-sol / gpt-6-luna,
 * all of which complete normally on the Responses route. loop implements the
 * route itself rather than through Codex, so it asks for the full catalog.
 */
const CATALOG_CLIENT_VERSION = "1.0.0";

/**
 * The signed-in account's model catalog. This route answers `{ models: [...] }`
 * (not the usual `{ data }`), and only `visibility: "list"` entries are meant
 * for a picker. Server order is preserved.
 */
export function parseChatgptModelList(payload: unknown): ChatgptPlanModel[] {
    const models = (payload as { models?: unknown })?.models;
    if (!Array.isArray(models)) return [];
    const out: ChatgptPlanModel[] = [];
    for (const m of models as Array<Json>) {
        if (m?.visibility !== "list" || typeof m.slug !== "string" || !m.slug) continue;
        // `context_window` is the default; `max_context_window` (872k vs 272k
        // measured) is an opt-in ceiling, so assuming it would overflow.
        const context = m.context_window;
        const modalities = Array.isArray(m.input_modalities)
            ? (m.input_modalities as unknown[]).filter((x): x is string => typeof x === "string")
            : undefined;
        out.push({
            slug: m.slug,
            displayName: typeof m.display_name === "string" ? m.display_name : m.slug,
            ...(typeof context === "number" && context > 0 ? { contextWindow: context } : {}),
            ...(modalities?.length ? { modalities } : {}),
        });
    }
    return out;
}

export async function listChatgptPlanModels(accessToken: string): Promise<ChatgptPlanModel[] | null> {
    try {
        const res = await fetch(`${CHATGPT_PLAN_BASE_URL}/models?client_version=${CATALOG_CLIENT_VERSION}`, {
            headers: { authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        return parseChatgptModelList(await res.json());
    } catch {
        return null;
    }
}
