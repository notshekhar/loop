import { describe, expect, test } from "bun:test";
import { SessionManager } from "../src/sessions";
import { handoffMessage, handoffGitStatus } from "../src/agent/handoff";
import { toModelMessages } from "../src/agent/model-messages";
import { useTempSessionDb } from "./helpers/temp-db";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

useTempSessionDb();

describe("handoff sessions", () => {
    test("persists only the brief and source link, with a new model and intact original", async () => {
        const manager = new SessionManager();
        const source = await manager.create({ cwd: "/tmp/handoff-project", provider: "xai", model: "xai/old" });
        await source.append({ type: "message", role: "user", content: "Long original request", ts: 1 });
        await source.append({ type: "message", role: "assistant", content: "Detailed tool history", ts: 2 });
        await source.setName("Fix endpoint validation");
        const before = JSON.stringify(source.entries());
        const brief = handoffMessage({
            sourceId: source.id,
            sourceLeaf: source.getLeafId(),
            cwd: source.info.cwd,
            brief: "## Next steps\nTest the validation change.",
        });
        const next = manager.createHandoff(source, {
            cwd: source.info.cwd,
            provider: "anthropic",
            model: "anthropic/new",
            brief,
        });
        const reopened = await manager.open(next.id);
        expect(reopened.id).not.toBe(source.id);
        expect(reopened.info.parentSession).toBe(source.path);
        expect(reopened.info.model).toBe("anthropic/new");
        expect(reopened.info.cwd).toBe(source.info.cwd);
        expect(reopened.getName()).toBe("Handoff: Fix endpoint validation");
        expect(reopened.getBranch().filter((e) => e.type === "message")).toHaveLength(1);
        const modelContext = JSON.stringify(toModelMessages(reopened));
        expect(modelContext).toContain("Test the validation change.");
        expect(modelContext).toContain(source.id);
        expect(modelContext).not.toContain("Detailed tool history");
        expect(JSON.stringify(source.entries())).toBe(before);
        expect((await manager.open(source.id)).entries()).toEqual(JSON.parse(before));
    });

    test("empty handoffs do not create a destination", async () => {
        const manager = new SessionManager();
        const source = await manager.create({ cwd: "/tmp/handoff-project", provider: "xai", model: "xai/old" });
        expect(() => manager.createHandoff(source, { ...source.info, brief: " " })).toThrow("empty");
        expect(manager.list(source.info.cwd)).toHaveLength(1);
        expect(() =>
            handoffMessage({ sourceId: source.id, sourceLeaf: null, cwd: source.info.cwd, brief: " " }),
        ).toThrow("empty");
    });

    test("Git snapshot describes live changes and handles non-repositories", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "loop-handoff-git-"));
        try {
            expect(await handoffGitStatus(cwd)).toContain("unavailable");
            execFileSync("git", ["init", "--quiet", cwd]);
            writeFileSync(join(cwd, "changed.ts"), "export const ready = true;\n");
            expect(await handoffGitStatus(cwd)).toContain("?? changed.ts");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
