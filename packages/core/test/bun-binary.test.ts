import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServer } from "../src/extensions/builtin/lsp/servers";

/**
 * A "node" language server runs on loop's own runtime (the binary as bun). The
 * desktop app runs core inside Electron's Node, where `process.execPath` is the
 * app itself — these pin which binary a launch spec names in each host.
 */

/** A project whose node_modules/.bin holds a (fake) vue-language-server. */
function projectWithVueServer(): string {
    const dir = mkdtempSync(join(tmpdir(), "loop-bun-binary-"));
    const bin = join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "vue-language-server"), "#!/bin/sh\n");
    chmodSync(join(bin, "vue-language-server"), 0o755);
    return dir;
}

/**
 * The vue server's launch command as a NON-bun host resolves it: core bundled
 * for Node exactly as apps/desktop bundles it, run by `node` in a subprocess.
 */
async function commandUnderNode(project: string, env: Record<string, string>): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), "loop-bun-binary-host-"));
    const entry = join(dir, "entry.ts");
    writeFileSync(
        entry,
        `import { resolveServer } from ${JSON.stringify(join(import.meta.dir, "../src/extensions/builtin/lsp/servers.ts"))};\n` +
            `console.log(JSON.stringify(resolveServer("vue", process.argv[2]!)?.command ?? null));\n`,
    );
    const built = await Bun.build({ entrypoints: [entry], outdir: dir, target: "node", format: "cjs", naming: "entry.cjs" });
    expect(built.success).toBe(true);
    const run = Bun.spawnSync(["node", join(dir, "entry.cjs"), project], {
        env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
    });
    expect(run.exitCode).toBe(0);
    return JSON.parse(run.stdout.toString().trim()) as string | null;
}

describe("the runtime a node language server is launched with", () => {
    test("under bun it is loop's own binary", () => {
        expect(resolveServer("vue", projectWithVueServer())?.command).toBe(process.execPath);
    });

    test.skipIf(!Bun.which("node"))("under another host it is the binary the host names, never the host", async () => {
        expect(await commandUnderNode(projectWithVueServer(), { LOOP_BUN_BINARY: "/opt/loop/bin/loop" })).toBe(
            "/opt/loop/bin/loop",
        );
    });

    test.skipIf(!Bun.which("node"))("under another host that names none, the server is not launched", async () => {
        expect(await commandUnderNode(projectWithVueServer(), {})).toBeNull();
    });
});
