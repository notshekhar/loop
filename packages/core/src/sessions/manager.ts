import { getConfigDir } from "../brand";
import { basename, join } from "node:path";
import { ulid } from "ulid";
import { debugLog } from "../debug";
import type { Entry, ProviderId, SessionInfoData } from "../types";
import { Session, generateEntryId } from "./session";
import { stripSessionHookContext } from "./hook-context";
import { getSessionStore, type SessionRecord, type SessionScope } from "./sqlite-store";

export function slugCwd(cwd: string): string {
    // slug convention: "--Users-notshekhar-Documents-foo--"
    const stripped = cwd.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
    return `--${stripped}--`;
}

/**
 * The canonical transcript address a session is known by (picker values,
 * hooks' transcript_path). Entries live in the session DB; this path is the
 * session's public name, kept in the historical JSONL shape.
 */
function transcriptPath(cwd: string, id: string): string {
    return join(getConfigDir(), "agent", "sessions", slugCwd(cwd), `${id}.jsonl`);
}

export interface SessionInfo extends SessionInfoData {
    path: string;
    mtime: number;
    firstUserMessage?: string;
    /** User-set display name (/name), latest session-name entry wins. */
    name?: string;
    /** Model the session last ran on, when it differs from the one it was
     * created with. Absent until a turn has been billed. */
    lastModel?: string;
    /** Epoch ms it was archived; absent while it is active. */
    archivedAt?: number;
}

export interface NewSessionOptions {
    cwd: string;
    provider: ProviderId;
    model: string;
}

function toSessionInfo(record: SessionRecord): SessionInfo {
    let firstUser: string | undefined;
    if (record.firstUserPayload) {
        try {
            const m = JSON.parse(record.firstUserPayload) as { content?: unknown };
            // Hook-context wrapper is model-facing — previews show what the
            // user actually typed.
            firstUser =
                typeof m.content === "string"
                    ? stripSessionHookContext(m.content)
                    : JSON.stringify(m.content).slice(0, 120);
        } catch (err) {
            debugLog("session-list", `bad first-user payload for ${record.info.id}:`, err as Error);
        }
    }
    return {
        ...record.info,
        path: transcriptPath(record.info.cwd, record.info.id),
        mtime: record.updatedAt,
        firstUserMessage: firstUser,
        name: record.name,
        ...(record.lastModel ? { lastModel: record.lastModel } : {}),
        ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
    };
}

export class SessionManager {
    /**
     * Sessions, newest first. Defaults to `active` — the working set, which is
     * what every caller predating the archive means by "the sessions".
     */
    list(cwd?: string, scope: SessionScope = "active"): SessionInfo[] {
        return getSessionStore().listSessions(cwd, scope).map(toSessionInfo);
    }

    /**
     * Put a session away, or take it back. Returns false for an unknown id.
     *
     * The gentler half of `delete`: the conversation, its entries and its
     * spend all stay exactly where they are — it simply stops appearing in the
     * list you work from.
     */
    setArchived(id: string, archived: boolean): boolean {
        return getSessionStore().setSessionArchived(id, archived);
    }

    /**
     * Sum input+output tokens per local calendar day across every stored
     * session. Powers /steak's usage heatmap — one GROUP BY over the derived
     * usage columns, independent of the cost store (which is USD-only).
     * Keyed YYYY-MM-DD in local time, matching cost.ts.
     */
    dailyTokens(): Map<string, number> {
        return getSessionStore().dailyTokens();
    }

    async create(opts: NewSessionOptions): Promise<Session> {
        const id = ulid();
        const info: SessionInfoData = {
            id,
            createdAt: Date.now(),
            cwd: opts.cwd,
            provider: opts.provider,
            model: opts.model,
        };
        const session = new Session(info, transcriptPath(opts.cwd, id), []);
        await session.append({ type: "session-info", ts: Date.now(), ...info });
        return session;
    }

    /** A fresh context with a reviewed brief, linked to its source. Persist
     * the whole destination atomically; never copy or mutate source entries. */
    createHandoff(source: Session, opts: NewSessionOptions & { brief: string }): Session {
        if (!opts.brief.trim()) throw new Error("A handoff brief cannot be empty.");
        const info: SessionInfoData = {
            id: ulid(),
            createdAt: Date.now(),
            cwd: opts.cwd,
            provider: opts.provider,
            model: opts.model,
            parentSession: source.path,
        };
        const name = `Handoff: ${source.getName() || source.id.slice(0, 12)}`.slice(0, 100);
        const messageId = generateEntryId((id) => id === info.id);
        const nameId = generateEntryId((id) => id === info.id || id === messageId);
        const entries: Entry[] = [
            { type: "session-info", ts: info.createdAt, ...info, parentId: null },
            {
                type: "message",
                role: "user",
                content: opts.brief,
                ts: info.createdAt,
                id: messageId,
                parentId: info.id,
            },
            { type: "session-name", name, ts: info.createdAt, id: nameId, parentId: messageId },
        ];
        getSessionStore().insertSessionWithEntries(info, entries);
        return new Session(info, transcriptPath(info.cwd, info.id), entries);
    }

    /**
     * Delete a session outright. Returns false when there was no such id.
     *
     * There was no way to remove a conversation before this — the only growth
     * control was never starting one. A client that can create sessions needs
     * to be able to drop them again, and a folder stops being a project when
     * its last one goes, which is how a project is removed.
     */
    delete(id: string): boolean {
        return getSessionStore().deleteSession(id);
    }

    /**
     * /cd — move a session to a new working directory: DB row plus in-memory
     * info/path. The DB is the source of truth; the path is just the
     * session's public name under the new cwd.
     */
    moveSession(session: Session, newCwd: string): void {
        getSessionStore().updateSessionCwd(session.id, newCwd);
        session.rehome(newCwd, transcriptPath(newCwd, session.id));
    }

    async open(idOrPath: string): Promise<Session> {
        // Accept both the bare id and the .jsonl-shaped public path (picker
        // values, hooks' transcript_path, parentSession links).
        const id = idOrPath.endsWith(".jsonl") ? basename(idOrPath).replace(/\.jsonl$/, "") : idOrPath;
        const record = getSessionStore().getSession(id);
        if (!record) throw new Error(`Session not found: ${idOrPath}`);
        return Session.load(transcriptPath(record.info.cwd, record.info.id), record.info);
    }

    /**
     * Persist a forked session containing `entries` (tree fields preserved).
     * The new session-info root carries the new session ulid as both session
     * id and tree id (matching create()); entries whose parent isn't part of
     * the copy are rewired to it so the fork has a single-root tree.
     */
    private writeFork(source: Session, entries: Entry[]): Session {
        const newId = ulid();
        const info: SessionInfoData = {
            ...source.info,
            id: newId,
            createdAt: Date.now(),
            parentSession: source.path,
        };

        const copiedIds = new Set(entries.map((e) => e.id!));
        const root: Entry = { type: "session-info", ts: Date.now(), ...info, parentId: null };
        const out: Entry[] = [root];
        for (const e of entries) {
            const copy: Entry = { ...e };
            if (!copy.parentId || !copiedIds.has(copy.parentId)) copy.parentId = newId;
            out.push(copy);
        }

        // Re-attach labels for copied entries, chained at the end (the reference
        // createBranchedSession recreates them from the resolved map).
        const usedIds = new Set([newId, ...copiedIds]);
        let parentId = out[out.length - 1].id!;
        for (const e of entries) {
            const label = source.getLabel(e.id!);
            if (!label) continue;
            const labelId = generateEntryId((id) => usedIds.has(id));
            usedIds.add(labelId);
            out.push({ type: "label", ts: Date.now(), targetId: e.id!, label, id: labelId, parentId });
            parentId = labelId;
        }

        getSessionStore().insertSessionWithEntries(info, out);
        return new Session(info, transcriptPath(info.cwd, newId), out);
    }

    /**
     * Fork the path root → `leafId` into a new session (the reference
     * createBranchedSession). Abandoned branches stay behind; the new
     * session's header records the source via parentSession.
     */
    forkAtEntry(source: Session, leafId: string): Session {
        const path = source.getBranch(leafId);
        if (path.length === 0) throw new Error(`Entry ${leafId} not found`);
        return this.writeFork(
            source,
            path.filter((e) => e.type !== "session-info" && e.type !== "label"),
        );
    }
}
