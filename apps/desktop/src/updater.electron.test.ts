/**
 * The install swap, run inside real Electron — the only place its asar layer exists.
 *
 * Under bun `fs` has no asar layer, so updater.test.ts could never see the bug
 * this guards: Electron's `fs` reads `app.asar` as a directory, and deleting an
 * old install through it took 78s and then failed with ENOTEMPTY, leaving
 * `Loop.app.old` behind holding only its archive. So this bundles the updater,
 * runs it with `ELECTRON_RUN_AS_NODE=1`, and swaps over a backup that has an
 * archive in it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electronBinary = (() => {
  try {
    return createRequire(import.meta.url)("electron") as string;
  } catch {
    return null;
  }
})();

/** Enough entries that walking them one failed unlink at a time is slow. */
const ARCHIVE_ENTRIES = 300;
/** The swap is a few renames and deletes; the bug took over a minute. */
const SWAP_BUDGET_MS = 15_000;

/** A minimal real asar: a pickled JSON header, then the file bytes. */
function asarArchive(entries: number): Buffer {
  const body = Buffer.from("x");
  const files: Record<string, { size: number; offset: string }> = {};
  for (let i = 0; i < entries; i++) files[`file-${i}.js`] = { size: body.length, offset: "0" };
  const json = Buffer.from(JSON.stringify({ files }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const headerPickle = Buffer.alloc(8 + padded.length);
  headerPickle.writeUInt32LE(4 + padded.length, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  padded.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, body]);
}

async function makeBundle(root: string, marker: string): Promise<void> {
  const resources = join(root, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, "app.asar"), asarArchive(ARCHIVE_ENTRIES));
  await writeFile(join(root, "Contents", "marker"), marker);
}

let workDir: string | null = null;
afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = null;
});

describe.skipIf(!electronBinary)("swapInstall under Electron", () => {
  test(
    "replaces a bundle whose leftover backup holds an app.asar, quickly and completely",
    async () => {
      workDir = await mkdtemp(join(tmpdir(), "loop-swap-electron-"));
      const root = join(workDir, "Loop.app");
      const staged = join(workDir, "staged", "Loop.app");
      await makeBundle(root, "old");
      await makeBundle(`${root}.old`, "older");
      await makeBundle(staged, "new");

      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "updater.ts")],
        outdir: join(workDir, "bundle"),
        target: "node",
        format: "cjs",
        external: ["original-fs"],
      });
      expect(build.success).toBe(true);
      const script = join(workDir, "swap.cjs");
      await writeFile(
        script,
        `const { swapInstall } = require(${JSON.stringify(join(workDir, "bundle", "updater.js"))});
        swapInstall({ layout: { kind: "bundle", root: ${JSON.stringify(root)}, backup: ${JSON.stringify(`${root}.old`)} }, stagedRoot: ${JSON.stringify(staged)} })
          .then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`,
      );

      const started = Date.now();
      const child = Bun.spawn([electronBinary!, script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stderr: "pipe",
      });
      const exited = await Promise.race([child.exited, Bun.sleep(SWAP_BUDGET_MS).then(() => null)]);
      if (exited === null) child.kill("SIGKILL");
      const elapsed = Date.now() - started;

      expect(exited).toBe(0);
      expect(elapsed).toBeLessThan(SWAP_BUDGET_MS);
      expect(readFileSync(join(root, "Contents", "marker"), "utf8")).toBe("new");
      expect(existsSync(`${root}.old`)).toBe(false);
      expect(existsSync(`${root}.old-2`)).toBe(false);
    },
    SWAP_BUDGET_MS + 10_000,
  );
});
