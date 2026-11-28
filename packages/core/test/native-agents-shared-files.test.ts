/**
 * The native agents' JSON files in loop's home are shared by every loop
 * process on the machine. A process must never write back a stale copy of
 * one: that silently dropped another window's session links, so its next
 * turn re-sent the whole transcript instead of resuming. Here "another
 * process" is a write straight to the file between this process's calls.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "loop-shared-files-"));
const dir = join(home, ".loop");
const actualBrand = await import("../src/brand");
mock.module("../src/brand", () => ({ ...actualBrand, getConfigDir: () => dir }));

const { getSessionLink, setSessionLink } = await import("../src/providers/native-agents/shared");
const { cachedProbe } = await import("../src/providers/native-agents/probe-cache");

const LINKS = join(dir, "native-agent-sessions.json");
const PROBES = join(dir, "native-agents.json");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("files shared between loop processes", () => {
    test("a session link written by another process survives this one's write", () => {
        setSessionLink("claude-code", "mine", { nativeId: "a", seen: 1, updatedAt: 1 });
        // Another window links its own session.
        writeFileSync(LINKS, JSON.stringify({ ...readJson(LINKS), "claude-code:theirs": { nativeId: "b", seen: 2, updatedAt: 2 } }));
        setSessionLink("claude-code", "mine", { nativeId: "a2", seen: 3, updatedAt: 3 });
        expect(Object.keys(readJson(LINKS)).sort()).toEqual(["claude-code:mine", "claude-code:theirs"]);
    });

    test("a link another process moved on is read fresh", () => {
        setSessionLink("codex-cli", "shared", { nativeId: "old", seen: 1, updatedAt: 1 });
        expect(getSessionLink("codex-cli", "shared")?.nativeId).toBe("old");
        writeFileSync(LINKS, JSON.stringify({ ...readJson(LINKS), "codex-cli:shared": { nativeId: "new", seen: 4, updatedAt: 4 } }));
        expect(getSessionLink("codex-cli", "shared")?.nativeId).toBe("new");
    });

    test("a probe stored by another process survives this one's probe", async () => {
        await cachedProbe("claude-code", async () => ({ loggedIn: true }), { refresh: true });
        writeFileSync(PROBES, JSON.stringify({ ...readJson(PROBES), "cursor-agent": { value: { loggedIn: true }, ts: Date.now() } }));
        await cachedProbe("codex-cli", async () => ({ loggedIn: false }), { refresh: true });
        expect(Object.keys(readJson(PROBES)).sort()).toEqual(["claude-code", "codex-cli", "cursor-agent"]);
    });
});
