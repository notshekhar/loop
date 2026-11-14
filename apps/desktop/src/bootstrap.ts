/**
 * The main process's entry: turn on Node's compile cache, then load the app.
 *
 * The app bundle is ~7.6MB — loop's core runs in this process — and V8 spent
 * ~75ms of every launch compiling it before a window could exist. MEASURED:
 * with the cache warm, loading it went from 90–110ms to 45–60ms. The cache has
 * to be on BEFORE the bundle is required, which is why this is a separate,
 * tiny entry rather than a line at the top of main.ts: by the time any code in
 * a module runs, that module has already been compiled.
 *
 * Under userData, so it is per profile and survives updates; Node keys entries
 * by content, so a new build simply misses and rewrites them.
 */
import { app } from "electron";
import { enableCompileCache } from "node:module";
import { join } from "node:path";

enableCompileCache?.(join(app.getPath("userData"), "compile-cache"));

// A runtime require of a computed path, not an import: the app must load after
// the cache is on, so it cannot be bundled into this file. From the app root,
// as main.ts resolves its own files — Bun rewrites `__dirname` in CommonJS
// output to the source directory.
require(join(app.getAppPath(), "dist", "main", "app.cjs"));
