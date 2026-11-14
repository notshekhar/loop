/**
 * A binary that behaves as the `bun` CLI when started with `BUN_BE_BUN=1`.
 *
 * Under the loop CLI that is loop itself: `process.execPath` is the compiled
 * binary (or bun, running from source). Under any other host it is NOT — the
 * desktop app runs core inside Electron's Node, where `process.execPath` is
 * the app. Spawning that to `bun install` a language server started a second
 * copy of the app, which the single-instance lock closed again (raising the
 * window), and the server was never installed. MEASURED with the desktop's
 * own bundling under Electron's Node: provisioning failed every time.
 *
 * Such a host names a bun-capable binary in `LOOP_BUN_BINARY` (the desktop
 * points it at the loop binary it ships). Without one there is none, and the
 * features that need it stand down rather than spawn something else.
 */
import { brandEnv } from "./brand";

export function bunBinary(): string | null {
    if (process.versions.bun) return process.execPath;
    return brandEnv("BUN_BINARY") || null;
}
