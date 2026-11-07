/**
 * Notes a session keeps for later — the `session_notes` table in the session
 * DB. Every note belongs to exactly one session; there are no global notes.
 * A note is either submitted (sent as the next message, which takes it off the
 * list) or deleted.
 */
import { ulid } from "ulid";
import { getDb } from "./db";

export interface SessionNote {
    id: string;
    text: string;
    createdAt: number;
}

interface NoteRow {
    pub_id: string;
    text: string;
    created_at: number;
}

const toNote = (r: NoteRow): SessionNote => ({ id: r.pub_id, text: r.text, createdAt: r.created_at });

/** The session's notes, oldest first. */
export function listNotes(sessionId: string): SessionNote[] {
    return getDb()
        .query<NoteRow, [string]>(
            "SELECT pub_id, text, created_at FROM session_notes WHERE session_pub = ? ORDER BY id",
        )
        .all(sessionId)
        .map(toNote);
}

export function addNote(sessionId: string, text: string): SessionNote {
    const note = { id: ulid(), text, createdAt: Date.now() };
    getDb().run("INSERT INTO session_notes (pub_id, session_pub, text, created_at) VALUES (?, ?, ?, ?)", [
        note.id,
        sessionId,
        note.text,
        note.createdAt,
    ]);
    return note;
}

/**
 * Take a note off the session's list and return it, or undefined when it is
 * already gone. Submitting uses this, so a note is sent at most once even if
 * two windows on the same session pick it together.
 */
export function takeNote(sessionId: string, noteId: string): SessionNote | undefined {
    const row = getDb()
        .query<NoteRow, [string, string]>(
            "DELETE FROM session_notes WHERE session_pub = ? AND pub_id = ? RETURNING pub_id, text, created_at",
        )
        .get(sessionId, noteId);
    return row ? toNote(row) : undefined;
}

/** Remove every note in the session; returns how many there were. */
export function clearNotes(sessionId: string): number {
    return Number(getDb().run("DELETE FROM session_notes WHERE session_pub = ?", [sessionId]).changes);
}
