/**
 * Cursor CLI (`cursor-agent`) chats: `~/.cursor/chats/<md5 of folder>/<chat id>/store.db`.
 *
 * Each store is content-addressed: a `blobs` table of id → bytes, and a
 * `meta` row (hex-encoded JSON) naming the chat and its latest ROOT blob. The
 * root is a small protobuf whose field 1 lists the conversation's message
 * blobs in order; each message blob is AI-SDK-shaped JSON (`role`, `content`
 * with text / reasoning / tool-call / tool-result parts). Only field 1 of the
 * root is read — the rest is Cursor's state and is skipped by wire type.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "../../../sessions/sqlite";
import { withForeignSqlite } from "./files";
import { type ChatSource, type ChatSummary, type ImportedChat, matchId, type SourceRoots, titleFrom } from "./source";
import { outputText, translateToolCall } from "./tool-calls";
import { TranscriptBuilder } from "./transcript";
import { userPrompt } from "./user-text";

interface CursorPart {
    type?: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    input?: unknown;
    result?: unknown;
    output?: unknown;
    isError?: boolean;
}

interface CursorMessage {
    role?: string;
    content?: string | CursorPart[];
}

interface StoreMeta {
    name?: string;
    createdAt?: number;
    latestRootBlobId?: string;
}

interface ChatDir {
    id: string;
    store: string;
}

/** Cursor files a folder's chats under the md5 of its path. */
export function cursorFolderHash(cwd: string): string {
    return createHash("md5").update(cwd).digest("hex");
}

export function cursorCliSource(roots: SourceRoots): ChatSource {
    const chats = join(roots.home, ".cursor", "chats");
    const inFolder = (cwd: string) => chatDirs(join(chats, cursorFolderHash(cwd)));
    const everywhere = () => (existsSync(chats) ? readdirSync(chats).flatMap((d) => chatDirs(join(chats, d))) : []);
    return {
        label: "Cursor CLI",
        list: (cwd) =>
            inFolder(cwd)
                .flatMap(summarize)
                .sort((a, b) => b.updatedAt - a.updatedAt),
        load(id, cwd) {
            const dir = matchId(inFolder(cwd), id) ?? matchId(everywhere(), id);
            return dir ? withForeignSqlite(dir.store, (db) => readChat(db, dir.id)) : undefined;
        },
    };
}

function chatDirs(folder: string): ChatDir[] {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return [];
    return readdirSync(folder)
        .map((id) => ({ id, store: join(folder, id, "store.db") }))
        .filter((c) => existsSync(c.store));
}

/** When the store last changed: a write lands in its WAL first. */
function lastWrite(store: string): number {
    const wal = `${store}-wal`;
    return Math.max(statSync(store).mtimeMs, existsSync(wal) ? statSync(wal).mtimeMs : 0);
}

function summarize(dir: ChatDir): ChatSummary[] {
    try {
        return withForeignSqlite(dir.store, (db) => {
            const messages = conversation(db);
            const prompt = messages.map(promptOf).find(Boolean);
            if (!prompt) return [];
            const title = readMeta(db)?.name;
            return [{ id: dir.id, title: titleFrom(title || prompt), updatedAt: lastWrite(dir.store), origin: "CLI" }];
        });
    } catch {
        // A store Cursor is halfway through creating is not a chat yet.
        return [];
    }
}

function readMeta(db: SqliteDatabase): StoreMeta | undefined {
    const row = db.query<{ value: string }>("SELECT value FROM meta WHERE key = '0'").get();
    if (!row) return undefined;
    try {
        return JSON.parse(Buffer.from(row.value, "hex").toString("utf8")) as StoreMeta;
    } catch {
        return undefined;
    }
}

/** The chat's messages in order, read through its latest root blob. */
function conversation(db: SqliteDatabase): CursorMessage[] {
    const rootId = readMeta(db)?.latestRootBlobId;
    if (!rootId) return [];
    const blob = db.query<{ data: Uint8Array }>("SELECT data FROM blobs WHERE id = ?");
    const root = blob.get(rootId)?.data;
    if (!root) return [];
    return rootMessageIds(root).flatMap((id) => {
        const data = blob.get(id)?.data;
        if (!data) return [];
        try {
            return [JSON.parse(Buffer.from(data).toString("utf8")) as CursorMessage];
        } catch {
            return [];
        }
    });
}

/** Field 1 of the root protobuf: the message blob ids, as hex. */
export function rootMessageIds(root: Uint8Array): string[] {
    const ids: string[] = [];
    let at = 0;
    while (at < root.length) {
        const [key, afterKey] = readVarint(root, at);
        const field = key >> 3;
        const wire = key & 7;
        at = afterKey;
        if (wire === 0) at = readVarint(root, at)[1];
        else if (wire === 1) at += 8;
        else if (wire === 5) at += 4;
        else if (wire === 2) {
            const [length, afterLength] = readVarint(root, at);
            if (field === 1) ids.push(Buffer.from(root.subarray(afterLength, afterLength + length)).toString("hex"));
            at = afterLength + length;
        } else break; // groups (3/4) are not used by Cursor; stop rather than misread
    }
    return ids;
}

function readVarint(bytes: Uint8Array, start: number): [number, number] {
    let value = 0;
    let shift = 0;
    let at = start;
    while (at < bytes.length) {
        const byte = bytes[at++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if (byte < 0x80) break;
    }
    return [value, at];
}

function partsOf(message: CursorMessage): CursorPart[] {
    const content = message.content;
    return typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
}

function promptOf(message: CursorMessage): string {
    if (message.role !== "user") return "";
    return partsOf(message)
        .map((p) => (p.type === "text" ? userPrompt(p.text ?? "") : ""))
        .filter(Boolean)
        .join("\n\n");
}

function readChat(db: SqliteDatabase, id: string): ImportedChat {
    const messages = conversation(db);
    const builder = new TranscriptBuilder();
    for (const message of messages) addMessage(builder, message);
    const title = readMeta(db)?.name || messages.map(promptOf).find(Boolean);
    return { id, title: titleFrom(title), entries: builder.build() };
}

function addMessage(builder: TranscriptBuilder, message: CursorMessage): void {
    if (message.role === "user") return builder.user(promptOf(message));
    for (const part of partsOf(message)) {
        if (message.role === "assistant") addAssistantPart(builder, part);
        else if (message.role === "tool" && part.type === "tool-result" && part.toolCallId) {
            builder.toolResult(part.toolCallId, outputText(part.result ?? part.output), part.isError === true);
        }
    }
}

function addAssistantPart(builder: TranscriptBuilder, part: CursorPart): void {
    if (part.type === "text") builder.text(part.text ?? "");
    else if (part.type === "reasoning") builder.reasoning(part.text ?? "");
    else if (part.type === "tool-call" && part.toolCallId && part.toolName) {
        const call = translateToolCall(part.toolName, part.args ?? part.input);
        builder.toolCall(part.toolCallId, call.toolName, call.input);
    }
}
