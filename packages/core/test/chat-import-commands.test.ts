/**
 * The chat-import extension's slash commands, driven through a scripted
 * picker: what reaches the preview, what it costs, and that a chat imported
 * once is found again. A fake home holds the agents' chats; loop's config
 * dir (so its settings) and session DB are temporary.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configHome = mkdtempSync(join(tmpdir(), "chat-import-config-"));
const actualBrand = await import("../src/brand");
mock.module("../src/brand", () => ({ ...actualBrand, getConfigDir: () => join(configHome, ".loop") }));

const { default: chatImport } = await import("../src/extensions/builtin/chat-import/index");
const { claudeProjectFolder } = await import("../src/extensions/builtin/chat-import/claude-code");
const { getBuiltin } = await import("../src/extensions/builtin");
const { SessionManager, recordChatImport } = await import("../src/sessions");
const { useTempSessionDb } = await import("./helpers/temp-db");
import type { ExtensionAPI } from "../src/extensions/api";
import type { ImportPreview, SlashCommand } from "../src/commands";

useTempSessionDb();
// The catalog prices the preview; its first build is slow cold, so pay it once here.
beforeAll(async () => {
    await (await import("../src/catalog")).getCatalog();
}, 30_000);

const CWD = "/work/my.app";
let home = "";
const lines = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Activate it with a scripted picker; LOOP_IMPORT_HOME points every reader at the fake home. */
function activate(
    pick: (items: Array<{ value: string; label: string; description?: string }>) => { value: string } | null,
) {
    const commands = new Map<string, SlashCommand>();
    const pickers: string[] = [];
    const api = {
        commands: { register: (cmd: SlashCommand) => commands.set(cmd.name, cmd) },
        ui: {
            search: async (items: Array<{ value: string; label: string }>, title?: string) => {
                pickers.push(title ?? "");
                return pick(items);
            },
        },
    } as unknown as ExtensionAPI;
    chatImport.activate!(api);
    return { commands, pickers };
}

async function run(command: SlashCommand, args: string) {
    const events: string[] = [];
    const previews: ImportPreview[] = [];
    const ctx = {
        cwd: CWD,
        emit: (event: string, data?: unknown) => events.push(`${event}: ${String(data ?? "")}`),
        previewImport: async (chat: ImportPreview) => {
            previews.push(chat);
        },
    };
    await command.handler(ctx as never, args);
    return { events, previews };
}

const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 50 };

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "chat-import-home-"));
    process.env.LOOP_IMPORT_HOME = home;
    const dir = join(home, ".claude", "projects", claudeProjectFolder(CWD));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "dddd-4444.jsonl"),
        lines([
            { uuid: "u1", parentUuid: null, type: "user", message: { role: "user", content: "hello there" } },
            {
                uuid: "a1",
                parentUuid: "u1",
                type: "assistant",
                timestamp: "2026-11-01T10:00:00Z",
                message: {
                    id: "msg_1",
                    model: "claude-sonnet-4-5",
                    role: "assistant",
                    content: [{ type: "text", text: "hi" }],
                    usage,
                },
            },
        ]),
    );
});
afterEach(() => {
    delete process.env.LOOP_IMPORT_HOME;
    rmSync(home, { recursive: true, force: true });
});

describe("the extension's commands", () => {
    test("registers one command per agent, and /import for all of them", () => {
        expect([...activate(() => null).commands.keys()].sort()).toEqual([
            "claude-import",
            "codex-import",
            "cursor-import",
            "import",
        ]);
    });

    test("bare: pick a chat from this folder, and it goes to the preview", async () => {
        const { commands, pickers } = activate((items) => items[0]);
        const { previews } = await run(commands.get("claude-import")!, "");
        expect(pickers).toEqual(["Claude Code chats in this folder"]);
        expect(previews.map((p) => [p.source, p.title, p.entries.length])).toEqual([["Claude Code", "hello there", 2]]);
    });

    test("the preview carries the chat's real token counts, priced, and where it came from", async () => {
        const { commands } = activate(() => null);
        const [chat] = (await run(commands.get("claude-import")!, "dddd-4444")).previews;
        expect(chat.origin).toEqual({ source: "claude-code", chatId: "dddd-4444" });
        expect(chat.cost).toMatchObject({
            inputTokens: 1010,
            outputTokens: 50,
            cacheReadTokens: 1000,
            approximate: false,
        });
        expect(chat.cost.calls.map((c) => [c.model, c.ts, c.estimated])).toEqual([
            ["claude-code/claude-sonnet-4-5", Date.parse("2026-11-01T10:00:00Z"), false],
        ]);
        expect(chat.cost.usd).toBeGreaterThan(0);
        expect(chat.importedAs).toBeUndefined();
    });

    test("/import lists every agent's chats in one picker, and the pick previews from its own agent", async () => {
        const { commands, pickers } = activate(
            (items) => items.find((i) => i.value === "claude-code:dddd-4444") ?? null,
        );
        const { previews } = await run(commands.get("import")!, "");
        expect(pickers).toEqual(["Chats in this folder"]);
        expect(previews.map((p) => p.origin)).toEqual([{ source: "claude-code", chatId: "dddd-4444" }]);
    });

    test("a chat imported before is marked in the picker and previews as already imported", async () => {
        const session = await new SessionManager().create({ cwd: CWD, provider: "xai", model: "xai/m" });
        recordChatImport({ source: "claude-code", chatId: "dddd-4444", sessionPub: session.id, cwd: CWD, calls: [] });
        let described: string | undefined;
        const { commands } = activate((items) => {
            described = items[0]?.description;
            return items[0];
        });
        const { previews } = await run(commands.get("claude-import")!, "");
        expect(described).toContain("imported");
        expect(previews[0].importedAs).toBe(session.id);
    });

    test("with an id: no picker, straight to the preview", async () => {
        const { commands, pickers } = activate(() => null);
        const { previews } = await run(commands.get("claude-import")!, "dddd-4444");
        expect(pickers).toEqual([]);
        expect(previews).toHaveLength(1);
    });

    test("an unknown id says so, and nothing is previewed", async () => {
        const { commands } = activate(() => null);
        const { events, previews } = await run(commands.get("claude-import")!, "nope");
        expect(previews).toEqual([]);
        expect(events).toEqual(["error: no Claude Code chat with id nope"]);
    });

    test("a folder with no chats says how to import one from elsewhere instead of an empty picker", async () => {
        const { commands, pickers } = activate(() => null);
        const { events } = await run(commands.get("codex-import")!, "");
        expect(pickers).toEqual([]);
        expect(events[0]).toContain("no Codex chats in /work/my.app");
        expect(events[0]).toContain("/codex-import <session id>");
    });

    test("ships as a builtin, off until enabled", () => {
        expect(getBuiltin("chat-import")?.defaultEnabled).toBe(false);
    });
});
