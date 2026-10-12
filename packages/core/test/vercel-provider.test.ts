import { afterEach, describe, expect, mock, test } from "bun:test";

// In-memory replacement for the CachedStore-backed stores so tests NEVER touch
// the real ~/.loop/auth.json (see kimi-provider.test.ts for why faking $HOME
// does not work under Bun).
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

import { getApiKey, loginApiKey, logout } from "../src/auth";
import { isVercelChatModel } from "../src/catalog/vercel";

afterEach(() => {
    logout("vercel");
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_API_KEY;
});

describe("vercel gateway key resolution", () => {
    test("stored key wins", () => {
        loginApiKey("vercel", "vck_stored");
        process.env.AI_GATEWAY_API_KEY = "vck_env";
        expect(getApiKey("vercel")).toBe("vck_stored");
    });

    test("AI_GATEWAY_API_KEY env fallback when nothing is stored", () => {
        process.env.AI_GATEWAY_API_KEY = "vck_env";
        expect(getApiKey("vercel")).toBe("vck_env");
    });

    test("VERCEL_API_KEY is NOT used — that name carries platform/deploy tokens", () => {
        process.env.VERCEL_API_KEY = "platform-token";
        expect(getApiKey("vercel")).toBeUndefined();
    });
});

describe("vercel catalog chat-model filter", () => {
    test("keeps text-output chat models", () => {
        expect(isVercelChatModel("anthropic/claude-opus-4.8", ["text"])).toBe(true);
        expect(isVercelChatModel("openai/gpt-5.5", ["text"])).toBe(true);
        // missing output modalities defaults to text
        expect(isVercelChatModel("deepseek/deepseek-v3.2", undefined)).toBe(true);
        // "kling" must not catch Thinking Machines' inkling
        expect(isVercelChatModel("thinkingmachines/inkling", ["text"])).toBe(true);
    });

    test("drops media generators by output modality", () => {
        expect(isVercelChatModel("google/imagen-4.0-ultra-generate-001", ["image"])).toBe(false);
        expect(isVercelChatModel("klingai/kling-v3.0-t2v", ["video"])).toBe(false);
        expect(isVercelChatModel("openai/tts-1-hd", ["audio"])).toBe(false);
    });

    test("drops embeddings/rerankers/transcribers that claim text output", () => {
        expect(isVercelChatModel("openai/text-embedding-3-large", ["text"])).toBe(false);
        expect(isVercelChatModel("cohere/rerank-v4-pro", ["text"])).toBe(false);
        expect(isVercelChatModel("openai/whisper-1", ["text"])).toBe(false);
        expect(isVercelChatModel("openai/gpt-4o-transcribe", ["text"])).toBe(false);
        expect(isVercelChatModel("openai/gpt-realtime-2.1", ["text", "audio"])).toBe(false);
    });
});
