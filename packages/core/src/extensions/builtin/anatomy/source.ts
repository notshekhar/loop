/**
 * Where the anatomy skill lives on disk, and getting it there.
 *
 * The skill is not embedded in the binary like wayfinder's text: it is a
 * working kit (node scripts the model runs, references it reads, eight
 * example figures it opens before drawing) of about 27 MB. It is downloaded
 * once, on the first /anatomy, from a pinned commit — so every install runs
 * the same skill until loop pins a newer one — into a root directory the
 * caller names (the extension's own, which pi shares).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ANATOMY_REPO = "wheresryan22/anatomy";
/** The upstream commit loop ships; bump it to take a newer skill. */
export const ANATOMY_COMMIT = "1482e8469b0a9e0d8cc18ea2740a01423d29ae80";

const ARCHIVE_URL = `https://codeload.github.com/${ANATOMY_REPO}/tar.gz/${ANATOMY_COMMIT}`;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 60_000;

/** The unpacked skill under root: SKILL.md at its top. Named by commit so a new pin never mixes with an old copy. */
export function skillDir(root: string): string {
    return join(root, ANATOMY_COMMIT.slice(0, 12));
}

export function isInstalled(root: string): boolean {
    return existsSync(join(skillDir(root), "SKILL.md"));
}

const pending = new Map<string, Promise<string>>();

/** The skill's directory, downloading it first if it is not there. Concurrent calls share one download. */
export function ensureSkill(root: string): Promise<string> {
    if (isInstalled(root)) return Promise.resolve(skillDir(root));
    let download = pending.get(root);
    if (!download) {
        download = install(root).finally(() => pending.delete(root));
        pending.set(root, download);
    }
    return download;
}

async function install(root: string): Promise<string> {
    const dir = skillDir(root);
    const staging = `${dir}.partial-${process.pid}`;
    const archive = `${staging}.tar.gz`;
    mkdirSync(root, { recursive: true });
    try {
        const res = await fetch(ARCHIVE_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
        writeFileSync(archive, new Uint8Array(await res.arrayBuffer()));
        mkdirSync(staging, { recursive: true });
        // The archive's one top-level folder is <repo>-<commit>; strip it so SKILL.md lands at the root.
        await run("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"]);
        if (!existsSync(join(staging, "SKILL.md"))) throw new Error("the download has no SKILL.md");
        rmSync(dir, { recursive: true, force: true });
        renameSync(staging, dir);
        removeOtherVersions(root, dir);
        return dir;
    } finally {
        rmSync(archive, { force: true });
        rmSync(staging, { recursive: true, force: true });
    }
}

/** A newer pin leaves the old copy behind; 27 MB per version is worth reclaiming. */
function removeOtherVersions(root: string, keep: string): void {
    for (const name of readdirSync(root)) {
        const path = join(root, name);
        if (path !== keep) rmSync(path, { recursive: true, force: true });
    }
}

function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        proc.stderr?.on("data", (chunk) => (stderr += String(chunk)));
        const timer = setTimeout(() => proc.kill(), EXTRACT_TIMEOUT_MS);
        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 200)}`));
        });
    });
}
