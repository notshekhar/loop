// The phone runs the same client code as the web app — contracts, shared,
// runtime and the handlers that answer it from loop — straight out of
// apps/web/src/loop. Its import aliases are the web app's, rebased here, so
// the two cannot drift: run this whenever apps/web/tsconfig.json gains one.
//
//   node scripts/sync-loop-aliases.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const webDir = join(here, "../web");
const raw = readFileSync(join(webDir, "tsconfig.json"), "utf8")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/,(\s*[}\]])/g, "$1");
const webPaths = JSON.parse(raw).compilerOptions.paths;
const rel = relative(here, webDir);

const paths = {};
for (const [alias, targets] of Object.entries(webPaths)) {
  if (!alias.startsWith("@loop/")) continue;
  paths[alias] = targets.map((target) => join(rel, target).replace(/\\/g, "/").replace(/^(?!\.)/, "./"));
}

const tsconfigPath = join(here, "tsconfig.json");
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
tsconfig.compilerOptions.paths = paths;
writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
console.log(`${Object.keys(paths).length} aliases from apps/web/tsconfig.json`);
