import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDED_CUES } from "../src/notifications/sounds-blob";

/**
 * The blob is the part that has to be right: these bytes are the only copy
 * that ships, and a truncated or mis-encoded cue is silent in a way nothing
 * else here would notice — `afplay` fails quietly and the bell covers for it.
 */
describe("embedded cues", () => {
    const CUES = ["success", "error", "bloom", "press", "click", "release", "toggle"] as const;

    test("every cue the player can ask for is embedded", () => {
        expect(Object.keys(EMBEDDED_CUES).sort()).toEqual([...CUES].sort());
    });

    test("each blob decodes to the asset it was generated from, byte for byte", () => {
        const assets = join(import.meta.dir, "..", "src", "notifications", "assets");
        for (const cue of CUES) {
            const entry = EMBEDDED_CUES[cue];
            const decoded = Buffer.from(Bun.gunzipSync(Buffer.from(entry.gz, "base64")));
            const onDisk = readFileSync(join(assets, `${cue}${entry.ext}`));
            expect(decoded.equals(onDisk)).toBe(true);
        }
    });

    test("click is the CAF; the rest are M4A", () => {
        // afplay picks its decoder from the extension, so the pairing matters.
        expect(EMBEDDED_CUES.click.ext).toBe(".caf");
        for (const cue of CUES.filter((c) => c !== "click")) {
            expect(EMBEDDED_CUES[cue].ext).toBe(".m4a");
        }
    });

    test("the audio containers are intact, not just non-empty", () => {
        for (const cue of CUES) {
            const bytes = Buffer.from(Bun.gunzipSync(Buffer.from(EMBEDDED_CUES[cue].gz, "base64")));
            expect(bytes.length).toBeGreaterThan(1_000);
            // M4A is ISO-BMFF: a box length, then "ftyp". CAF starts with "caff".
            const magic = cue === "click" ? bytes.subarray(0, 4).toString("latin1") : bytes.subarray(4, 8).toString("latin1");
            expect(magic).toBe(cue === "click" ? "caff" : "ftyp");
        }
    });
});

describe("sound level", () => {
    const KEY = "LOOP_SOUND";
    let saved: string | undefined;

    beforeEach(() => {
        saved = process.env[KEY];
    });
    afterEach(() => {
        if (saved === undefined) delete process.env[KEY];
        else process.env[KEY] = saved;
    });

    async function levelWith(value: string | undefined): Promise<string> {
        if (value === undefined) delete process.env[KEY];
        else process.env[KEY] = value;
        const { soundLevel } = await import("../src/notifications/sound");
        return soundLevel();
    }

    test("the env var silences loop without touching settings", async () => {
        expect(await levelWith("0")).toBe("off");
        expect(await levelWith("false")).toBe("off");
        expect(await levelWith("off")).toBe("off");
    });

    test("max is opt-in and explicit", async () => {
        expect(await levelWith("max")).toBe("max");
        expect(await levelWith("MAX")).toBe("max");
        // Anything else that is not an "off" spelling means on — a typo should
        // leave sound working rather than silently disable it.
        expect(await levelWith("yes")).toBe("on");
        expect(await levelWith("1")).toBe("on");
    });

    test("an empty value is not a setting", async () => {
        // spawnPty inherits the parent env, so "unset" is spelled as "".
        expect(await levelWith("")).not.toBe("max");
    });
});

describe("materialization", () => {
    let dir: string;
    let savedTmp: string | undefined;

    beforeEach(() => {
        savedTmp = process.env["TMPDIR"];
        dir = mkdtempSync(join(tmpdir(), "loop-sound-test-"));
        process.env["TMPDIR"] = dir;
    });
    afterEach(() => {
        if (savedTmp === undefined) delete process.env["TMPDIR"];
        else process.env["TMPDIR"] = savedTmp;
        rmSync(dir, { recursive: true, force: true });
    });

    // Driven through materializeCue rather than playCue: playing is macOS-only,
    // so going through playCue would make every assertion below vacuous on the
    // Linux box that runs CI — which is where a wrong file mode matters most.
    test("a cue is written once and reused, and never world-readable", async () => {
        const { materializeCue, resetSoundCacheForTests } = await import("../src/notifications/sound");
        resetSoundCacheForTests();

        const path = materializeCue("success");
        expect(path).toBe(join(dir, "loop-success.m4a"));
        const first = statSync(path!);
        expect(first.isFile()).toBe(true);
        // 0o600: /tmp is shared, and these are ours.
        expect(first.mode & 0o077).toBe(0);

        resetSoundCacheForTests();
        expect(materializeCue("success")).toBe(path);
        // Reused, not rewritten — same inode, same mtime.
        expect(statSync(path!).ino).toBe(first.ino);
        expect(statSync(path!).mtimeMs).toBe(first.mtimeMs);
    });

    test("what lands on disk is the cue itself", async () => {
        const { materializeCue, resetSoundCacheForTests } = await import("../src/notifications/sound");
        resetSoundCacheForTests();
        const path = materializeCue("click");
        const { EMBEDDED_CUES: cues } = await import("../src/notifications/sounds-blob");
        const expected = Buffer.from(Bun.gunzipSync(Buffer.from(cues.click.gz, "base64")));
        expect(readFileSync(path!).equals(expected)).toBe(true);
    });

    test("a cue file left behind by a different version is replaced", async () => {
        const { materializeCue, resetSoundCacheForTests } = await import("../src/notifications/sound");
        resetSoundCacheForTests();
        const path = join(dir, "loop-toggle.m4a");
        writeFileSync(path, "not a sound");
        expect(materializeCue("toggle")).toBe(path);
        expect(readFileSync(path).length).toBeGreaterThan(1_000);
    });

    test("playing is silent and writes nothing when sound is off", async () => {
        const { playCue, resetSoundCacheForTests } = await import("../src/notifications/sound");
        resetSoundCacheForTests();
        process.env["LOOP_SOUND"] = "0";
        playCue("bloom");
        expect(() => statSync(join(dir, "loop-bloom.m4a"))).toThrow();
        delete process.env["LOOP_SOUND"];
    });
});
