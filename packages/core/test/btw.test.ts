import { describe, expect, test } from "bun:test";
import { btwParentIn, btwParentOf, createBtwThread, SessionManager, type Session } from "../src/sessions";
import { toModelMessages } from "../src/agent/model-messages";
import { applyEvent, emptyTranscript, fromEntries } from "../src/transcript";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const CWD = "/tmp/btw-project";

function message(id: string, role: "user" | "assistant" | "tool", content: unknown): Entry {
    return { type: "message", role, content, ts: 1, id, parentId: null };
}

/** A named source chat with one exchange in it. */
async function sourceChat(manager: SessionManager): Promise<Session> {
    const source = await manager.create({ cwd: CWD, provider: "anthropic", model: "anthropic/m" });
    await source.setName("Fix the parser");
    await source.append({ type: "message", role: "user", content: "fix the parser", ts: 1 });
    await source.append({ type: "message", role: "assistant", content: "on it", ts: 2 });
    return source;
}

describe("createBtwThread", () => {
    test("starts a fresh, named thread that carries nothing of the source", async () => {
        const manager = new SessionManager();
        const source = await sourceChat(manager);
        const before = JSON.stringify(source.entries());

        const { session, meta } = await createBtwThread(manager, source, "why   is the lexer\nso slow?");

        expect(JSON.stringify(source.entries())).toBe(before);
        expect(meta).toEqual({ parentId: source.id, parentTitle: "Fix the parser" });
        const reopened = await manager.open(session.id);
        expect(reopened.getName()).toBe("btw: why is the lexer so slow?");
        expect(reopened.info.cwd).toBe(CWD);
        expect(reopened.getBranch().filter((e) => e.type === "message")).toHaveLength(0);
    });

    test("the model sees the question alone, exactly as typed", async () => {
        const manager = new SessionManager();
        const { session, meta } = await createBtwThread(manager, await sourceChat(manager), "what is a monad?");
        await session.append({ type: "message", role: "user", content: "what is a monad?", btw: meta, ts: 3 });

        expect(toModelMessages(session)).toEqual([{ role: "user", content: "what is a monad?" }]);
    });

    test("the question keeps its tag after a reload", async () => {
        const manager = new SessionManager();
        const { session, meta } = await createBtwThread(manager, await sourceChat(manager), "why?");
        await session.append({ type: "message", role: "user", content: "why?", btw: meta, ts: 2 });

        const question = (await manager.open(session.id)).getBranch().at(-1)!;
        expect(question.type === "message" && question.btw).toEqual(meta);
    });

    test("refuses an empty question", async () => {
        const manager = new SessionManager();
        expect(createBtwThread(manager, await sourceChat(manager), "  ")).rejects.toThrow("empty");
    });
});

describe("finding the way back", () => {
    test("a side thread names the session it was asked from", async () => {
        const manager = new SessionManager();
        const source = await sourceChat(manager);
        const { session, meta } = await createBtwThread(manager, source, "why?");
        await session.append({ type: "message", role: "user", content: "why?", btw: meta, ts: 2 });

        expect(btwParentIn(session.getBranch())?.parentId).toBe(source.id);
        const row = manager.list(CWD).find((r) => r.id === session.id)!;
        expect(btwParentOf(row)).toBe(source.id);
    });

    test("a plain fork, or a renamed side thread, is not one", () => {
        expect(btwParentOf({ name: "Fix it", parentSession: "/x/01ABC.jsonl" })).toBeNull();
        expect(btwParentOf({ name: "btw: why?" })).toBeNull();
        expect(btwParentIn([message("u1", "user", "hi")])).toBeNull();
    });
});

describe("transcript", () => {
    const btw = { parentId: "s1", parentTitle: "Fix the parser" };

    test("a saved side question carries where it was asked", () => {
        const transcript = fromEntries([{ ...message("u1", "user", "why?"), btw }]);
        expect(transcript.messages[0]!.metadata.btw).toEqual(btw);
    });

    test("the live user-message event carries it too", () => {
        const transcript = applyEvent(emptyTranscript(), {
            type: "user-message",
            data: { id: "u1", text: "why?", ts: 1, btw },
        });
        expect(transcript.messages[0]!.metadata.btw).toEqual(btw);
    });
});
