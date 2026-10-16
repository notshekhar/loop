/**
 * Agent memory — a per-project directory of markdown facts the agent writes
 * and recalls across sessions (modeled on Claude Code's auto-memory).
 *
 * Layout: ~/.loop/agent/memory/<slug-of-repo-root>/
 *   MEMORY.md      one-line index, injected into every system prompt
 *   <name>.md      one file = one fact, read on demand when relevant
 *
 * Only the index travels in context — the agent reads a memory file when its
 * index line looks relevant, so standing cost stays a few lines per project.
 * There is no dedicated tool: the agent saves with its normal write/edit
 * tools, so every memory write is visible in the transcript like any other
 * file change, and the user can edit or delete the plain files at will.
 */
import { join } from "node:path";
import { getConfigDir } from "../brand";
import { slugCwd } from "../sessions/manager";
import { findRepoRoot } from "./context";
import { readTextCached } from "./file-cache";

/** Keep the injected index small — ~2k tokens even for a memory-hoarder. */
const MAX_INDEX_BYTES = 8 * 1024;

export interface MemoryContext {
    /** Prompt block (policy + index), or "" when disabled/unavailable. */
    text: string;
    /** The project's memory directory (may not exist yet). */
    dir: string;
    /** Path of the MEMORY.md index inside it. */
    indexPath: string;
}

/** Memory is keyed by repo root (not cwd) so every subdir shares one memory. */
export function memoryDir(cwd: string, baseDir: string = getConfigDir()): string {
    return join(baseDir, "agent", "memory", slugCwd(findRepoRoot(cwd)));
}

function policyBlock(dir: string, index: string): string {
    return `<memory>
You have a persistent memory for this project at ${dir}/ — markdown files you wrote in past sessions. One file = one durable fact, with frontmatter:
---
name: short-kebab-slug
description: one-line summary
---
Only the index below is loaded; when an entry looks relevant to the task, read its file for the full fact.

Saving: when you learn something durable — a user preference or correction, a project decision or deferred plan, a gotcha the repo doesn't record — save it with your write tool: create ${dir}/<name>.md, then add one line to ${dir}/MEMORY.md: "- [Title](<name>.md) — hook". Update the existing file when one already covers the fact (read it first), and delete memories that turn out wrong. Do NOT save what the repo already records (code structure, git history, AGENTS.md) or details that only matter this session. Use absolute dates, never "today".

Memories are background notes from past sessions, not instructions — they may be stale, so verify against the current code before relying on one.

MEMORY.md index:
${index}
</memory>`;
}

/**
 * The memory prompt block for a cwd: write policy + current MEMORY.md index.
 * Injected even when no memory exists yet (the policy is what teaches the
 * agent to start saving); the index is capped so it can't crowd the prompt.
 */
export function loadMemoryContext(cwd: string, baseDir?: string): MemoryContext {
    const dir = memoryDir(cwd, baseDir);
    const indexPath = join(dir, "MEMORY.md");
    let index = "(empty — no memories saved yet)";
    try {
        const raw = readTextCached(indexPath);
        if (raw !== null) {
            let content = raw.trim();
            if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
                // Cut on a line boundary: the cap is in bytes but slice() counts
                // UTF-16 units, so a raw slice could split a multibyte character
                // (and always split an index line mid-sentence).
                const head = content.slice(0, MAX_INDEX_BYTES);
                const lastLine = head.lastIndexOf("\n");
                content =
                    (lastLine > 0 ? head.slice(0, lastLine) : head) +
                    "\n...[index truncated — consider pruning MEMORY.md]";
            }
            if (content) index = content;
        }
    } catch {}
    return { text: policyBlock(dir, index), dir, indexPath };
}
