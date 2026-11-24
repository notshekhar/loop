/**
 * Previewing an imported chat, then saving or discarding it — against a real
 * session store (temp database) and the real transcript.
 *
 * The promise under test: the preview draws the chat exactly as replay would,
 * nothing reaches the database until Save, Save gives a session in this
 * folder that is the live one, and Discard puts back what was on screen.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";
import { SessionManager, type Entry, type ImportPreview } from "@notshekhar/loop-core";
import { useTempSessionDb } from "../../core/test/helpers/temp-db";
import { ChatHistory } from "../src/interactive/components/chat-history";
import { createImportPreviewHandlers } from "../src/interactive/handlers/import-preview-handlers";
import type { AppDeps } from "../src/interactive/deps";
import type { AppState } from "../src/interactive/state";
import { initTheme } from "../src/interactive/ui/theme";

useTempSessionDb();
beforeEach(() => initTheme("night"));

const CWD = "/tmp/import-preview";
const tui = { requestRender() {}, resetFrame() {}, setTitle() {} } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07|\x1b\]133;[A-Z]\x07/g, "");

const CHAT: ImportPreview = {
    source: "Claude Code",
    title: "Count the files",
    entries: [
        { type: "message", role: "user", content: "how many files?", ts: 1 },
        {
            type: "message",
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: { command: "ls | wc -l" } }],
            ts: 2,
        },
        {
            type: "message",
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "t1", toolName: "bash", output: { type: "text", value: "3" } }],
            ts: 3,
        },
        { type: "message", role: "assistant", content: [{ type: "text", text: "There are three." }], ts: 4 },
    ] as Entry[],
};

async function harness(answer: "save" | "discard" | null) {
    const manager = new SessionManager();
    const existing = await manager.create({ cwd: CWD, provider: "xai", model: "xai/m" });
    await existing.append({ type: "message", role: "user", content: "the chat I had open", ts: 1 });
    const history = new ChatHistory(tui, CWD);
    history.addUser("the chat I had open");
    const state = {
        session: existing,
        modelId: "xai/m",
        provider: "xai",
        cwd: CWD,
        busy: false,
    } as unknown as AppState;
    const menus: string[] = [];
    let previewOnScreen = "";
    let sessionsWhileAsking = -1;
    const deps = {
        manager,
        history,
        tui,
        statusLine: { setSession() {}, setModel() {} },
        tracker: { seedFromSession: () => ({ ctxTokens: 0 }) },
        refreshStatusLine() {},
        shellsPanel: { setShells() {} },
        todoPanel: { setItems() {}, clear() {} },
        sessions: { findLive: () => undefined, openNew: async () => {} },
        live: {},
        selectOnce: async (items: Array<{ value: string }>, title?: string) => {
            menus.push(title ?? "");
            // What the user is looking at while the menu is open.
            previewOnScreen = history.render(100).map(strip).join("\n");
            sessionsWhileAsking = manager.list(CWD).length;
            return answer ? (items.find((i) => i.value === answer) ?? null) : null;
        },
    } as unknown as AppDeps;
    const handlers = createImportPreviewHandlers(state, deps);
    const screen = () => history.render(100).map(strip).join("\n");
    const sessionsHere = () => manager.list(CWD).length;
    return {
        handlers,
        state,
        screen,
        menus,
        existing,
        sessionsHere,
        preview: () => previewOnScreen,
        sessionsWhileAsking: () => sessionsWhileAsking,
    };
}

describe("import preview", () => {
    test("the chat is drawn before anything is asked, and nothing is saved yet", async () => {
        const h = await harness(null);
        const before = h.sessionsHere();
        await h.handlers.previewImport(CHAT);
        expect(h.menus).toEqual(["Import “Count the files”?"]);
        expect(h.preview()).toContain("Preview · Claude Code chat “Count the files”");
        expect(h.preview()).toContain("how many files?");
        expect(h.preview()).toContain("There are three.");
        expect(h.preview()).not.toContain("the chat I had open");
        expect(h.sessionsWhileAsking()).toBe(before);
    });

    test("Save makes it a session in this folder, named, and the live one", async () => {
        const h = await harness("save");
        const before = h.sessionsHere();
        await h.handlers.previewImport(CHAT);
        expect(h.sessionsHere()).toBe(before + 1);
        expect(h.state.session).not.toBe(h.existing);
        const saved = h.state.session!;
        expect(saved.info.cwd).toBe(CWD);
        expect(saved.getName()).toBe("Count the files");
        const messages = saved.getBranch().filter((e) => e.type === "message");
        expect(messages.map((e) => (e.type === "message" ? e.role : ""))).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(h.screen()).toContain("There are three.");
        expect(h.screen()).toContain("Saved the Claude Code chat");
        // The preview's entries were copied, not stamped in place.
        expect(CHAT.entries[0].id).toBeUndefined();
    });

    test("Discard (or Esc) puts the open chat back and saves nothing", async () => {
        for (const answer of ["discard", null] as const) {
            const h = await harness(answer);
            const before = h.sessionsHere();
            await h.handlers.previewImport(CHAT);
            expect(h.state.session).toBe(h.existing);
            expect(h.sessionsHere()).toBe(before);
            expect(h.screen()).toContain("the chat I had open");
            expect(h.screen()).not.toContain("There are three.");
            expect(h.screen()).toContain("nothing was saved");
        }
    });

    test("a running turn is never replaced by a preview", async () => {
        const h = await harness("save");
        h.state.busy = true;
        await h.handlers.previewImport(CHAT);
        expect(h.menus).toEqual([]);
        expect(h.state.session).toBe(h.existing);
    });
});
