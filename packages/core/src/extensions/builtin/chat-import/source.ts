/**
 * What every importer answers: which chats exist for a folder, and one chat
 * as a loop transcript. The extension's commands talk to this and nothing
 * else, so adding an agent is one more file that implements it.
 */
import { homedir } from "node:os";
import type { Entry } from "../../../types";

/** One chat in a picker. */
export interface ChatSummary {
    id: string;
    title: string;
    /** Epoch ms of the last change — the picker sorts newest first. */
    updatedAt: number;
    /** Which variant of the agent wrote it, when an agent has more than one (Cursor CLI vs IDE). */
    origin?: string;
}

/** A chat read into loop's shape, ready to preview. */
export interface ImportedChat {
    id: string;
    title: string;
    entries: Entry[];
}

export interface ChatSource {
    /** Shown in titles and notices: "Claude Code". */
    readonly label: string;
    /** Chats recorded in `cwd`, newest first. */
    list(cwd: string): ChatSummary[];
    /**
     * One chat by id (or an unambiguous prefix of one). Looked up in `cwd`
     * first, then everywhere the agent keeps chats, so an id copied from any
     * project still opens. Undefined when no chat has that id.
     */
    load(id: string, cwd: string): ImportedChat | undefined;
}

/**
 * Where an importer looks — the user's home by default. Tests point it at a
 * fake home, so they never read (or depend on) the real agents' chats.
 */
export interface SourceRoots {
    home: string;
}

export function defaultRoots(): SourceRoots {
    return { home: process.env.LOOP_IMPORT_HOME || homedir() };
}

/** A chat's title from its first prompt, kept to one line. */
export function titleFrom(text: string | undefined, fallback = "(untitled chat)"): string {
    const line = (text ?? "").trim().split("\n")[0].trim();
    if (!line) return fallback;
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Find a summary by exact id, else by a prefix only one id has. */
export function matchId<T extends { id: string }>(items: readonly T[], id: string): T | undefined {
    const exact = items.find((i) => i.id === id);
    if (exact) return exact;
    const prefixed = items.filter((i) => i.id.startsWith(id));
    return prefixed.length === 1 ? prefixed[0] : undefined;
}
