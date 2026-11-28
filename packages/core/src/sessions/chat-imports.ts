/**
 * What saving an imported chat (from Claude Code, Codex, Cursor) records:
 * which loop session it became, and what its calls cost — one ledger row per
 * call, dated when the call happened, so /cost's days and totals include it.
 *
 * A chat is recorded once: a second import of it finds the first session
 * instead, so its spend can never land in the ledger twice.
 */
import type { UsageBlock } from "../types";
import { addLedgerRow, type PriceSnapshot } from "./cost-ledger";
import { getDb } from "./db";

/** One priced API call of an imported chat. */
export interface ImportedCallCost {
    ts: number;
    /** `claude-code/claude-opus-5-5` — the agent, then the model as the agent named it. */
    model: string;
    usage: UsageBlock;
    usd: number;
    prices: PriceSnapshot;
    /** The tokens were estimated from text: the source never recorded them. */
    estimated: boolean;
}

export interface ChatImportRecord {
    /** The importer's id: "claude-code", "codex", "cursor". */
    source: string;
    chatId: string;
    sessionPub: string;
    cwd: string;
    calls: readonly ImportedCallCost[];
}

export function recordChatImport(record: ChatImportRecord): void {
    const db = getDb();
    db.transaction(() => {
        db.run(
            "INSERT OR REPLACE INTO imported_chats (source, chat_id, session_pub, imported_at) VALUES (?, ?, ?, ?)",
            [record.source, record.chatId, record.sessionPub, Date.now()],
        );
        for (const call of record.calls) {
            addLedgerRow({
                provider: call.model.slice(0, call.model.indexOf("/")),
                model: call.model,
                usage: call.usage,
                usd: call.usd,
                prices: call.prices,
                estimated: call.estimated,
                ts: call.ts,
                ctx: { source: "import", cwd: record.cwd, sessionPub: record.sessionPub },
            });
        }
    })();
}

/** The loop session a chat was imported as — undefined when it never was, or that session is gone. */
export function findChatImport(source: string, chatId: string): string | undefined {
    const row = getDb()
        .query<{ session_pub: string }, [string, string]>(
            `SELECT i.session_pub FROM imported_chats i
             JOIN sessions s ON s.pub_id = i.session_pub
             WHERE i.source = ? AND i.chat_id = ?`,
        )
        .get(source, chatId);
    return row?.session_pub;
}

/** Every chat id of `source` that is already a loop session — the picker marks these. */
export function importedChatIds(source: string): Set<string> {
    const rows = getDb()
        .query<{ chat_id: string }, [string]>(
            `SELECT i.chat_id FROM imported_chats i
             JOIN sessions s ON s.pub_id = i.session_pub
             WHERE i.source = ?`,
        )
        .all(source);
    return new Set(rows.map((r) => r.chat_id));
}
