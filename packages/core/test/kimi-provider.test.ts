import { afterEach, describe, expect, mock, test } from "bun:test";

// In-memory replacement for the CachedStore-backed stores so tests NEVER touch
// the real ~/.loop/auth.json. Do not "isolate" by faking $HOME instead: Bun's
// os.homedir() ignores runtime HOME changes, so a faked HOME still resolves to
// the real config dir and writes clobber the user's actual credentials.
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

import { loginApiKey, logout } from "../src/auth";
import { isKimiSubscriptionKey, kimiBaseURL, kimiCacheFetch } from "../src/providers";
import { KIMI_CODE_MODELS } from "../src/catalog/fallbacks";

afterEach(() => {
    logout("kimi");
    delete process.env.KIMI_API_KEY;
    delete process.env.LOOP_KIMI_BASE_URL;
});

describe("kimi key-kind routing", () => {
    test("platform sk-… key → pay-per-token moonshot endpoint", () => {
        loginApiKey("kimi", "sk-0123456789abcdef");
        expect(isKimiSubscriptionKey()).toBe(false);
        expect(kimiBaseURL()).toBe("https://api.moonshot.ai/v1");
    });

    test("subscription sk-kimi-… key → Kimi Code endpoint", () => {
        loginApiKey("kimi", "sk-kimi-0123456789abcdef");
        expect(isKimiSubscriptionKey()).toBe(true);
        expect(kimiBaseURL()).toBe("https://api.kimi.com/coding/v1");
    });

    test("re-pasting the other key kind re-routes with no other change", () => {
        loginApiKey("kimi", "sk-kimi-sub");
        expect(kimiBaseURL()).toBe("https://api.kimi.com/coding/v1");
        loginApiKey("kimi", "sk-platform");
        expect(kimiBaseURL()).toBe("https://api.moonshot.ai/v1");
    });

    test("LOOP_KIMI_BASE_URL overrides both key kinds", () => {
        loginApiKey("kimi", "sk-kimi-sub");
        process.env.LOOP_KIMI_BASE_URL = "http://127.0.0.1:9999/v1";
        expect(kimiBaseURL()).toBe("http://127.0.0.1:9999/v1");
    });

    test("KIMI_API_KEY env fallback drives detection when nothing is stored", () => {
        process.env.KIMI_API_KEY = "sk-kimi-from-env";
        expect(isKimiSubscriptionKey()).toBe(true);
        delete process.env.KIMI_API_KEY;
        expect(isKimiSubscriptionKey()).toBe(false);
    });

    test("kimiCacheFetch maps JSON usage.cached_tokens → prompt_cache_hit/miss_tokens", async () => {
        using server = Bun.serve({
            port: 0,
            fetch: () =>
                Response.json({
                    choices: [],
                    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, cached_tokens: 900 },
                }),
        });
        const res = await kimiCacheFetch()(`http://127.0.0.1:${server.port}/v1/chat/completions`);
        const body = (await res.json()) as { usage: Record<string, number> };
        expect(body.usage.prompt_cache_hit_tokens).toBe(900);
        expect(body.usage.prompt_cache_miss_tokens).toBe(100);
        expect(body.usage.cached_tokens).toBe(900);
    });

    test("kimiCacheFetch rewrites SSE usage chunks and leaves other lines intact", async () => {
        const sse = [
            'data: {"choices":[{"delta":{"content":"hi"}}]}',
            "",
            'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":5,"cached_tokens":40}}',
            "",
            "data: [DONE]",
            "",
            "",
        ].join("\n");
        using server = Bun.serve({
            port: 0,
            fetch: () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
        });
        const res = await kimiCacheFetch()(`http://127.0.0.1:${server.port}/v1/chat/completions`);
        const text = await res.text();
        expect(text).toContain('"content":"hi"');
        expect(text).toContain("data: [DONE]");
        const usageLine = text.split("\n").find((l) => l.includes('"usage"'));
        const usage = (JSON.parse(usageLine!.slice("data: ".length)) as { usage: Record<string, number> }).usage;
        expect(usage.prompt_cache_hit_tokens).toBe(40);
        expect(usage.prompt_cache_miss_tokens).toBe(10);
    });

    test("kimiCacheFetch leaves DeepSeek-shaped usage (already has hit tokens) alone", async () => {
        using server = Bun.serve({
            port: 0,
            fetch: () =>
                Response.json({
                    usage: {
                        prompt_tokens: 100,
                        prompt_cache_hit_tokens: 60,
                        prompt_cache_miss_tokens: 40,
                        cached_tokens: 60,
                    },
                }),
        });
        const res = await kimiCacheFetch()(`http://127.0.0.1:${server.port}/v1/chat/completions`);
        const body = (await res.json()) as { usage: Record<string, number> };
        expect(body.usage.prompt_cache_hit_tokens).toBe(60);
        expect(body.usage.prompt_cache_miss_tokens).toBe(40);
    });

    test("subscription catalog seed carries the plan's model ids at cost 0", () => {
        expect(KIMI_CODE_MODELS.map((m) => m.id)).toEqual([
            "kimi/k3",
            "kimi/kimi-for-coding",
            "kimi/kimi-for-coding-highspeed",
        ]);
        for (const m of KIMI_CODE_MODELS) {
            expect(m.cost.input).toBe(0);
            expect(m.cost.output).toBe(0);
            expect(m.reasoning).toBe(true);
        }
    });
});
