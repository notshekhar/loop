#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { webAppPackPlugin } from "./build-web-app";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
};
const externals = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    // optionalDependencies must stay external: claude-agent-sdk resolves its
    // vendored cli.js relative to its own package dir — bundling breaks the spawn.
    ...Object.keys(pkg.optionalDependencies ?? {}),
    "node:*",
    // `bun` builtin (Bun.SQL for datasources) — resolved at runtime under Bun.
    "bun",
    // The pty uses openpty(3) through bun:ffi. Bundling a Bun builtin would
    // break the module graph; it resolves at runtime like `bun` above.
    "bun:ffi",
];

// serve's UI (apps/web, the desktop app's React app) ships packed beside the
// bundle, so an npm install serves it without the workspace on disk.
const outdir = join(import.meta.dir, "dist");
const webApp = await webAppPackPlugin("dist", outdir);

const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/index.ts")],
    outdir,
    target: "node",
    format: "esm",
    minify: { whitespace: true, identifiers: false, syntax: true },
    external: externals,
    plugins: [webApp],
});

if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}

console.log(`built core (${result.outputs.length} files)`);
