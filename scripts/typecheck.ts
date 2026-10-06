/**
 * Typecheck every workspace in one pass.
 *
 * Nothing else in the repo does this. `bun build` and `vp build` both transpile
 * without checking, so a type error ships unless this runs — which is how
 * apps/web accumulated a missing import and a run of unreachable branches that
 * the compiler had been reporting to nobody.
 *
 *   bun run typecheck
 *
 * The two app packages are on tsgo (TypeScript 7's native binary, far faster on
 * a tree that size) and the library packages on plain tsc; the split is only
 * about which binary each package already has installed.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Target = { readonly label: string; readonly cwd: string; readonly bin: "tsc" | "tsgo"; readonly project?: string };

const TARGETS: readonly Target[] = [
    { label: "packages/core", cwd: ROOT, bin: "tsc", project: "packages/core/tsconfig.json" },
    { label: "packages/tui", cwd: ROOT, bin: "tsc", project: "packages/tui/tsconfig.json" },
    { label: "packages/cli", cwd: ROOT, bin: "tsc", project: "packages/cli/tsconfig.json" },
    { label: "packages/sandbox", cwd: ROOT, bin: "tsc", project: "packages/sandbox/tsconfig.json" },
    // The build scripts sit outside every package's `include`, so nothing was
    // reading them — which is how `import { $ } from "bun"` went missing from
    // build-bin.ts and only the release workflow found out, on the tag.
    { label: "build scripts", cwd: ROOT, bin: "tsc", project: "tsconfig.build-scripts.json" },
    { label: "apps/web", cwd: join(ROOT, "apps/web"), bin: "tsgo" },
    { label: "apps/desktop", cwd: join(ROOT, "apps/desktop"), bin: "tsgo" },
];

const failed: string[] = [];

for (const target of TARGETS) {
    const args = ["--noEmit", ...(target.project ? ["-p", target.project] : [])];
    process.stdout.write(`${target.label} … `);
    const result = spawnSync(join(target.cwd, "node_modules/.bin", target.bin), args, {
        cwd: target.cwd,
        encoding: "utf8",
        // A parent NODE_OPTIONS with a --require of a file that no longer exists
        // (some editors and terminal wrappers leave one behind) makes node die
        // before the compiler starts. Nothing here needs the parent's options.
        env: { ...process.env, NODE_OPTIONS: "" },
    });
    if (result.status === 0) {
        process.stdout.write("ok\n");
        continue;
    }
    process.stdout.write("FAILED\n");
    failed.push(target.label);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (output) console.error(`${output}\n`);
}

if (failed.length > 0) {
    console.error(`typecheck failed: ${failed.join(", ")}`);
    process.exit(1);
}
console.log("typecheck clean");
