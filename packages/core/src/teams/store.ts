/**
 * Thread teams on disk: who is in which team, what each member is doing, and
 * the messages between them. The tables live in the session database
 * (sessions/db.ts) beside the sessions they describe.
 *
 * A team is a lead session plus the member sessions it started. Every member
 * is an ordinary session — its transcript, title and spend are where any
 * session keeps them — so this file only records the relationships and the
 * mail, never a copy of anything a session already holds.
 */
import { ulid } from "ulid";
import { getDb } from "../sessions/db";

export type TeamRole = "lead" | "member";

/**
 * What a team member is doing, as every client shows it.
 *
 *   starting  created, its first turn not begun yet
 *   running   a turn is going
 *   waiting   inside wait_for_team
 *   idle      its last turn ended without a report
 *   done      it reported (until a message wakes it again)
 *   failed    its last turn ended on an error
 *   stopped   the team was stopped
 */
export type MemberState = "starting" | "running" | "waiting" | "idle" | "done" | "failed" | "stopped";

export const FINISHED_STATES: ReadonlySet<MemberState> = new Set(["idle", "done", "failed", "stopped"]);

export interface TeamMembership {
    readonly teamId: string;
    readonly sessionId: string;
    readonly role: TeamRole;
    readonly state: MemberState;
    /** What it is doing right now ("edit src/routes/export.ts"), while it works. */
    readonly activity?: string;
    readonly leadId: string;
    readonly createdAt: number;
    readonly updatedAt: number;
}

export interface TeamMemberRow extends TeamMembership {
    /** The session's title (its name — set by the lead when it started the member). */
    readonly title: string;
    readonly cwd: string;
}

/**
 * One piece of team mail.
 *
 *   message  send_message — to one thread, or one row per thread for "all"
 *   report   a member's report to its lead
 *   update   loop's own note to the team (a member joined)
 *   board    a team_board note; `to` is null and `boardKey` names it
 */
export type TeamMessageKind = "message" | "report" | "update" | "board";

export interface TeamMessage {
    readonly id: number;
    readonly teamId: string;
    readonly from: string;
    readonly to: string | null;
    readonly kind: TeamMessageKind;
    readonly boardKey?: string;
    readonly body: string;
    readonly ts: number;
    readonly deliveredAt?: number;
}

export interface BoardNote {
    readonly key: string;
    readonly body: string;
    readonly from: string;
    readonly ts: number;
}

interface MemberRow {
    session_pub: string;
    team_id: string;
    role: string;
    state: string;
    activity: string | null;
    created_at: number;
    updated_at: number;
    lead_pub: string;
    name?: string | null;
    cwd?: string | null;
}

interface MessageRow {
    id: number;
    team_id: string;
    from_pub: string;
    to_pub: string | null;
    kind: string;
    board_key: string | null;
    body: string;
    ts: number;
    delivered_at: number | null;
}

function toMembership(row: MemberRow): TeamMembership {
    return {
        teamId: row.team_id,
        sessionId: row.session_pub,
        role: row.role === "lead" ? "lead" : "member",
        state: row.state as MemberState,
        ...(row.activity ? { activity: row.activity } : {}),
        leadId: row.lead_pub,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toMessage(row: MessageRow): TeamMessage {
    return {
        id: row.id,
        teamId: row.team_id,
        from: row.from_pub,
        to: row.to_pub,
        kind: row.kind as TeamMessageKind,
        ...(row.board_key ? { boardKey: row.board_key } : {}),
        body: row.body,
        ts: row.ts,
        ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    };
}

/** A new team led by `leadId`. The lead is its first member. */
export function createTeam(leadId: string): string {
    const db = getDb();
    const id = `tm_${ulid()}`;
    const now = Date.now();
    db.transaction(() => {
        db.run("INSERT INTO teams (id, lead_pub, created_at) VALUES (?, ?, ?)", [id, leadId, now]);
        db.run(
            `INSERT INTO team_members (session_pub, team_id, role, state, created_at, updated_at)
             VALUES (?, ?, 'lead', 'running', ?, ?)`,
            [leadId, id, now, now],
        );
    })();
    return id;
}

export function addTeamMember(teamId: string, sessionId: string, state: MemberState = "starting"): void {
    const now = Date.now();
    getDb().run(
        `INSERT OR REPLACE INTO team_members (session_pub, team_id, role, state, created_at, updated_at)
         VALUES (?, ?, 'member', ?, ?, ?)`,
        [sessionId, teamId, state, now, now],
    );
}

const MEMBER_SELECT = `SELECT m.*, t.lead_pub AS lead_pub, s.name AS name, s.cwd AS cwd
    FROM team_members m
    JOIN teams t ON t.id = m.team_id
    LEFT JOIN sessions s ON s.pub_id = m.session_pub`;

/** The team a session belongs to, and its place in it — null when it is in none. */
export function teamOf(sessionId: string): TeamMembership | null {
    const row = getDb().query<MemberRow, [string]>(`${MEMBER_SELECT} WHERE m.session_pub = ?`).get(sessionId);
    return row ? toMembership(row) : null;
}

/** Memberships for several sessions at once — a session list's team column. */
export function teamsOf(sessionIds: readonly string[]): Map<string, TeamMembership> {
    const out = new Map<string, TeamMembership>();
    if (sessionIds.length === 0) return out;
    const db = getDb();
    // Chunked: SQLite caps bound parameters per statement.
    for (let i = 0; i < sessionIds.length; i += 400) {
        const chunk = sessionIds.slice(i, i + 400);
        const rows = db
            .query<MemberRow, string[]>(`${MEMBER_SELECT} WHERE m.session_pub IN (${chunk.map(() => "?").join(",")})`)
            .all(...chunk);
        for (const row of rows) out.set(row.session_pub, toMembership(row));
    }
    return out;
}

/** Everyone in the team, the lead first, then members in the order they joined. */
export function listTeam(teamId: string): TeamMemberRow[] {
    const rows = getDb()
        .query<MemberRow, [string]>(
            `${MEMBER_SELECT} WHERE m.team_id = ? ORDER BY CASE m.role WHEN 'lead' THEN 0 ELSE 1 END, m.created_at, m.rowid`,
        )
        .all(teamId);
    return rows.map((row) => ({
        ...toMembership(row),
        title: row.name?.trim() || (row.role === "lead" ? "Lead" : "Thread"),
        cwd: row.cwd ?? "",
    }));
}

/**
 * A session's title for team cards and the model: its name, else what it was
 * first asked (a lead the user started has no name until it is titled).
 */
export function sessionTitle(sessionId: string): string {
    const row = getDb()
        .query<{ name: string | null; first: string | null }, [string]>(
            `SELECT s.name AS name, (
                 SELECT e.payload FROM entries e
                 WHERE e.session_id = s.id AND e.type = 'message' AND e.role = 'user'
                 ORDER BY e.id LIMIT 1
             ) AS first
             FROM sessions s WHERE s.pub_id = ?`,
        )
        .get(sessionId);
    if (row?.name?.trim()) return row.name.trim();
    if (row?.first) {
        try {
            const content = (JSON.parse(row.first) as { content?: unknown }).content;
            if (typeof content === "string" && content.trim()) {
                const line = content.trim().split("\n")[0]!.replace(/\s+/g, " ");
                return line.length > 60 ? `${line.slice(0, 59)}…` : line;
            }
        } catch {
            // fall through to the id
        }
    }
    return `thread ${sessionId.slice(-6)}`;
}

/** Whether the team was stopped (no new turns start in it). */
export function isTeamStopped(teamId: string): boolean {
    const row = getDb()
        .query<{ stopped_at: number | null }, [string]>("SELECT stopped_at FROM teams WHERE id = ?")
        .get(teamId);
    return !!row?.stopped_at;
}

export function markTeamStopped(teamId: string, stopped: boolean): void {
    getDb().run("UPDATE teams SET stopped_at = ? WHERE id = ?", [stopped ? Date.now() : null, teamId]);
}

/**
 * Move a member to `state`. `activity` replaces what it is doing (null clears
 * it); omitted, it is kept while working and cleared once finished. Returns
 * whether anything changed, so callers only announce real moves.
 */
export function setMemberState(sessionId: string, state: MemberState, activity?: string | null): boolean {
    const current = teamOf(sessionId);
    if (!current) return false;
    const nextActivity =
        activity === undefined ? (FINISHED_STATES.has(state) ? null : (current.activity ?? null)) : activity;
    if (current.state === state && (current.activity ?? null) === nextActivity) return false;
    getDb().run("UPDATE team_members SET state = ?, activity = ?, updated_at = ? WHERE session_pub = ?", [
        state,
        nextActivity,
        Date.now(),
        sessionId,
    ]);
    return true;
}

/** Record what a member is doing right now. Returns whether it changed. */
export function setMemberActivity(sessionId: string, activity: string | null): boolean {
    const current = teamOf(sessionId);
    if (!current || (current.activity ?? null) === activity) return false;
    getDb().run("UPDATE team_members SET activity = ?, updated_at = ? WHERE session_pub = ?", [
        activity,
        Date.now(),
        sessionId,
    ]);
    return true;
}

/** A session was deleted: it leaves its team, and so does its unread mail. */
export function forgetTeamSession(sessionId: string): void {
    const db = getDb();
    db.run("DELETE FROM team_members WHERE session_pub = ?", [sessionId]);
    db.run("DELETE FROM team_messages WHERE to_pub = ? AND delivered_at IS NULL", [sessionId]);
}

/**
 * Mail one message to each of `to`. One row per recipient, so each thread's
 * inbox is read — and marked read — on its own.
 */
export function postTeamMessages(input: {
    teamId: string;
    from: string;
    to: readonly string[];
    kind: Exclude<TeamMessageKind, "board">;
    body: string;
}): TeamMessage[] {
    const db = getDb();
    const ts = Date.now();
    const out: TeamMessage[] = [];
    db.transaction(() => {
        for (const recipient of input.to) {
            const res = db.run(
                "INSERT INTO team_messages (team_id, from_pub, to_pub, kind, body, ts) VALUES (?, ?, ?, ?, ?, ?)",
                [input.teamId, input.from, recipient, input.kind, input.body, ts],
            );
            out.push({
                id: Number(res.lastInsertRowid),
                teamId: input.teamId,
                from: input.from,
                to: recipient,
                kind: input.kind,
                body: input.body,
                ts,
            });
        }
    })();
    return out;
}

/** Unread mail for a session, oldest first — marked read as it is taken. */
export function takeInbox(sessionId: string): TeamMessage[] {
    const db = getDb();
    let taken: TeamMessage[] = [];
    db.transaction(() => {
        const rows = db
            .query<MessageRow, [string]>(
                "SELECT * FROM team_messages WHERE to_pub = ? AND delivered_at IS NULL ORDER BY id",
            )
            .all(sessionId);
        if (rows.length === 0) return;
        const now = Date.now();
        db.run(`UPDATE team_messages SET delivered_at = ? WHERE id IN (${rows.map(() => "?").join(",")})`, [
            now,
            ...rows.map((row) => row.id),
        ]);
        taken = rows.map((row) => ({ ...toMessage(row), deliveredAt: now }));
    })();
    return taken;
}

export function inboxCount(sessionId: string): number {
    const row = getDb()
        .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM team_messages WHERE to_pub = ? AND delivered_at IS NULL",
        )
        .get(sessionId);
    return row?.n ?? 0;
}

/** Add or replace a note on the team's board. */
export function postBoardNote(teamId: string, from: string, key: string, body: string): BoardNote {
    const ts = Date.now();
    getDb().run(
        "INSERT INTO team_messages (team_id, from_pub, to_pub, kind, board_key, body, ts) VALUES (?, ?, NULL, 'board', ?, ?, ?)",
        [teamId, from, key, body, ts],
    );
    return { key, body, from, ts };
}

/** The board as it stands: the latest note under each key, newest first. An empty body removes a key. */
export function readBoard(teamId: string): BoardNote[] {
    const rows = getDb()
        .query<MessageRow, [string, string]>(
            `SELECT * FROM team_messages m
             WHERE m.team_id = ? AND m.kind = 'board' AND m.id = (
                 SELECT MAX(id) FROM team_messages x WHERE x.team_id = ? AND x.kind = 'board' AND x.board_key = m.board_key
             )
             ORDER BY m.id DESC`,
        )
        .all(teamId, teamId);
    return rows
        .filter((row) => row.body.trim() !== "")
        .map((row) => ({ key: row.board_key ?? "", body: row.body, from: row.from_pub, ts: row.ts }));
}

export interface TeamCostShare {
    readonly usd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    /** Of `usd`, what turns the team itself started cost (ledger source "team"). */
    readonly teamUsd: number;
}

export interface TeamCost extends TeamCostShare {
    readonly estimated: boolean;
    readonly bySession: ReadonlyMap<string, TeamCostShare>;
}

/**
 * What the whole team has cost: every ledger row billed to the lead or any
 * member, whoever started the turn — the lead, a teammate, or the user typing
 * into a member directly. Summed when asked and never copied anywhere, so the
 * daily, lifetime and per-project totals still count each dollar once.
 */
export function teamCost(teamId: string): TeamCost {
    const rows = getDb()
        .query<
            {
                session_pub: string;
                usd: number;
                inp: number;
                out: number;
                cached: number;
                team_usd: number;
                est: number;
            },
            [string]
        >(
            `SELECT l.session_pub AS session_pub,
                    COALESCE(SUM(l.usd), 0) AS usd,
                    COALESCE(SUM(l.input_tokens), 0) AS inp,
                    COALESCE(SUM(l.output_tokens), 0) AS out,
                    COALESCE(SUM(COALESCE(l.cache_read_tokens, 0)), 0) AS cached,
                    COALESCE(SUM(CASE WHEN l.source = 'team' THEN l.usd ELSE 0 END), 0) AS team_usd,
                    MAX(l.estimated) AS est
             FROM cost_ledger l
             WHERE l.session_pub IN (SELECT session_pub FROM team_members WHERE team_id = ?)
             GROUP BY l.session_pub`,
        )
        .all(teamId);
    const bySession = new Map<string, TeamCostShare>();
    let usd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let teamUsd = 0;
    let estimated = false;
    for (const row of rows) {
        bySession.set(row.session_pub, {
            usd: row.usd,
            inputTokens: row.inp,
            outputTokens: row.out,
            cachedInputTokens: row.cached,
            teamUsd: row.team_usd,
        });
        usd += row.usd;
        inputTokens += row.inp;
        outputTokens += row.out;
        cachedInputTokens += row.cached;
        teamUsd += row.team_usd;
        if (row.est === 1) estimated = true;
    }
    return { usd, inputTokens, outputTokens, cachedInputTokens, teamUsd, estimated, bySession };
}
