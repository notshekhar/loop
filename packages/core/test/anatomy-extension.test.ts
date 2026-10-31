import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import anatomy, { anatomyCommand } from "../src/extensions/builtin/anatomy/index";
import { ANATOMY_COMMIT, ensureSkill, isInstalled, skillDir } from "../src/extensions/builtin/anatomy/source";
import { getBuiltin } from "../src/extensions/builtin";
import type { ExtensionAPI } from "../src/extensions/api";
import type { SlashCommand } from "../src/commands";

const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
const SKILL_MD = "---\nname: anatomy\ndescription: test\n---\n\n# Anatomy\n\nThe object is the explanation.\n";

const realFetch = globalThis.fetch;
// Every download goes under a temp root: Bun ignores a reassigned HOME, so
// the real ~/.loop is only reachable through the default root, never here.
let root = "";
let archive: Uint8Array;
let fetches = 0;

/** A GitHub-shaped archive: one top-level <repo>-<commit> folder holding the skill. */
function buildArchive(): Uint8Array {
    const root = mkdtempSync(join(tmpdir(), "anatomy-archive-"));
    const top = join(root, `anatomy-${ANATOMY_COMMIT}`);
    mkdirSync(join(top, "kit"), { recursive: true });
    writeFileSync(join(top, "SKILL.md"), SKILL_MD);
    writeFileSync(join(top, "kit", "audit.mjs"), "export {};\n");
    const out = join(root, "a.tar.gz");
    spawnSync("tar", ["-czf", out, "-C", root, `anatomy-${ANATOMY_COMMIT}`]);
    const bytes = new Uint8Array(readFileSync(out));
    rmSync(root, { recursive: true, force: true });
    return bytes;
}

function serve(status = 200) {
    globalThis.fetch = (async (url: unknown) => {
        fetches++;
        expect(String(url)).toContain(ANATOMY_COMMIT);
        return new Response(status === 200 ? archive : "nope", { status });
    }) as unknown as typeof fetch;
}

function command() {
    return anatomyCommand(() => root);
}

async function run(command: SlashCommand, args: string) {
    const events: { event: string; data: string }[] = [];
    const ctx = {
        emit: (event: string, data?: unknown) => events.push({ event, data: String(data ?? "") }),
        cwd: root,
    };
    await command.handler(ctx as never, args);
    return events;
}

beforeAll(() => {
    archive = buildArchive();
});
afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
    globalThis.fetch = realFetch;
});

function freshRoot() {
    root = mkdtempSync(join(tmpdir(), "anatomy-root-"));
    fetches = 0;
}

describe("anatomy", () => {
    test("/anatomy downloads the pinned skill once and submits it as a skill turn", async () => {
        freshRoot();
        serve();
        const anatomyCmd = command();
        expect(anatomyCmd.name).toBe("anatomy");

        const first = await run(anatomyCmd, "how a hash map resolves collisions");
        expect(first.map((e) => e.event)).toEqual(["help", "inject-skill"]);
        const match = first[1].data.match(SKILL_BLOCK_RE);
        expect(match).not.toBeNull();
        const [, name, location, body, args] = match!;
        expect(name).toBe("anatomy");
        expect(location).toBe(join(skillDir(root), "SKILL.md"));
        expect(body).toContain(`References are relative to ${skillDir(root)}.`);
        expect(body).toContain("The object is the explanation.");
        expect(body).not.toContain("description: test");
        expect(args).toBe("how a hash map resolves collisions");
        expect(existsSync(join(skillDir(root), "kit", "audit.mjs"))).toBe(true);

        const again = await run(anatomyCmd, "");
        expect(again.map((e) => e.event)).toEqual(["inject-skill"]);
        expect(fetches).toBe(1);
    });

    test("concurrent first uses share one download, and older pins are removed", async () => {
        freshRoot();
        serve();
        const stale = join(skillDir(root), "..", "0000000000ab");
        mkdirSync(stale, { recursive: true });
        await Promise.all([ensureSkill(root), ensureSkill(root)]);
        expect(fetches).toBe(1);
        expect(isInstalled(root)).toBe(true);
        expect(existsSync(stale)).toBe(false);
    });

    test("a failed download reports an error, submits nothing and leaves nothing half-made", async () => {
        freshRoot();
        serve(404);
        const events = await run(command(), "a lock");
        expect(events.map((e) => e.event)).toEqual(["help", "error"]);
        expect(events[1].data).toContain("HTTP 404");
        expect(isInstalled(root)).toBe(false);
        expect(readdirSync(root)).toEqual([]);
    });

    test("ships enabled: it adds a command and nothing else", () => {
        let registered: SlashCommand | undefined;
        // No `turn` on the double: an extension that hooked the system prompt
        // would throw here. Anatomy must only ever add a command.
        const api = {
            extension: { setStatus: () => {} },
            commands: { register: (cmd: SlashCommand) => (registered = cmd) },
        } as unknown as ExtensionAPI;
        anatomy.activate(api);
        expect(registered?.name).toBe("anatomy");
        const builtin = getBuiltin("anatomy");
        expect(builtin?.defaultEnabled).toBe(true);
        expect(builtin?.module).toBe(anatomy);
    });
});
