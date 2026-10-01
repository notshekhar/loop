import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, streamText, tool, wrapLanguageModel } from "ai";
import { buildAuthorizeUrl, parseCallbackInput, verifyIdToken } from "../src/auth/oauth/openai-chatgpt";
import {
    CHATGPT_TOOL_NAMESPACE,
    chatgptPlanFetch,
    chatgptPlanMiddleware,
    parseChatgptModelList,
    planErrorMessage,
    sanitizeChatgptPlanBody,
} from "../src/providers/chatgpt-plan";

// ─── Sign-in ─────────────────────────────────────────────────────────────────

describe("authorize URL", () => {
    const base = {
        redirectUri: "http://127.0.0.1:1455/auth/callback",
        challenge: "chal",
        state: "st",
        nonce: "no",
        hostId: "urn:uuid:11111111-2222-4333-8444-555555555555",
    };

    test("first-time registration uses the dynamic client and names the app", () => {
        const u = new URL(buildAuthorizeUrl(base));
        expect(u.origin + u.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
        const q = u.searchParams;
        expect(q.get("client_id")).toBe("dynamic_agent_client");
        expect(q.get("agent_name_hint")).toBeTruthy();
        expect(q.get("ext_agent_host_id")).toBe(base.hostId);
        expect(q.get("resource")).toBe("https://api.openai.com/v1");
        expect(q.get("scope")!.split(" ").sort()).toEqual(
            ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"].sort(),
        );
        expect(q.get("redirect_uri")).toBe(base.redirectUri);
        expect(q.get("code_challenge_method")).toBe("S256");
        expect(q.get("nonce")).toBe("no");
        expect(q.get("id_token_hint")).toBeNull();
    });

    test("returning sign-in reuses the issued client with hints and no name hint", () => {
        const q = new URL(
            buildAuthorizeUrl({
                ...base,
                registration: { clientId: "oaiapp_abc", subject: "sub1", email: "a@b.c", idToken: "x.y.z" },
            }),
        ).searchParams;
        expect(q.get("client_id")).toBe("oaiapp_abc");
        expect(q.get("agent_name_hint")).toBeNull();
        expect(q.get("id_token_hint")).toBe("x.y.z");
        expect(q.get("login_hint")).toBe("a@b.c");
        expect(q.get("ext_agent_host_id")).toBe(base.hostId);
    });
});

describe("callback parsing", () => {
    test("reads code, state and the issued client id from a redirect URL", () => {
        expect(
            parseCallbackInput(
                "http://127.0.0.1:1455/auth/callback?code=C&scope=openid+email&state=S&client_id=oaiapp_1",
            ),
        ).toEqual({ code: "C", state: "S", clientId: "oaiapp_1", error: undefined, errorDescription: undefined });
    });

    test("reads an error", () => {
        expect(parseCallbackInput("?error=access_denied&state=S").error).toBe("access_denied");
    });

    test("empty input is no result", () => {
        expect(parseCallbackInput("  ")).toEqual({});
    });
});

describe("ID token verification", () => {
    async function signer() {
        const pair = await crypto.subtle.generateKey(
            {
                name: "RSASSA-PKCS1-v1_5",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            true,
            ["sign", "verify"],
        );
        const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, string>;
        const b64 = (b: Uint8Array | string) =>
            Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url");
        const sign = async (claims: Record<string, unknown>, kid = "k1") => {
            const head = b64(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
            const body = b64(JSON.stringify(claims));
            const sig = await crypto.subtle.sign(
                "RSASSA-PKCS1-v1_5",
                pair.privateKey,
                new TextEncoder().encode(`${head}.${body}`),
            );
            return `${head}.${body}.${b64(new Uint8Array(sig))}`;
        };
        return { jwks: { keys: [{ ...pub, kid: "k1" }] }, sign };
    }

    const now = Date.UTC(2026, 9, 1);
    const good = {
        iss: "https://auth.openai.com",
        aud: "oaiapp_1",
        sub: "user-1",
        email: "a@b.c",
        nonce: "n1",
        exp: now / 1000 + 3600,
    };

    test("accepts a correctly signed token for this client and nonce", async () => {
        const { jwks, sign } = await signer();
        const claims = await verifyIdToken(await sign(good), { clientId: "oaiapp_1", nonce: "n1", jwks, now });
        expect(claims.sub).toBe("user-1");
    });

    test.each([
        ["nonce", { nonce: "other" }, /nonce/],
        ["audience", { aud: "oaiapp_2" }, /different client/],
        ["issuer", { iss: "https://evil.example" }, /issuer/],
        ["expiry", { exp: now / 1000 - 3600 }, /expired/],
    ])("rejects a wrong %s", async (_name, patch, message) => {
        const { jwks, sign } = await signer();
        await expect(
            verifyIdToken(await sign({ ...good, ...patch }), { clientId: "oaiapp_1", nonce: "n1", jwks, now }),
        ).rejects.toThrow(message);
    });

    test("rejects a tampered payload", async () => {
        const { jwks, sign } = await signer();
        const [h, , s] = (await sign(good)).split(".");
        const forged = Buffer.from(JSON.stringify({ ...good, sub: "attacker" })).toString("base64url");
        await expect(
            verifyIdToken(`${h}.${forged}.${s}`, { clientId: "oaiapp_1", nonce: "n1", jwks, now }),
        ).rejects.toThrow(/signature/);
    });

    test("rejects a token signed by an unknown key", async () => {
        const { jwks, sign } = await signer();
        await expect(
            verifyIdToken(await sign(good, "k9"), { clientId: "oaiapp_1", nonce: "n1", jwks, now }),
        ).rejects.toThrow(/unknown key/);
    });
});

// ─── Requests: the real @ai-sdk/openai model, wrapped, against a fake server ─

function sse(events: unknown[]): Response {
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const COMPLETED = {
    type: "response.completed",
    response: {
        incomplete_details: null,
        usage: {
            input_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
        },
    },
};

function textReply(text: string): unknown[] {
    return [
        { type: "response.created", response: { id: "resp_1", created_at: 1790000000, model: "gpt-6.1-sol" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
        COMPLETED,
    ];
}

function toolCallReply(): unknown[] {
    const item = {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "read",
        arguments: '{"path":"a.ts"}',
        namespace: "loop",
    };
    return [
        { type: "response.created", response: { id: "resp_2", created_at: 1790000000, model: "gpt-6.1-sol" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: item.arguments },
        { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
        COMPLETED,
    ];
}

/** A plan-route model whose fetch records each request and answers from a script. */
function fakePlanModel(replies: Array<() => Response>) {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
    const realFetch = globalThis.fetch;
    const server = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
        });
        const next = replies.shift();
        if (!next) throw new Error("unexpected extra request");
        return next();
    }) as typeof fetch;
    // chatgptPlanFetch calls the global fetch; route it to the fake for this model.
    const planFetch = chatgptPlanFetch(async () => "tok-123");
    const routed = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        globalThis.fetch = server;
        try {
            return await planFetch(input, init);
        } finally {
            globalThis.fetch = realFetch;
        }
    }) as typeof fetch;
    const model = wrapLanguageModel({
        model: createOpenAI({ apiKey: "placeholder", baseURL: "https://api.openai.com/v1", fetch: routed }).responses(
            "gpt-6.1-sol",
        ),
        middleware: chatgptPlanMiddleware,
    });
    return { model, requests };
}

const readTool = tool({
    description: "Read a file",
    inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
    }),
});

describe("plan-route requests", () => {
    test("a tool turn is namespaced, stateless, streamed and free of rejected fields", async () => {
        const { model, requests } = fakePlanModel([() => sse(toolCallReply())]);
        const result = streamText({
            model,
            system: "You are loop.",
            prompt: "read a.ts",
            tools: { read: readTool },
            maxOutputTokens: 4096,
            temperature: 0.2,
            providerOptions: { openai: { promptCacheRetention: "24h", user: "u", safetyIdentifier: "s" } },
        });
        const calls = await result.toolCalls;
        expect(calls.map((c) => [c.toolName, c.input])).toEqual([["read", { path: "a.ts" }]]);

        const [req] = requests;
        expect(req.url).toBe("https://api.openai.com/v1/responses");
        expect(req.headers.get("authorization")).toBe("Bearer tok-123");
        const body = req.body;
        expect(body.store).toBe(false);
        expect(body.stream).toBe(true);
        for (const field of [
            "max_output_tokens",
            "temperature",
            "top_p",
            "prompt_cache_retention",
            "user",
            "safety_identifier",
            "previous_response_id",
        ])
            expect(body).not.toHaveProperty(field);
        // No bare top-level function tools — one namespace holding them all.
        expect(body.tools).toHaveLength(1);
        expect(body.tools[0]).toMatchObject({ type: "namespace", name: CHATGPT_TOOL_NAMESPACE.name });
        expect(body.tools[0].tools.map((t: { name: string }) => t.name)).toEqual(["read"]);
        // The system prompt goes as a developer message, never a `system` item.
        expect(body.input.some((m: { role?: string }) => m.role === "system")).toBe(false);
        expect(body.input[0]).toMatchObject({ role: "developer" });
    });

    test("replayed tool calls carry the namespace even when history lost the metadata", async () => {
        const { model, requests } = fakePlanModel([() => sse(textReply("done"))]);
        await streamText({
            model,
            tools: { read: readTool },
            messages: [
                { role: "user", content: "read a.ts" },
                {
                    role: "assistant",
                    // As a transcript replays it: no providerOptions/metadata at all.
                    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } }],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            toolCallId: "call_1",
                            toolName: "read",
                            output: { type: "text", value: "contents" },
                        },
                    ],
                },
            ],
        }).text;
        const call = requests[0].body.input.find((i: { type?: string }) => i.type === "function_call");
        expect(call).toMatchObject({ call_id: "call_1", name: "read", namespace: "loop" });
    });

    test("generateText is served over a stream (the route requires stream:true)", async () => {
        const { model, requests } = fakePlanModel([() => sse(textReply("Hello, world!"))]);
        const { text, usage } = await generateText({ model, prompt: "Say exactly: Hello, world!" });
        expect(text).toBe("Hello, world!");
        expect(usage.outputTokens).toBe(2);
        expect(requests[0].body.stream).toBe(true);
    });

    test("a usage-limit error becomes an actionable message", async () => {
        const { model } = fakePlanModel([
            () =>
                new Response(
                    JSON.stringify({
                        error: {
                            message: "limit",
                            type: "usage",
                            code: "subscription_sharing_usage_limit_exceeded",
                            param: null,
                        },
                    }),
                    { status: 429, headers: { "content-type": "application/json" } },
                ),
        ]);
        await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow(/usage limit reached/i);
    });
});

describe("plan-route helpers", () => {
    test("sanitize drops rejected fields and pins store/stream", () => {
        expect(
            sanitizeChatgptPlanBody({ model: "m", temperature: 1, max_output_tokens: 5, store: true, stream: false }),
        ).toEqual({ model: "m", store: false, stream: true });
    });

    test("model list keeps only picker-visible entries in server order", () => {
        expect(
            parseChatgptModelList({
                models: [
                    {
                        slug: "gpt-6.1-sol",
                        display_name: "GPT-6.1 Sol",
                        visibility: "list",
                        context_window: 272000,
                        max_context_window: 872000,
                        input_modalities: ["text", "image"],
                    },
                    { slug: "internal", display_name: "Hidden", visibility: "hide" },
                    { slug: "gpt-6-mini", visibility: "list" },
                ],
            }),
        ).toEqual([
            { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", contextWindow: 272000, modalities: ["text", "image"] },
            { slug: "gpt-6-mini", displayName: "gpt-6-mini" },
        ]);
        expect(parseChatgptModelList({ data: [] })).toEqual([]);
    });

    test("unsupported-capability errors name the parameter", () => {
        expect(planErrorMessage({ code: "subscription_sharing_unsupported_capability", param: "tools[0]" })).toContain(
            "`tools[0]`",
        );
        expect(planErrorMessage({ code: "something_else" })).toBeUndefined();
    });
});
