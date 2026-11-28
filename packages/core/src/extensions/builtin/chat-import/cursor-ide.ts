/**
 * Cursor IDE (Composer / Agent) chats, all in one database:
 * `<Cursor user dir>/globalStorage/state.vscdb`, table `cursorDiskKV`.
 *
 * `composerData:<id>` is a chat — its name, the folder it was opened in
 * (`workspaceIdentifier.uri.fsPath`) and `fullConversationHeadersOnly`, the
 * ordered list of its bubbles. `bubbleId:<chat id>:<bubble id>` is one bubble:
 * type 1 the user's, type 2 the agent's, which carries text, thinking, or one
 * tool call (`toolFormerData`, with its params and result as JSON strings).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "../../../sessions/sqlite";
import { withForeignSqlite } from "./files";
import { type ChatSource, type ChatSummary, type ImportedChat, matchId, type SourceRoots, titleFrom } from "./source";
import { outputText, parseJsonish, translateToolCall } from "./tool-calls";
import { parseTimestamp, TranscriptBuilder } from "./transcript";
import { userPrompt } from "./user-text";

interface ComposerRow {
    id: string;
    name: string | null;
    updatedAt: number | string | null;
}

interface Bubble {
    type?: number;
    text?: string;
    createdAt?: string;
    thinking?: { text?: string } | null;
    toolFormerData?: {
        toolCallId?: string;
        name?: string;
        params?: string;
        rawArgs?: string;
        result?: string;
        status?: string;
    } | null;
}

const USER_BUBBLE = 1;

/** Where Cursor keeps its user data on each platform. */
export function cursorUserDir(home: string, platform = process.platform): string {
    if (platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User");
    if (platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User");
    return join(home, ".config", "Cursor", "User");
}

export function cursorIdeSource(roots: SourceRoots): ChatSource {
    const database = join(cursorUserDir(roots.home), "globalStorage", "state.vscdb");
    const query = <T>(use: (db: SqliteDatabase) => T, fallback: T): T =>
        existsSync(database) ? withForeignSqlite(database, use) : fallback;
    return {
        id: "cursor",
        label: "Cursor",
        // Cursor records no model: its calls are estimated and priced at loop's current one.
        pricing: { agent: "cursor-agent" },
        list: (cwd) => query((db) => composersIn(db, cwd).flatMap(summarize), []),
        load: (id, cwd) =>
            query((db) => {
                const row = matchId(composersIn(db, cwd), id) ?? composerById(db, id);
                return row ? readChat(db, row) : undefined;
            }, undefined),
    };
}

const COMPOSER_COLUMNS = `substr(key, 14) AS id, json_extract(value, '$.name') AS name,
    coalesce(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt')) AS updatedAt`;

function composersIn(db: SqliteDatabase, cwd: string): ComposerRow[] {
    return db
        .query<ComposerRow>(
            `SELECT ${COMPOSER_COLUMNS} FROM cursorDiskKV WHERE key LIKE 'composerData:%'
             AND json_valid(value) AND json_extract(value, '$.workspaceIdentifier.uri.fsPath') = ?`,
        )
        .all(cwd);
}

function composerById(db: SqliteDatabase, id: string): ComposerRow | undefined {
    return db
        .query<ComposerRow>(
            `SELECT ${COMPOSER_COLUMNS} FROM cursorDiskKV WHERE key = ? AND json_valid(value)`,
        )
        .get(`composerData:${id}`);
}

function summarize(row: ComposerRow): ChatSummary[] {
    if (!row.name) return []; // an empty composer Cursor opened and never used
    return [{ id: row.id, title: titleFrom(row.name), updatedAt: Number(row.updatedAt) || 0, origin: "IDE" }];
}

function bubbles(db: SqliteDatabase, chatId: string): Bubble[] {
    const composer = db
        .query<{ headers: string | null }>(
            "SELECT json_extract(value, '$.fullConversationHeadersOnly') AS headers FROM cursorDiskKV WHERE key = ?",
        )
        .get(`composerData:${chatId}`);
    const headers = (parseJsonish(composer?.headers ?? "[]") as Array<{ bubbleId?: string }>) ?? [];
    const read = db.query<{ value: string }>("SELECT value FROM cursorDiskKV WHERE key = ?");
    return headers.flatMap((h) => {
        const row = h.bubbleId ? read.get(`bubbleId:${chatId}:${h.bubbleId}`) : undefined;
        const bubble = row ? parseJsonish(row.value) : undefined;
        return bubble && typeof bubble === "object" ? [bubble as Bubble] : [];
    });
}

function readChat(db: SqliteDatabase, row: ComposerRow): ImportedChat {
    const all = bubbles(db, row.id);
    const builder = new TranscriptBuilder();
    for (const bubble of all) addBubble(builder, bubble);
    const firstPrompt = all.find((b) => b.type === USER_BUBBLE)?.text;
    return { id: row.id, title: titleFrom(row.name || firstPrompt), entries: builder.build() };
}

function addBubble(builder: TranscriptBuilder, bubble: Bubble): void {
    const ts = parseTimestamp(bubble.createdAt);
    if (bubble.type === USER_BUBBLE) return builder.user(userPrompt(bubble.text ?? ""), ts);
    if (bubble.thinking?.text) builder.reasoning(bubble.thinking.text, ts);
    if (bubble.text) builder.text(bubble.text, ts);
    const tool = bubble.toolFormerData;
    if (!tool?.toolCallId || !tool.name) return;
    const call = translateToolCall(tool.name, parseJsonish(tool.params || tool.rawArgs || "{}"));
    builder.toolCall(tool.toolCallId, call.toolName, call.input, ts);
    const failed = tool.status === "error" || tool.status === "cancelled";
    builder.toolResult(tool.toolCallId, resultText(tool.result), failed, ts);
}

/** A result is a JSON string; most carry their readable part under one key. */
function resultText(result: string | undefined): string {
    const parsed = parseJsonish(result ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = parsed as Record<string, unknown>;
        for (const key of ["contents", "content", "output", "text"]) {
            if (typeof body[key] === "string") return body[key] as string;
        }
    }
    return outputText(parsed);
}
