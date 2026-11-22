import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, setDbPathForTests, type Session } from "@notshekhar/loop-core";
import { createRefreshHandlers } from "../src/interactive/handlers/session-refresh";
import type { AppDeps } from "../src/interactive/deps";
import type { AppState } from "../src/interactive/state";
import { initTheme } from "../src/interactive/ui/theme";

// Our own temp agent.db (never ~/.loop's), whose path the second process needs.
let dir = "";
let dbPath = "";
beforeEach(() => {
    initTheme("dark");
    dir = mkdtempSync(join(tmpdir(), "loop-refresh-"));
    dbPath = join(dir, "agent.db");
    setDbPathForTests(dbPath);
});
afterEach(() => {
    setDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
});

/**
 * The "other terminal": a separate bun process that opens the same session in
 * the same database and adds a user message, exactly as a second loop would.
 */
async function appendFromAnotherProcess(sessionId: string, text: string): Promise<void> {
    const script = `
        import { SessionManager, setDbPathForTests } from "@notshekhar/loop-core";
        setDbPathForTests(process.env.DB_PATH);
        const session = await new SessionManager().open(process.env.SESSION_ID);
        await session.append({ type: "message", role: "user", content: process.env.TEXT, ts: Date.now() });
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
        cwd: import.meta.dir,
        env: { ...process.env, DB_PATH: dbPath, SESSION_ID: sessionId, TEXT: text },
        stderr: "pipe",
    });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

async function harness() {
    // No model on the session: showLoadedSession would otherwise save it as
    // the default model in the real ~/.loop/settings.json.
    const session = await new SessionManager().create({ cwd: "/tmp/refresh-ui", provider: "xai", model: "" });
    await session.append({ type: "message", role: "user", content: "first question", ts: 1 });
    const state = { session, modelId: "", cwd: session.info.cwd, busy: false } as unknown as AppState;
    const notices: string[] = [];
    const users: string[] = [];
    // Everything the transcript redraw touches is a no-op; only what the user
    // would read is recorded.
    const history = new Proxy(
        { addSystem: (t: string) => notices.push(t), addUser: (t: string) => users.push(t) },
        { get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? (() => {}) },
    );
    const deps = {
        manager: new SessionManager(),
        history,
        tui: { requestRender: () => {}, setTitle: () => {} },
        statusLine: { setSession: () => {}, setModel: () => {} },
        tracker: { seedFromSession: () => ({ ctxTokens: 0 }) },
        todoPanel: { clear: () => {}, setItems: () => {} },
        shellsPanel: { setShells: () => {} },
        refreshStatusLine: () => {},
        live: { feed: null },
    } as unknown as AppDeps;
    return { state, notices, users, refresh: createRefreshHandlers(state, deps).refreshSession, session };
}

const userTexts = (s: Session) =>
    s.getBranch().flatMap((e) => (e.type === "message" && e.role === "user" ? [String(e.content)] : []));

describe("/refresh", () => {
    test("picks up a turn another process added and redraws it", async () => {
        const h = await harness();
        await appendFromAnotherProcess(h.session.id, "asked in the other terminal");

        await h.refresh();

        expect(h.state.session).not.toBe(h.session);
        expect(userTexts(h.state.session!)).toEqual(["first question", "asked in the other terminal"]);
        expect(h.users).toContain("asked in the other terminal");
        expect(h.notices.at(-1)).toBe(`refreshed session ${h.session.id} · 1 new`);
        expect(h.state.session!.isBehindDisk()).toBe(false);
    });

    test("says so and keeps the same object when nothing changed", async () => {
        const h = await harness();
        await h.refresh();
        expect(h.state.session).toBe(h.session);
        expect(h.notices).toEqual(["already up to date"]);
    });

    test("refuses mid-turn so the running reply isn't cut from the saved branch", async () => {
        const h = await harness();
        await appendFromAnotherProcess(h.session.id, "later");
        h.state.busy = true;
        await h.refresh();
        expect(h.state.session).toBe(h.session);
        expect(h.notices).toEqual(["can't refresh while a turn is running"]);
    });
});
