import { CONFIG_DIR_NAME, getConfigDir } from "../brand";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { readTextCached } from "./file-cache";

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", `${CONFIG_DIR_NAME}/AGENTS.md`, `${CONFIG_DIR_NAME}/CLAUDE.md`];
// Global instructions, loaded everywhere (mirrors Claude's ~/.claude/CLAUDE.md).
// Both are loaded if present; loop writes AGENTS.md by default, but a user-authored
// ~/.loop/CLAUDE.md is honored too.
const GLOBAL_CONTEXT_FILES = [join(getConfigDir(), "AGENTS.md"), join(getConfigDir(), "CLAUDE.md")];
const MAX_FILE_BYTES = 64 * 1024;

export interface WorkspaceContext {
    text: string;
    files: string[];
}

export function findRepoRoot(start: string): string {
    let dir = start;
    for (;;) {
        if (existsSync(join(dir, ".git"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return start;
        dir = parent;
    }
}

export function loadWorkspaceContext(cwd: string): WorkspaceContext {
    const root = findRepoRoot(cwd);
    const dirsToCheck = new Set<string>([root, cwd]);
    // walk cwd up to root, collecting any intermediate dir
    let dir = cwd;
    while (dir !== root && dir !== dirname(dir)) {
        dirsToCheck.add(dir);
        dir = dirname(dir);
    }

    // Global files first so they read as base rules; workspace files can refine them.
    const candidatePaths: string[] = [...GLOBAL_CONTEXT_FILES];
    for (const d of dirsToCheck) {
        for (const rel of CONTEXT_FILES) candidatePaths.push(join(d, rel));
    }

    const collected: string[] = [];
    const files: string[] = [];
    const seen = new Set<string>();
    for (const p of candidatePaths) {
        if (seen.has(p)) continue;
        seen.add(p);
        try {
            let content = readTextCached(p);
            if (content === null) continue;
            if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
                content = content.slice(0, MAX_FILE_BYTES) + "\n...[truncated]";
            }
            collected.push(`<file path="${p}">\n${content}\n</file>`);
            files.push(p);
        } catch {}
    }

    if (collected.length === 0) return { text: "", files: [] };
    return {
        text: `<workspace-context>\n${collected.join("\n")}\n</workspace-context>`,
        files,
    };
}

export interface MemoryFileCandidate {
    label: string;
    path: string;
    exists: boolean;
}

/**
 * /memory — the editable context-file locations for a cwd, existing or not.
 * Each location prefers AGENTS.md; a location where only a legacy CLAUDE.md
 * exists offers that file instead (the loader honors both).
 */
export function listMemoryFiles(cwd: string): MemoryFileCandidate[] {
    const root = findRepoRoot(cwd);
    const spots: Array<{ label: string; dir: string; rel?: string }> = [
        { label: "User memory (global)", dir: getConfigDir() },
        { label: "Project memory", dir: root },
        { label: "Project memory (local)", dir: join(root, CONFIG_DIR_NAME) },
    ];
    if (cwd !== root) spots.push({ label: "Directory memory", dir: cwd });

    const out: MemoryFileCandidate[] = [];
    const seen = new Set<string>();
    for (const spot of spots) {
        const agents = join(spot.dir, "AGENTS.md");
        const claude = join(spot.dir, "CLAUDE.md");
        const path = !existsSync(agents) && existsSync(claude) ? claude : agents;
        if (seen.has(path)) continue;
        seen.add(path);
        out.push({ label: spot.label, path, exists: existsSync(path) });
    }
    return out;
}

export function watchWorkspaceContext(files: string[], onChange: () => void): () => void {
    const watchers: FSWatcher[] = [];
    for (const f of files) {
        try {
            watchers.push(watch(f, () => onChange()));
        } catch {}
    }
    return () => {
        for (const w of watchers) w.close();
    };
}
