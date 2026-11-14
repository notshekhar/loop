/**
 * `/btw` — ask a side question without touching the conversation you are in.
 *
 * The question runs in a FRESH session: nothing of the conversation it was
 * asked from is copied, and the model is told nothing about it — it sees the
 * question alone, as the first message of a new thread. Nothing flows back
 * either, so the main turn can keep working while you ask.
 *
 * The one link kept is for the UI, never the model: the question's entry
 * carries a `btw` tag (where it was asked) and the session records its parent,
 * so every client can show "Side question from …" and a way back.
 */
import { basename } from "node:path";
import type { BtwMeta, Entry } from "../types";
import type { SessionManager } from "./manager";
import type { Session } from "./session";
import { extractMessageText } from "./session";

/** How much of the question a side thread's name keeps. */
const NAME_CHARS = 60;

/** Every side thread's name starts with this. */
const NAME_PREFIX = "btw: ";

/** The name a side thread is listed under. */
export function btwThreadName(question: string): string {
    const flat = question.replace(/\s+/g, " ").trim();
    return `${NAME_PREFIX}${flat.length > NAME_CHARS ? `${flat.slice(0, NAME_CHARS - 1)}…` : flat}`;
}

/**
 * The session a side thread was asked from, read off a session-list row (its
 * name and parent link) — so a list can say so without opening every
 * session. A forked or handed-off session has a parent too; the name is what
 * marks a side thread, so one renamed away from `btw:` reads as a plain fork.
 */
export function btwParentOf(row: { readonly name?: string; readonly parentSession?: string }): string | null {
    if (!row.name?.startsWith(NAME_PREFIX) || !row.parentSession) return null;
    return basename(row.parentSession).replace(/\.jsonl$/, "");
}

/** The session a side thread was asked from, read off its question's tag. */
export function btwParentIn(branch: readonly Entry[]): BtwMeta | null {
    for (const entry of branch) {
        if (entry.type === "message" && entry.role === "user" && entry.btw) return entry.btw;
    }
    return null;
}

/** The title a source conversation goes by in a side thread's tag. */
function sourceTitle(source: Session): string {
    const named = source.getName()?.trim();
    if (named) return named;
    const firstUser = source.getBranch().find((e) => e.type === "message" && e.role === "user");
    const text = firstUser?.type === "message" ? extractMessageText(firstUser.content).trim() : "";
    return text ? text.split("\n")[0]!.slice(0, NAME_CHARS) : "this conversation";
}

export interface BtwThread {
    readonly session: Session;
    /** Tag for the question's user entry (runTurn's `btw`). */
    readonly meta: BtwMeta;
}

/**
 * A new, empty session for `question` in the source's folder and on its
 * model, named after the question and linked to the source. The question
 * itself is NOT added — run it as the new session's first turn with `meta`,
 * so it streams like any other turn.
 */
export async function createBtwThread(manager: SessionManager, source: Session, question: string): Promise<BtwThread> {
    if (!question.trim()) throw new Error("A side question cannot be empty.");
    const session = await manager.create({
        cwd: source.info.cwd,
        provider: source.info.provider,
        model: source.lastModel(),
        parentSession: source.path,
    });
    await session.setName(btwThreadName(question));
    return { session, meta: { parentId: source.id, parentTitle: sourceTitle(source) } };
}
