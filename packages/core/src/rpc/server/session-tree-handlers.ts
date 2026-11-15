import { buildSessionTreeView, extractMessageText, stripSessionHookContext } from "../../sessions";
import { requireIdle, transcriptOf } from "./active-session";
import type { HandlerTable, RpcHost } from "./rpc-host";

type TreeHost = Pick<RpcHost, "contexts">;

/** A session as a tree: seeing its branches, moving between them, copying one off. */
export function sessionTreeHandlers(host: TreeHost): HandlerTable {
    return {
        "session.tree": async (params) => {
            // ALL branches, unlike `session.history`, which returns only
            // the current one. That is the right answer for rendering a
            // conversation and the wrong one for choosing between them —
            // and without this a client cannot even see that a session HAS
            // branches, let alone move between them.
            const ctx = await host.contexts.ensureCtx(String(params.sessionId));
            return buildSessionTreeView(ctx.session);
        },
        "session.branch": (params) => branchSession(host, params),
        "session.fork": (params) => forkSession(host, params),
    };
}

/**
 * `/tree` navigation: move the leaf, so the entries after it stop reaching the
 * model. Nothing is deleted — the abandoned branch stays in the tree and can
 * be navigated back to, which is the whole reason a session is a tree.
 *
 * No branch summary. The TUI can offer to summarize what it is leaving behind,
 * which is a model call with its own cost and failure modes; a client that
 * wants it can send the summary as the next message.
 */
function branchSession(host: TreeHost, params: Record<string, unknown>) {
    const id = String(params.sessionId);
    const ctx = host.contexts.requireSession(id);
    requireIdle(id, ctx);
    const entryId = params.entryId === null ? null : String(params.entryId ?? "");
    if (entryId === null || entryId === "") {
        // Back to the very beginning: the next turn starts fresh
        // with nothing but the session's own root.
        ctx.session.resetLeaf();
    } else {
        if (!ctx.session.getEntry(entryId)) throw new Error(`Unknown entryId: ${entryId}`);
        ctx.session.branch(entryId);
    }
    // The model in force follows the branch — `lastModel` reads the
    // path, so a branch that ran on another model changes it.
    ctx.modelId = ctx.session.lastModel();
    ctx.transcript = transcriptOf(ctx.session, false);
    return { ok: true, leafId: ctx.session.getLeafId(), model: ctx.modelId };
}

/**
 * A COPY, unlike session.branch, which moves this session's leaf. `position`
 * mirrors the TUI: "at" clones up to and including the entry (/clone),
 * "before" forks at its parent so the entry itself is not carried (/fork on a
 * user message — the client puts its text back in the composer).
 */
async function forkSession(host: TreeHost, params: Record<string, unknown>) {
    const id = String(params.sessionId);
    const ctx = await host.contexts.ensureCtx(id);
    const position = params.position === "before" ? "before" : "at";
    const entryId = String(params.entryId ?? ctx.session.getLeafId() ?? "");
    if (entryId === "") throw new Error(`session ${id} has nothing to fork from`);
    const entry = ctx.session.getEntry(entryId);
    if (!entry) throw new Error(`Unknown entryId: ${entryId}`);

    let targetLeafId: string | null = entryId;
    if (position === "before") {
        if (entry.type !== "message" || entry.role !== "user") {
            throw new Error(`Only a user message can be forked "before": ${entryId}`);
        }
        targetLeafId = entry.parentId ?? null;
    }
    // Forking at the very first message has nothing to copy, so it
    // is a brand-new empty session in the same folder — the TUI
    // makes the same call.
    const manager = host.contexts.manager;
    const forked = targetLeafId
        ? manager.forkAtEntry(ctx.session, targetLeafId)
        : await manager.create({
              cwd: ctx.session.info.cwd,
              provider: ctx.session.info.provider,
              model: ctx.session.lastModel(),
          });
    return {
        sessionId: forked.info.id,
        cwd: forked.info.cwd,
        leafId: forked.getLeafId(),
        // What the forked-from entry said, so a client forking
        // "before" can put the prompt back in its composer without
        // a second round trip.
        text:
            position === "before" && entry.type === "message"
                ? stripSessionHookContext(extractMessageText(entry.content))
                : undefined,
    };
}
