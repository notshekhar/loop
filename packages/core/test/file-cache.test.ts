import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { readTextCached } from "../src/agent/file-cache";

const dirs: string[] = [];
function mkTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "loop-file-cache-"));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("readTextCached", () => {
    test("missing files and directories read as null", () => {
        const dir = mkTmp();
        expect(readTextCached(join(dir, "nope.md"))).toBeNull();
        mkdirSync(join(dir, "sub"));
        expect(readTextCached(join(dir, "sub"))).toBeNull();
    });

    test("an edit always lands, even one that keeps the size", () => {
        const file = join(mkTmp(), "AGENTS.md");
        writeFileSync(file, "aaaa");
        expect(readTextCached(file)).toBe("aaaa");
        writeFileSync(file, "bbbb");
        // Same size: only the mtime tells the edit apart, so make sure it moved.
        utimesSync(file, new Date(), new Date(Date.now() + 5_000));
        expect(readTextCached(file)).toBe("bbbb");
    });

    test("a deleted file stops being served from the cache", () => {
        const file = join(mkTmp(), "MEMORY.md");
        writeFileSync(file, "index");
        expect(readTextCached(file)).toBe("index");
        rmSync(file);
        expect(readTextCached(file)).toBeNull();
    });
});
