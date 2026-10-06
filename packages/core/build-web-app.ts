/**
 * Build-time half of serve's UI: build `apps/web` if it has not been, pack it
 * (src/rpc/web-app-pack.ts), and give the bundler a plugin that resolves
 * `loop:web-app-pack` to it.
 *
 * Two shapes, because the two artifacts find files differently:
 *   - "compile" (`bun --compile` binaries): the pack is embedded with the
 *     `file` loader and imported as its `$bunfs` path.
 *   - "dist" (core's npm build): the pack is written beside the bundle, and
 *     the module computes its path from `import.meta.url` — a `file` loader
 *     import would be relative to the process's cwd, not the module.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import { $ } from "bun";
import { packWebApp } from "./src/rpc/web-app-pack";

const REPO = join(import.meta.dir, "..", "..");
const WEB_DIST = join(REPO, "apps", "web", "dist");

/** `apps/web/dist`, built first if it is not there. */
async function ensureWebBuild(): Promise<string> {
    if (!existsSync(join(WEB_DIST, "index.html"))) {
        console.log("▶ building apps/web (serve's UI)");
        await $`bun run --filter @loop/web build`.cwd(REPO);
    }
    if (!existsSync(join(WEB_DIST, "index.html"))) throw new Error(`apps/web build produced no ${WEB_DIST}/index.html`);
    return WEB_DIST;
}

export async function webAppPackPlugin(mode: "compile" | "dist", outDir: string): Promise<BunPlugin> {
    const packed = packWebApp(await ensureWebBuild());
    mkdirSync(outDir, { recursive: true });
    const packPath = join(outDir, "web-app.pack");
    writeFileSync(packPath, packed);
    console.log(`  web UI packed: ${(packed.length / 1e6).toFixed(1)} MB → ${packPath}`);

    return {
        name: "loop-web-app-pack",
        setup(build) {
            build.onResolve({ filter: /^loop:web-app-pack$/ }, () =>
                mode === "compile" ? { path: packPath } : { path: "web-app-pack", namespace: "loop-web-app-pack" },
            );
            if (mode === "compile") {
                build.onLoad({ filter: /web-app\.pack$/ }, () => ({ contents: packed, loader: "file" }));
            } else {
                build.onLoad({ filter: /.*/, namespace: "loop-web-app-pack" }, () => ({
                    contents: `import { fileURLToPath } from "node:url";
export default fileURLToPath(new URL("./web-app.pack", import.meta.url));`,
                    loader: "js",
                }));
            }
        },
    };
}
