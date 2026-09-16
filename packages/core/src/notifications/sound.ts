/**
 * Interface chimes.
 *
 * Two things a terminal agent can do when it wants you back: make a noise, and
 * ring the terminal bell so a multiplexer marks the pane. This does both, and
 * is careful about which one — a bell is universal but ugly, a chime is nicer
 * but only exists where there is a player.
 *
 *   * macOS gets real audio through `afplay`, and is the only platform where
 *     sound is ON by default.
 *   * Everywhere else the fallback is the terminal bell, so a chime never
 *     becomes a silent no-op the user cannot explain — and sound stays opt-in.
 *   * Attention notifications ALWAYS emit the bell, even on macOS where a
 *     chime also plays, because the bell is what tmux/cmux watch for.
 *
 * Every failure path degrades to exactly one bell, never two and never a
 * thrown error: a missing player must not break the turn that triggered it.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandEnv, PRODUCT_NAME } from "../brand";
import { getSetting } from "../settings";
import { EMBEDDED_CUES } from "./sounds-blob";

export type Cue = keyof typeof EMBEDDED_CUES;

/**
 * - `off`  — silent; not even the bell.
 * - `on`   — the cues that mark a state change you asked to be told about.
 * - `max`  — also the incidental ones (a menu opening, the input clearing).
 */
export type SoundLevel = "off" | "on" | "max";

const MACOS_PLAYER = "/usr/bin/afplay";

/** Sound defaults on only where a real player exists. */
export const DEFAULT_LEVEL: SoundLevel = process.platform === "darwin" ? "on" : "off";

function parseLevel(value: string | undefined): SoundLevel | undefined {
    if (value === undefined) return undefined;
    const v = value.trim().toLowerCase();
    if (v === "") return undefined;
    if (v === "max") return "max";
    if (v === "0" || v === "false" || v === "off") return "off";
    return "on";
}

/**
 * The env var wins over the setting, so a test or a script can silence loop
 * without editing the user's settings.json. Tests set it to "0".
 */
export function soundLevel(): SoundLevel {
    return parseLevel(brandEnv("SOUND")) ?? getSetting("sound") ?? DEFAULT_LEVEL;
}

// -- the bell ------------------------------------------------------------

type BellSink = () => void;

let bellSink: BellSink = () => {
    try {
        // Straight to fd 2: the TUI owns stdout's cursor, and a stray byte in
        // that stream lands inside whatever frame is mid-render.
        writeSync(2, "\x07");
    } catch {
        // A closed stderr is not worth an exception.
    }
};

/** Tests (and the TUI, which may want its own sink) replace the bell. */
export function setBellSink(sink: BellSink): void {
    bellSink = sink;
}

function emitBell(): void {
    try {
        bellSink();
    } catch {
        // Best-effort by definition.
    }
}

// -- materializing the chimes -------------------------------------------

const materialized = new Map<Cue, string | null>();

function cachePath(cue: Cue): string {
    return join(process.env["TMPDIR"] || tmpdir(), `${PRODUCT_NAME}-${cue}${EMBEDDED_CUES[cue].ext}`);
}

/** Already on disk, byte-for-byte? Then reuse it rather than rewrite it. */
function matches(path: string, expected: Buffer): boolean {
    try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size !== expected.length) return false;
        return readFileSync(path).equals(expected);
    } catch {
        return false;
    }
}

/**
 * Written lazily, on first play, to keep it off the startup path — decoding
 * seven blobs costs nothing a user would notice, but it is not free either,
 * and most sessions never play more than two of them.
 *
 * The write goes to a temp name and is renamed into place, so a second loop
 * starting at the same moment cannot catch a half-written file, and the open
 * refuses to follow a symlink someone left in /tmp.
 */
function ensureCuePath(cue: Cue): string | null {
    const cached = materialized.get(cue);
    if (cached !== undefined) return cached;

    const path = cachePath(cue);
    let result: string | null = null;
    try {
        const bytes = Buffer.from(Bun.gunzipSync(Buffer.from(EMBEDDED_CUES[cue].gz, "base64")));
        if (!matches(path, bytes)) {
            const staging = `${path}.${process.pid}.tmp`;
            // wx: never follow, never clobber — the staging name is ours alone.
            const fd = openSync(staging, "wx", 0o600);
            try {
                writeFileSync(fd, bytes);
            } finally {
                closeSync(fd);
            }
            try {
                renameSync(staging, path);
            } catch (err) {
                try {
                    unlinkSync(staging);
                } catch {
                    // The rename already consumed it.
                }
                throw err;
            }
        }
        result = path;
    } catch {
        // Unwritable TMPDIR, a symlink in the way, a full disk: the bell still
        // works, so the notification is degraded rather than lost.
        result = null;
    }
    materialized.set(cue, result);
    return result;
}

// -- playing -------------------------------------------------------------

/** Spawned detached and unref'd: nothing waits on a 400 ms chime. */
function spawnPlayer(path: string): boolean {
    try {
        const child = spawn(MACOS_PLAYER, [path], { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
}

function playChime(cue: Cue, bellOnFailure: boolean): void {
    if (process.platform !== "darwin") {
        if (bellOnFailure) emitBell();
        return;
    }
    const path = ensureCuePath(cue);
    if (!path || !spawnPlayer(path)) {
        if (bellOnFailure) emitBell();
    }
}

/** A cue for a state change the user asked to hear about. Silent at `off`. */
export function playCue(cue: Cue): void {
    if (soundLevel() === "off") return;
    playChime(cue, true);
}

/** An incidental cue — only at `max`. */
export function playMaxCue(cue: Cue): void {
    if (soundLevel() !== "max") return;
    playChime(cue, true);
}

/**
 * The agent is waiting on you. Always bells, so a multiplexer can mark the
 * pane even when macOS also plays the chime — and so the one notification that
 * matters is never silent on a platform without a player.
 */
export function playAttention(cue: Cue = "success"): void {
    if (soundLevel() === "off") return;
    emitBell();
    playChime(cue, false);
}

/** Test seam: forget what has been written so a fresh TMPDIR is honoured. */
export function resetSoundCacheForTests(): void {
    materialized.clear();
}
