import { btwParentOf, type SessionScope } from "../../sessions";
import { getActiveProvider } from "../../auth";
import { killSessionShells } from "../../tools/utils/shell-registry";
import { leaveTeam, teamsOf } from "../../teams";
import type { ProviderId } from "../../types";
import { createActiveSession, requireIdle, type Transport } from "./active-session";
import { cwdParam, providerOfModel, type HandlerTable, type RpcHost } from "./rpc-host";

type ListHost = Pick<RpcHost, "contexts" | "announce">;

/** Sessions as a list: making them, naming them, putting them away. */
export function sessionListHandlers(host: ListHost): HandlerTable {
    return {
        "session.create": (params, transport) => createSession(host, params, transport),
        "session.list": (params) => listSessions(host, params),
        "session.projects": (params) => {
            // Every folder with a session, with counts — so a paged
            // session list still draws the whole project list.
            const scope: SessionScope =
                params.archived === "all" ? "all" : params.archived === true ? "archived" : "active";
            return host.contexts.manager.folders(scope);
        },
        "session.rename": async (params) => {
            const id = String(params.sessionId);
            const ctx = host.contexts.requireSession(id);
            const name = String(params.name ?? "").trim();
            await ctx.session.setName(name);
            host.announce({ sessionId: id, change: "renamed" });
            return { ok: true, name };
        },
        "session.archive": (params) => archiveSession(host, params),
        "session.delete": (params) => deleteSession(host, params),
    };
}

async function createSession(host: ListHost, params: Record<string, unknown>, transport: Transport) {
    const cwd = cwdParam(params);
    const provider = (params.provider as ProviderId) ?? getActiveProvider() ?? "xai";
    const model = String(params.model ?? "");
    const session = await host.contexts.manager.create({ cwd, provider, model });
    host.contexts.add(session.id, createActiveSession(session, { modelId: model, subscribers: [transport] }));
    host.announce({ sessionId: session.id, change: "created" });
    return { sessionId: session.id };
}

/**
 * `archived` selects which side of the archive to list: absent or false is
 * the working set (what every caller predating the archive meant by "the
 * sessions"), true is the archive, "all" is both.
 */
function listScope(archived: unknown): SessionScope {
    if (archived === "all") return "all";
    return archived === true || archived === "true" ? "archived" : "active";
}

/**
 * DB rows enriched with liveness so pickers can mark sessions that are
 * running / being watched right now.
 */
function listSessions(host: ListHost, params: Record<string, unknown>) {
    // `limit`/`offset` page it, newest first (`session.projects`
    // still lists every folder). Absent, it is the whole list, as
    // every client predating paging expects.
    const page = {
        ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
        ...(Array.isArray(params.ids) ? { ids: params.ids.map(String) } : {}),
    };
    const rows = host.contexts.manager.list(params.cwd as string | undefined, listScope(params.archived), page);
    const teams = teamsOf(rows.map((row) => row.id));
    return rows.map((row) => {
        const ctx = host.contexts.get(row.id);
        const team = teams.get(row.id);
        // `model`/`provider` on the row are the session's CREATION
        // model. `lastModel` is what it is actually running now, so
        // a client that shows a model never contradicts /model.
        const model = row.lastModel ?? row.model;
        const btwParent = btwParentOf(row);
        return {
            ...row,
            lastModel: model,
            lastProvider: providerOfModel(model) ?? row.provider,
            running: ctx?.running ?? false,
            attached: ctx?.subscribers.size ?? 0,
            // Thread teams: where this session sits in one, so a
            // list can nest members under their lead.
            ...(team ? { team: { id: team.teamId, role: team.role, leadId: team.leadId, state: team.state } } : {}),
            // A `/btw` side thread: the session it was asked from,
            // so a client can offer the way back.
            ...(btwParent ? { btw: { parentId: btwParent } } : {}),
        };
    });
}

/**
 * The gentler half of `session.delete`: the conversation, its entries and its
 * spend all stay — it just stops appearing in the list you work from.
 * `archived: false` takes it back out.
 *
 * Like delete, deliberately NOT behind `requireSession`: most of what you want
 * to archive is exactly what this process has never opened. Unlike delete, it
 * does not refuse while a turn is running — putting a conversation away does
 * not disturb it, and forcing you to stop the agent first would be gratuitous.
 */
function archiveSession(host: ListHost, params: Record<string, unknown>) {
    const id = String(params.sessionId);
    const archived = params.archived !== false;
    const ok = host.contexts.manager.setArchived(id, archived);
    if (ok) host.announce({ sessionId: id, change: "archived" });
    return { ok, sessionId: id, archived: ok ? archived : false };
}

/**
 * Deliberately does NOT go through requireSession: a session that was never
 * opened in this process has no live context, and being unable to delete the
 * ones you have not touched would make the whole thing useless.
 */
function deleteSession(host: ListHost, params: Record<string, unknown>) {
    const id = String(params.sessionId);
    requireIdle(id, host.contexts.get(id));
    // Drop the live context first, or subscribers keep a
    // handle on a conversation whose rows are gone.
    host.contexts.drop(id);
    // Shells belong to the session. Deleting it is the one moment
    // they become unreachable — the registry is keyed by session
    // id, so a shell left running here can never be listed, read
    // or killed again by anyone.
    killSessionShells(id);
    const deleted = host.contexts.manager.delete(id);
    if (deleted) leaveTeam(id);
    if (deleted) host.announce({ sessionId: id, change: "deleted" });
    return { ok: deleted, sessionId: id };
}
