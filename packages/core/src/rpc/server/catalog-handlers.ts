import { CostTracker, generateCommitMessage } from "../../agent";
import { buildSteakGrid } from "../../agent/steak";
import { getCatalog } from "../../catalog";
import { getSetting } from "../../settings";
import type { ProviderId } from "../../types";
import type { HandlerTable, RpcHost } from "./rpc-host";

type CatalogHost = Pick<RpcHost, "contexts">;

/** Models, what a run cost, and the message a commit gets. */
export function catalogHandlers(host: CatalogHost): HandlerTable {
    return {
        "catalog.list": async (params) => {
            const cat = await getCatalog();
            const wanted = params.provider as ProviderId | undefined;
            const list = Object.values(cat);
            return wanted ? list.filter((m) => m.provider === wanted) : list;
        },
        "cost.session": async (params) => {
            // `ensureCtx`, not `requireSession`: what a session cost is a
            // property of the transcript, not of whether this process
            // happens to have it open. Refusing to answer for a session
            // resumed in another window made the number unusable in a GUI.
            const ctx = await host.contexts.ensureCtx(String(params.sessionId));
            return ctx.tracker.sessionBreakdown();
        },
        "cost.lifetime": () => new CostTracker().lifetimeBreakdown(),
        "git.commitMessage": (params) => commitMessage(params),
        "cost.stats": (params) => {
            // today/7d/month/lifetime USD + per-provider split; cwd bucket
            // when the client passes one (the web UI's selected project).
            return new CostTracker().stats(params.cwd ? String(params.cwd) : undefined);
        },
        "usage.steak": (params) => {
            // The /steak heatmap, computed server-side with the exact CLI
            // layout (buildSteakGrid) so every client shades identically.
            const year = params.year !== undefined ? Number(params.year) : undefined;
            const daily = host.contexts.manager.dailyTokens();
            return buildSteakGrid(daily, Number.isInteger(year) ? { year } : {});
        },
    };
}

/**
 * Sessionless on purpose: the desktop commit dialog wants one subject line for
 * a diff it already has, and opening a session to get it would litter the
 * session list and the tree.
 */
async function commitMessage(params: Record<string, unknown>) {
    const diff = String(params.diff ?? "");
    if (!diff.trim()) return { message: "" };
    const modelId = String(params.model ?? getSetting("defaultModel") ?? "");
    if (!modelId) throw new Error("no model configured to write a commit message");
    const message = await generateCommitMessage({
        diff,
        modelId,
        branch: params.branch ? String(params.branch) : undefined,
        tracker: new CostTracker(),
        cwd: params.cwd ? String(params.cwd) : undefined,
    });
    return { message };
}
