import { describe, expect, test } from "bun:test";
import { SessionManager } from "../src/sessions";
import { useTempSessionDb } from "./helpers/temp-db";

// `session.list` pages for infinite scroll; `session.projects` keeps the
// folder list whole while it does.
describe("paged session lists", () => {
    useTempSessionDb();

    async function seed(manager: SessionManager): Promise<string[]> {
        const ids: string[] = [];
        for (let i = 0; i < 25; i++) {
            const s = await manager.create({ cwd: i < 5 ? "/old" : "/work", provider: "xai", model: "xai/grok" });
            ids.push(s.id);
        }
        return ids;
    }

    test("pages tile the whole list, newest first, with no gaps or repeats", async () => {
        const manager = new SessionManager();
        await seed(manager);
        const all = manager.list().map((s) => s.id);
        const paged = [
            ...manager.list(undefined, "active", { limit: 10 }),
            ...manager.list(undefined, "active", { limit: 10, offset: 10 }),
            ...manager.list(undefined, "active", { limit: 10, offset: 20 }),
        ].map((s) => s.id);
        expect(paged).toEqual(all);
        expect(manager.list(undefined, "active", { limit: 10, offset: 20 })).toHaveLength(5);
    });

    test("a folder pages on its own", async () => {
        const manager = new SessionManager();
        await seed(manager);
        const old = manager.list("/old", "active", { limit: 3 });
        expect(old).toHaveLength(3);
        expect(old.every((s) => s.cwd === "/old")).toBe(true);
    });

    test("by id, and an id that is not one is dropped, not run", async () => {
        const manager = new SessionManager();
        const ids = await seed(manager);
        expect(manager.list(undefined, "active", { ids: [ids[0]!, ids[3]!] }).map((s) => s.id).sort()).toEqual(
            [ids[0]!, ids[3]!].sort(),
        );
        expect(manager.list(undefined, "active", { ids: ["x' OR '1'='1"] })).toEqual([]);
        expect(manager.list(undefined, "active", { ids: [] })).toEqual([]);
    });

    test("every folder is listed with its count, however old", async () => {
        const manager = new SessionManager();
        await seed(manager);
        const folders = manager.folders();
        expect(folders.map((f) => [f.cwd, f.count]).sort()).toEqual([
            ["/old", 5],
            ["/work", 20],
        ]);
    });

    test("nonsense limits are ignored rather than interpolated", async () => {
        const manager = new SessionManager();
        await seed(manager);
        expect(manager.list(undefined, "active", { limit: -1 })).toHaveLength(25);
        expect(manager.list(undefined, "active", { limit: 1.5 })).toHaveLength(25);
    });
});
