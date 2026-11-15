/** Read-only RPC lookups behind the /model and /sessions menus. */
import type { InlineKeyboard } from "../api";
import { sessionsKeyboard, SESSIONS_PAGE_SIZE, type ModelRow } from "../menus";
import type { RpcCaller } from "./rpc-peer";

interface SessionListRow {
    id: string;
    name?: string;
    firstUserMessage?: string;
    mtime: number;
    running?: boolean;
}

export interface SessionsPage {
    title: string;
    keyboard: InlineKeyboard;
    page: number;
}

/** Models the user can actually run right now: those whose provider is
 * usable (auth.status `providers` — logged in, or zero-login ollama/bedrock,
 * or a saved `custom:` gateway) and that the catalog marks available —
 * mirroring loop's own model picker, which never offers a provider that
 * would fail. Reading the strict `authorized` set here instead is what
 * used to hide every ollama and custom-gateway model from /model. */
export async function authorizedModels(peer: RpcCaller, provider?: string): Promise<ModelRow[]> {
    const [auth, models] = await Promise.all([
        peer.call<{ providers: string[] }>("auth.status"),
        peer.call<(ModelRow & { available?: boolean })[]>("catalog.list", provider ? { provider } : undefined),
    ]);
    const usable = new Set(auth.providers ?? []);
    return models.filter((m) => usable.has(m.provider) && m.available !== false);
}

/**
 * One page of the session list, newest first. Re-read on every page turn
 * rather than cached: the list changes underneath a menu that may sit in
 * the chat for days, and a stale cursor is worse than a re-fetch of a local
 * call. Returns undefined when there are no sessions at all.
 */
export async function sessionsPage(peer: RpcCaller, page: number): Promise<SessionsPage | undefined> {
    const rows = await peer.call<SessionListRow[]>("session.list");
    const sorted = rows.sort((a, b) => b.mtime - a.mtime);
    if (!sorted.length) return undefined;
    const totalPages = Math.max(1, Math.ceil(sorted.length / SESSIONS_PAGE_SIZE));
    // Clamp: sessions may have been deleted since the menu was drawn, so a
    // page number from an old callback can point past the end.
    const current = Math.min(Math.max(0, page), totalPages - 1);
    const slice = sorted.slice(current * SESSIONS_PAGE_SIZE, (current + 1) * SESSIONS_PAGE_SIZE);
    return {
        title: totalPages > 1 ? `pick a session — ${sorted.length} total` : "pick a session",
        keyboard: sessionsKeyboard(
            slice.map((r) => ({
                id: r.id,
                label: r.name || r.firstUserMessage || r.id,
                running: r.running,
            })),
            current,
            totalPages,
        ),
        page: current,
    };
}
