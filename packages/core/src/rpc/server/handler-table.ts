import { agentHandlers } from "./agent-handlers";
import { artifactHandlers } from "./artifact-handlers";
import { authHandlers } from "./auth-handlers";
import { catalogHandlers } from "./catalog-handlers";
import { connectionHandlers } from "./connection-handlers";
import type { HandlerTable, RpcHost } from "./rpc-host";
import { serverInfoHandlers } from "./server-info-handlers";
import { sessionListHandlers } from "./session-list-handlers";
import { sessionTreeHandlers } from "./session-tree-handlers";
import { sessionTurnHandlers } from "./session-turn-handlers";
import { sessionViewHandlers } from "./session-view-handlers";
import { settingsHandlers } from "./settings-handlers";

/**
 * The whole method table, one group per domain.
 *
 * This used to be one 64-case switch, which meant a single 800-line method
 * and no way to see a domain's surface without scrolling past every other
 * one. Each group now lives in its own file and reaches the server only
 * through the slice of `RpcHost` it names.
 */
export function buildHandlerTable(host: RpcHost): HandlerTable {
    return {
        ...sessionListHandlers(host),
        ...sessionViewHandlers(host),
        ...sessionTreeHandlers(host),
        ...sessionTurnHandlers(host),
        ...agentHandlers(host),
        ...authHandlers(),
        ...catalogHandlers(host),
        ...settingsHandlers(host),
        ...serverInfoHandlers(host),
        ...connectionHandlers(),
        ...artifactHandlers(host),
    };
}
