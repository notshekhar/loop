import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// In-memory store so the learned-shape file never lands in the real ~/.loop
// (see kimi-provider.test.ts: faking $HOME does not work under Bun).
class MemStore {
    private data: Record<string, unknown>;
    constructor(_id: string, defaults: Record<string, unknown> = {}) {
        this.data = structuredClone(defaults);
    }
    get all(): Record<string, unknown> {
        return this.data;
    }
    set all(value: Record<string, unknown>) {
        this.data = value;
    }
    get(key: string): unknown {
        return this.data[key];
    }
    set(key: string, value: unknown): void {
        this.data[key] = value;
    }
    delete(key: string): void {
        delete this.data[key];
    }
    refresh(): void {}
}

mock.module("../src/auth/storage", () => ({
    CachedStore: MemStore,
    authStore: new MemStore("auth", { providers: {}, active: null }),
    settingsStore: new MemStore("settings", {}),
    datasourcesStore: new MemStore("datasources", { connections: {} }),
}));

import {
    anthropicShapeFetch,
    applyShape,
    bodyShape,
    forgetShapes,
    learnedShape,
    shapeFromError,
} from "../src/providers/anthropic-shape";

// The verbatim rejection Anthropic returns for claude-opus-5 when the request
// carries thinking:{type:"enabled"} — which is what bifrost turns our
// thinking:{type:"adaptive"} into on the streaming path (measured 2026-07-27).
const ENABLED_UNSUPPORTED = JSON.stringify({
    type: "error",
    error: {
        type: "invalid_request_error",
        message:
            '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
    },
});

const BIFROST_CONVERT_FAIL = JSON.stringify({
    type: "error",
    error: { type: "api_error", message: "failed to convert bifrost request to the expected provider request body" },
});

beforeEach(() => forgetShapes());
afterEach(() => forgetShapes());

describe("bodyShape", () => {
    test("reads the wire form off the request body", () => {
        expect(
            bodyShape({
                thinking: { type: "adaptive", display: "summarized" },
                output_config: { effort: "high" },
            }),
        ).toBe("adaptive");
        // `display` is what separates the two adaptive forms.
        expect(bodyShape({ thinking: { type: "adaptive" }, output_config: { effort: "high" } })).toBe("adaptive-plain");
        expect(bodyShape({ output_config: { effort: "high" } })).toBe("omit");
        expect(bodyShape({ thinking: { type: "enabled", budget_tokens: 8192 } })).toBe("legacy");
        expect(bodyShape({ thinking: { type: "disabled" } })).toBe("disabled");
        expect(bodyShape({})).toBe("none");
    });
});

describe("applyShape", () => {
    test("adaptive → omit keeps the effort the user asked for", () => {
        const body = { model: "m", thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } };
        expect(applyShape(body, "omit")).toBe(true);
        expect(body.thinking).toBeUndefined();
        expect(body.output_config).toEqual({ effort: "xhigh" });
    });

    test("adaptive → legacy translates effort into a budget below max_tokens", () => {
        const body = { model: "m", max_tokens: 8000, thinking: { type: "adaptive" }, output_config: { effort: "max" } };
        expect(applyShape(body, "legacy")).toBe(true);
        expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 6976 });
        expect(body.output_config).toBeUndefined();
    });

    test("legacy → adaptive restores the effort field and asks for visible reasoning", () => {
        const body = { model: "m", thinking: { type: "enabled", budget_tokens: 8192 } };
        expect(applyShape(body, "adaptive", "low")).toBe(true);
        expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
        expect(body.output_config).toEqual({ effort: "low" });
    });

    test("adaptive → adaptive-plain drops only the display field", () => {
        const body = {
            model: "m",
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "high" },
        };
        expect(applyShape(body, "adaptive-plain")).toBe(true);
        expect(body.thinking).toEqual({ type: "adaptive" });
        expect(body.output_config).toEqual({ effort: "high" });
    });

    test("bare strips both fields", () => {
        const body = { model: "m", thinking: { type: "adaptive" }, output_config: { effort: "high" } };
        expect(applyShape(body, "bare")).toBe(true);
        expect(body.thinking).toBeUndefined();
        expect(body.output_config).toBeUndefined();
    });

    test("never turns thinking on for a request that asked for it off", () => {
        const off = { model: "m", thinking: { type: "disabled" } };
        expect(applyShape(off, "adaptive")).toBe(false);
        expect(off.thinking).toEqual({ type: "disabled" });
        const none = { model: "m" };
        expect(applyShape(none, "adaptive")).toBe(false);
        expect(none).toEqual({ model: "m" });
    });

    test("no-op when already in that shape", () => {
        expect(applyShape({ model: "m", output_config: { effort: "high" } }, "omit")).toBe(false);
    });
});

describe("shapeFromError", () => {
    test("adaptive rejected as 'enabled' → stop sending the field (a proxy rewrote it)", () => {
        expect(shapeFromError("adaptive", 400, ENABLED_UNSUPPORTED)).toBe("omit");
    });

    test("legacy rejected the same way → send the documented adaptive shape", () => {
        expect(shapeFromError("legacy", 400, ENABLED_UNSUPPORTED)).toBe("adaptive");
    });

    test("endpoint that only knows budget_tokens → legacy", () => {
        expect(shapeFromError("adaptive", 400, '"thinking.type.adaptive" is not supported for this model')).toBe(
            "legacy",
        );
    });

    test("output_config rejected → drop effort", () => {
        expect(shapeFromError("adaptive", 400, "output_config: unexpected field")).toBe("legacy");
        expect(shapeFromError("legacy", 400, "output_config: unexpected field")).toBe("bare");
    });

    test("thinking cannot be disabled here → let the model default", () => {
        expect(shapeFromError("adaptive", 400, '"thinking.type.disabled" is not supported for this model')).toBe(
            "omit",
        );
    });

    test("proxy that cannot serialize the field (500) → omit it", () => {
        expect(shapeFromError("adaptive", 500, BIFROST_CONVERT_FAIL)).toBe("omit");
        // …but only when we were actually sending it.
        expect(shapeFromError("omit", 500, BIFROST_CONVERT_FAIL)).toBeUndefined();
    });

    test("a rejected `display` costs the reasoning text, never the turn", () => {
        expect(shapeFromError("adaptive", 400, "thinking.display: unknown field")).toBe("adaptive-plain");
        // Already dropped — don't loop on it.
        expect(shapeFromError("adaptive-plain", 400, "thinking.display: unknown field")).toBeUndefined();
    });

    test("adaptive-plain hits the same proxy-rewrite rule as adaptive", () => {
        expect(shapeFromError("adaptive-plain", 400, ENABLED_UNSUPPORTED)).toBe("omit");
        expect(shapeFromError("adaptive-plain", 500, BIFROST_CONVERT_FAIL)).toBe("omit");
    });

    test("unrelated failures are not ours to rewrite", () => {
        expect(shapeFromError("adaptive", 401, "invalid x-api-key")).toBeUndefined();
        expect(shapeFromError("adaptive", 400, "max_tokens: must be >= 1")).toBeUndefined();
        expect(shapeFromError("adaptive", 529, "overloaded_error")).toBeUndefined();
        expect(shapeFromError("disabled", 400, ENABLED_UNSUPPORTED)).toBeUndefined();
    });
});

/** A fake Anthropic endpoint that accepts only one thinking shape. */
function fakeEndpoint(accepts: (body: Record<string, unknown>) => boolean, rejection = ENABLED_UNSUPPORTED) {
    const bodies: Array<Record<string, unknown>> = [];
    const fn = (async (_input: unknown, init?: RequestInit) => {
        if (typeof init?.body !== "string") return new Response(JSON.stringify({ ok: true }), { status: 200 });
        const body = JSON.parse(init.body) as Record<string, unknown>;
        bodies.push(body);
        return accepts(body)
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : new Response(rejection, { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fn, bodies };
}

const adaptiveBody = JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 32000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    stream: true,
});

describe("anthropicShapeFetch", () => {
    test("retries a rejected shape transparently and returns the successful response", async () => {
        const endpoint = fakeEndpoint((b) => b.thinking === undefined);
        const res = await anthropicShapeFetch("custom:gw", endpoint.fn)("http://x/v1/messages", {
            method: "POST",
            body: adaptiveBody,
        });
        expect(res.status).toBe(200);
        expect(endpoint.bodies).toHaveLength(2);
        expect(endpoint.bodies[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
        expect(endpoint.bodies[1].thinking).toBeUndefined();
        // Effort survives the correction — the turn still thinks as asked.
        expect(endpoint.bodies[1].output_config).toEqual({ effort: "high" });
    });

    test("remembers the working shape, so later requests cost one round trip", async () => {
        const endpoint = fakeEndpoint((b) => b.thinking === undefined);
        const shaped = anthropicShapeFetch("custom:gw", endpoint.fn);
        await shaped("http://x/v1/messages", { method: "POST", body: adaptiveBody });
        expect(learnedShape("custom:gw", "claude-opus-5")).toBe("omit");

        endpoint.bodies.length = 0;
        const res = await shaped("http://x/v1/messages", { method: "POST", body: adaptiveBody });
        expect(res.status).toBe(200);
        expect(endpoint.bodies).toHaveLength(1);
        expect(endpoint.bodies[0].thinking).toBeUndefined();
    });

    test("what is learned is scoped per provider — the same model behaves differently first-party", async () => {
        const gw = fakeEndpoint((b) => b.thinking === undefined);
        await anthropicShapeFetch("custom:gw", gw.fn)("http://x/v1/messages", { method: "POST", body: adaptiveBody });
        expect(learnedShape("custom:gw", "claude-opus-5")).toBe("omit");
        expect(learnedShape("anthropic", "claude-opus-5")).toBeUndefined();
    });

    test("a shape that works first time is never rewritten and nothing is learned", async () => {
        const endpoint = fakeEndpoint(() => true);
        const res = await anthropicShapeFetch("anthropic", endpoint.fn)("http://x/v1/messages", {
            method: "POST",
            body: adaptiveBody,
        });
        expect(res.status).toBe(200);
        expect(endpoint.bodies).toHaveLength(1);
        expect(learnedShape("anthropic", "claude-opus-5")).toBeUndefined();
    });

    test("an unrelated error reaches the caller intact, with its body readable", async () => {
        const endpoint = fakeEndpoint(() => false, JSON.stringify({ error: { message: "credit balance too low" } }));
        const res = await anthropicShapeFetch("anthropic", endpoint.fn)("http://x/v1/messages", {
            method: "POST",
            body: adaptiveBody,
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("credit balance too low");
        expect(endpoint.bodies).toHaveLength(1);
    });

    test("when the correction does not help, the original rejection is what surfaces", async () => {
        const endpoint = fakeEndpoint(() => false);
        const res = await anthropicShapeFetch("custom:gw", endpoint.fn)("http://x/v1/messages", {
            method: "POST",
            body: adaptiveBody,
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("thinking.type.enabled");
        expect(endpoint.bodies).toHaveLength(2);
        expect(learnedShape("custom:gw", "claude-opus-5")).toBeUndefined();
    });

    test("non-JSON bodies and non-message calls pass straight through", async () => {
        const endpoint = fakeEndpoint(() => true);
        const shaped = anthropicShapeFetch("anthropic", endpoint.fn);
        const res = await shaped("http://x/v1/models", { method: "GET" });
        expect(res.status).toBe(200);
        expect(endpoint.bodies).toHaveLength(0);
    });
});
