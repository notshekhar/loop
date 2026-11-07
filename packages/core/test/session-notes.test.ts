import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDbPathForTests } from "../src/sessions/db";
import { addNote, clearNotes, listNotes, takeNote } from "../src/sessions/notes";
import { SessionManager } from "../src/sessions/manager";

describe("session notes", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-notes-"));
        setDbPathForTests(join(dir, "agent.db"));
    });
    afterEach(() => {
        setDbPathForTests(null);
        rmSync(dir, { recursive: true, force: true });
    });

    test("each session keeps its own notes, oldest first", () => {
        addNote("a", "first");
        addNote("b", "other session");
        addNote("a", "second");
        expect(listNotes("a").map((n) => n.text)).toEqual(["first", "second"]);
        expect(listNotes("b").map((n) => n.text)).toEqual(["other session"]);
    });

    test("taking a note removes it and returns it once", () => {
        const note = addNote("a", "send me");
        expect(takeNote("a", note.id)?.text).toBe("send me");
        expect(takeNote("a", note.id)).toBeUndefined();
        expect(listNotes("a")).toEqual([]);
    });

    test("a note can only be taken from its own session", () => {
        const note = addNote("a", "mine");
        expect(takeNote("b", note.id)).toBeUndefined();
        expect(listNotes("a")).toHaveLength(1);
    });

    test("remove all clears one session and leaves the others", () => {
        addNote("a", "1");
        addNote("a", "2");
        addNote("b", "keep");
        expect(clearNotes("a")).toBe(2);
        expect(listNotes("a")).toEqual([]);
        expect(listNotes("b")).toHaveLength(1);
    });

    test("deleting a session deletes its notes", async () => {
        const manager = new SessionManager();
        const session = await manager.create({ cwd: dir, provider: "p", model: "p/m" });
        addNote(session.id, "goes with it");
        expect(manager.delete(session.id)).toBe(true);
        expect(listNotes(session.id)).toEqual([]);
    });
});
