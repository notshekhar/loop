/**
 * An embedding app (app-profile.ts) brings its own tools, prompt, skills and
 * home directory while sharing loop's providers. These pin the seams it
 * depends on, so a change to loop that would quietly hand the app loop's own
 * tools, commands or files fails here first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSandboxDependencies, isSandboxSupported } from "@notshekhar/loop-sandbox";
import { setBashApprovalBridge } from "../src/tools/approval-bridge";
import { createBashTool } from "../src/tools/bash";

/** The OS sandbox exists here and its tooling is installed (bubblewrap on Linux). */
const sandboxUsable = isSandboxSupported() && checkSandboxDependencies().errors.length === 0;

let dir: string;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-app-profile-"));
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("app profile", () => {
    let result: Record<string, any>;

    beforeAll(() => {
        const home = join(dir, "home");
        const dataDir = join(dir, "app");
        mkdirSync(dataDir, { recursive: true });
        const child = Bun.spawnSync(["bun", join(import.meta.dir, "fixtures", "app-profile-child.ts"), dataDir], {
            env: { ...process.env, HOME: home },
        });
        if (child.exitCode !== 0) throw new Error(child.stderr.toString());
        result = JSON.parse(child.stdout.toString().trim().split("\n").pop() ?? "");
        result.home = home;
        result.expectedDataDir = dataDir;
    });

    test("loop is the default app and keeps its state in its config dir", () => {
        expect(result.loopDataDir).toBe(join(result.home, ".loop"));
        expect(result.dataDir).toBe(result.expectedDataDir);
    });

    test("fixed settings read their pinned value and ignore writes", () => {
        expect(result.subagents).toBe(false);
    });

    test("/settings offers neither pinned nor hidden settings", () => {
        expect(result.offered).toEqual({ subagents: false, serve: false, theme: true });
    });

    test("own settings live in the app's file, not the shared one", () => {
        expect(result.ownSettingsFile.mcpServers).toEqual({ probe: { command: "true" } });
        // The shared file exists (reading creates it with defaults) but never gets the key.
        expect(result.sharedSettingsFile.mcpServers).toBeUndefined();
    });

    test("sql datasources belong to the app", () => {
        expect(result.datasources).toEqual(["orders"]);
        expect(result.datasourcesFile).toEqual(["orders"]);
    });

    test("the app's tools replace loop's file tools", () => {
        expect(result.tools).toEqual(["probe"]);
    });

    test("the app's prompt replaces loop's persona, and a named agent's still wins", () => {
        expect(result.prompt).toBe("You are probe.");
        expect(result.agentPrompt).toBe("You are an agent.");
    });

    test("commands: hidden builtins go, agents go, the app's own arrive, skills answer to its prefix", () => {
        expect(result.commands).toEqual({
            sources: "probe's own command",
            debugging: true,
            prefixedSkill: false,
            help: expect.not.stringContaining("Shadow"),
            goal: false,
            agents: false,
            plan: true,
            data: false,
        });
    });
});

describe.skipIf(!sandboxUsable)("bash confined to its working directory", () => {
    const scratch = () => join(dir, "scratch");

    function run(command: string, reads: { denyRead?: string[]; allowRead?: string[] } = {}): Promise<string> {
        const bash = createBashTool({ cwd: scratch(), confineToCwd: { network: "deny", ...reads } });
        return (bash.execute as (i: unknown, o: unknown) => Promise<string>)({ command }, {});
    }

    beforeEach(() => {
        mkdirSync(scratch(), { recursive: true });
        // Other files leave an approval prompt registered; nobody is here to answer one.
        setBashApprovalBridge(null);
    });

    test("writes inside the working directory", async () => {
        await run("echo kept > note.txt");
        expect(readFileSync(join(scratch(), "note.txt"), "utf8")).toBe("kept\n");
    });

    test("cannot write beside it", async () => {
        const outside = join(dir, "outside.txt");
        await run(`echo leaked > ${outside}`).catch(() => "");
        expect(existsSync(outside)).toBe(false);
    });

    test("reads are narrowed by denyRead, with allowRead carving exceptions back out", async () => {
        const denied = join(dir, "private");
        mkdirSync(join(denied, "shared"), { recursive: true });
        writeFileSync(join(denied, "key"), "secret\n");
        writeFileSync(join(denied, "shared", "note"), "visible\n");
        const reads = { denyRead: [denied], allowRead: [join(denied, "shared")] };
        expect(await run(`cat ${join(denied, "shared", "note")}`, reads)).toContain("visible");
        const blocked = await run(`cat ${join(denied, "key")} || echo BLOCKED`, reads).catch((e) => String(e));
        expect(blocked).not.toContain("secret");
        expect(blocked).toContain("BLOCKED");
    });
});
