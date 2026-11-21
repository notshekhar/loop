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
 * Uses `bun check` (Bun's built-in checker, TypeScript 7 semantics, every core)
 * rather than tsc/tsgo: the whole repo checks in about a second instead of
 * fifteen, and no TypeScript compiler has to be installed for it.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Target = { readonly label: string; readonly project: string };

const TARGETS: readonly Target[] = [
    { label: "packages/core", project: "packages/core" },
    { label: "packages/tui", project: "packages/tui" },
    { label: "packages/cli", project: "packages/cli" },
    { label: "packages/sandbox", project: "packages/sandbox" },
    // The build scripts sit outside every package's `include`, so nothing was
    // reading them — which is how `import { $ } from "bun"` went missing from
    // build-bin.ts and only the release workflow found out, on the tag.
    { label: "build scripts", project: "tsconfig.build-scripts.json" },
    { label: "apps/web", project: "apps/web" },
    { label: "apps/desktop", project: "apps/desktop" },
    // Also typechecks the apps/web client code it runs on the phone, through
    // the same @loop/* aliases — a change there that breaks mobile fails here.
    { label: "apps/mobile", project: "apps/mobile" },
];

/** Check one target, returning its diagnostics when it fails. */
function check(target: Target): string | undefined {
    const result = spawnSync(process.execPath, ["check", "--no-pretty", "-p", target.project], {
        cwd: ROOT,
        encoding: "utf8",
    });
    if (result.status === 0) return undefined;
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || `bun check exited ${result.status}`;
}

const failed: string[] = [];

for (const target of TARGETS) {
    process.stdout.write(`${target.label} … `);
    const errors = check(target);
    if (errors === undefined) {
        process.stdout.write("ok\n");
        continue;
    }
    process.stdout.write("FAILED\n");
    failed.push(target.label);
    console.error(`${errors}\n`);
}

if (failed.length > 0) {
    console.error(`typecheck failed: ${failed.join(", ")}`);
    process.exit(1);
}
console.log("typecheck clean");
