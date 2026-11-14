/**
 * Bundles the desktop shell.
 *
 * Electron's main and preload both run in CommonJS, so Bun's `cjs` format is
 * not optional here: an ESM preload silently fails to load and the renderer
 * comes up with no `window.loop` at all — a symptom that looks like a broken
 * transport rather than a broken build.
 *
 * The renderer is copied in rather than referenced, so `dist/` is the whole
 * app and electron-builder has one directory to package. The three paths below
 * are the ones `src/main.ts` resolves against; they move together.
 */
import { chmod, cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const webDist = join(here, "..", "web", "dist");

/**
 * The compiled loop the app spawns, laid down next to the renderer.
 *
 * Without this the app depends on an *installed* loop (`~/.loop-bin/loop` and
 * friends), which is how a core change could ship in the UI and 404 at the
 * RPC until the user happened to reinstall — every `Method not found:
 * session.delete`-class bug came from that gap. Bundling makes the app
 * self-contained: one artifact, one version, no way for the two halves to
 * disagree.
 */
const binaryName = process.platform === "win32" ? "loop.exe" : "loop";
const cliBin = join(
  here,
  "..",
  "..",
  "packages",
  "cli",
  "dist",
  "bin",
  `${process.platform}-${process.arch}`,
  binaryName,
);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const main = await Bun.build({
  entrypoints: [join(here, "src", "main.ts")],
  outdir: join(dist, "main"),
  target: "node",
  format: "cjs",
  naming: "[dir]/app.cjs",
  // Electron resolves its own module at runtime; bundling it produces a
  // second, non-functional copy. node-pty is a native addon and cannot be
  // bundled at all — it must be require()d from node_modules.
  external: ["electron", "node-pty"],
});
if (!main.success) {
  throw new Error(`main bundle failed:\n${main.logs.map(String).join("\n")}`);
}

/**
 * The entry Electron starts (`main` in package.json): it switches on Node's
 * compile cache and only then requires `app.cjs` — see src/bootstrap.ts.
 */
const bootstrap = await Bun.build({
  entrypoints: [join(here, "src", "bootstrap.ts")],
  outdir: join(dist, "main"),
  target: "node",
  format: "cjs",
  naming: "[dir]/index.cjs",
  external: ["electron"],
});
if (!bootstrap.success) {
  throw new Error(`bootstrap bundle failed:\n${bootstrap.logs.map(String).join("\n")}`);
}

/**
 * The workspace host — git, terminals and the filesystem — as its own entry.
 *
 * A separate bundle because it is a separate process: `utilityProcess.fork`
 * takes a script path, and this is it. CommonJS for the same reason main is,
 * and node-pty stays external because a native addon cannot be bundled — it is
 * `require`d from the app's `node_modules`, which `package-app.ts` stages
 * alongside `dist/` so the resolution walks up to it from here exactly as it
 * does from `dist/main`.
 */
const host = await Bun.build({
  entrypoints: [join(here, "src", "host.ts")],
  outdir: join(dist, "host"),
  target: "node",
  format: "cjs",
  naming: "[dir]/index.cjs",
  external: ["electron", "node-pty"],
});
if (!host.success) {
  throw new Error(`host bundle failed:\n${host.logs.map(String).join("\n")}`);
}

const preload = await Bun.build({
  entrypoints: [join(here, "src", "preload.ts")],
  outdir: join(dist, "preload"),
  target: "node",
  format: "cjs",
  naming: "[dir]/index.cjs",
  external: ["electron"],
});
if (!preload.success) {
  throw new Error(`preload bundle failed:\n${preload.logs.map(String).join("\n")}`);
}

if (!(await exists(webDist))) {
  throw new Error(
    `apps/web is not built (${webDist} is missing). Run \`bun run --filter @loop/web build\` first.`,
  );
}
await cp(webDist, join(dist, "renderer"), { recursive: true });

/**
 * Not fatal when absent: a renderer-only rebuild is the common case during
 * development, and failing it would make `bun build.ts` depend on a 60s
 * binary build nobody asked for. The app falls back to an installed loop, and
 * says which one it used at startup.
 */
let bundledBinary: string | null = null;
if (await exists(cliBin)) {
  const target = join(dist, "bin", binaryName);
  await mkdir(join(dist, "bin"), { recursive: true });
  await cp(cliBin, target);
  // `cp` preserves mode on macOS/Linux, but not on every filesystem — and a
  // binary that lands 0644 fails to spawn with a bare EACCES.
  await chmod(target, 0o755);
  bundledBinary = target;
}

// The window icon for Linux and Windows. macOS reads the bundle's .icns
// instead, so a missing file there costs nothing — but on the other two an
// absent icon is the default Electron diamond, which is why this is copied
// rather than left to the packager.
const iconSource = join(here, "..", "..", "branding", "icon-512.png");
if (await exists(iconSource)) {
  await cp(iconSource, join(dist, "icon.png"));
}

console.log("desktop bundle ready:");
console.log(`  main     ${join(dist, "main", "index.cjs")} -> app.cjs`);
console.log(`  host     ${join(dist, "host", "index.cjs")}`);
console.log(`  preload  ${join(dist, "preload", "index.cjs")}`);
console.log(`  renderer ${join(dist, "renderer")}`);
console.log(
  bundledBinary
    ? `  loop     ${bundledBinary}`
    : `  loop     NOT BUNDLED (${cliBin} missing — run \`bun packages/cli/build-bin.ts\`); the app will use an installed loop`,
);
