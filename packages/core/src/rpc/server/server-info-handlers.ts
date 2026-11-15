import { TURN_EVENT_NAMES } from "../../agent";
import { getSetting } from "../../settings";
import {
    MIN_CLIENT_PROTOCOL,
    negotiateProtocol,
    parseProtocol,
    PROTOCOL_CAPABILITIES,
    PROTOCOL_VERSION,
} from "../protocol";
import { providerOfModel, type HandlerTable, type RpcHost } from "./rpc-host";

/** Every method `dispatch` handles — surfaced via `server.info`. Keep in sync. */
const RPC_METHODS = [
    "server.info",
    "hello",
    "session.create",
    "session.list",
    "session.projects",
    "session.history",
    "session.messages",
    "session.open",
    "session.send",
    "session.cancel",
    "session.compact",
    "session.rename",
    "session.attach",
    "session.detach",
    "session.delete",
    "session.answer",
    "session.tree",
    "session.branch",
    "session.fork",
    "session.btw",
    "session.archive",
    "team.get",
    "team.stop",
    "agent.list",
    "agent.get",
    "agent.save",
    "agent.delete",
    "agent.tools",
    "auth.status",
    "auth.providers",
    "auth.login",
    "auth.logout",
    "auth.flow.start",
    "auth.flow.poll",
    "auth.flow.answer",
    "auth.flow.cancel",
    "auth.custom.list",
    "auth.custom.discover",
    "auth.custom.save",
    "auth.custom.remove",
    "auth.custom.setActive",
    "catalog.list",
    "cost.session",
    "cost.lifetime",
    "cost.stats",
    "usage.steak",
    "settings.list",
    "settings.set",
    "config.reload",
    "context.report",
    "extension.list",
    "extension.setEnabled",
    "mcp.list",
    "mcp.add",
    "mcp.remove",
    "mcp.setEnabled",
    "mcp.reconnect",
    "mcp.login.start",
    "mcp.login.poll",
    "mcp.login.cancel",
    "datasource.list",
    "datasource.save",
    "datasource.remove",
    "datasource.test",
    "git.commitMessage",
    "artifact.list",
    "artifact.get",
    "artifact.read",
    "artifact.export",
    "artifact.delete",
] as const;

type InfoHost = Pick<RpcHost, "version">;

/** What this server is: the protocol handshake and its capabilities. */
export function serverInfoHandlers(host: InfoHost): HandlerTable {
    return {
        // The handshake (docs/remote-control.md §4). Optional for a
        // client — one that never sends it is served as protocol 1.0 — but
        // the answer is how both sides learn they cannot talk, and say
        // which of them to update, before anything else fails.
        hello: (params) => {
            const client = parseProtocol(params.protocol) ?? [1, 0];
            const verdict = negotiateProtocol({
                client,
                host: PROTOCOL_VERSION,
                minClient: MIN_CLIENT_PROTOCOL,
            });
            if (!verdict.ok) throw new Error(verdict.message);
            return {
                protocol: PROTOCOL_VERSION,
                negotiated: verdict.protocol,
                minClientProtocol: MIN_CLIENT_PROTOCOL,
                host: "loop",
                version: host.version,
                capabilities: PROTOCOL_CAPABILITIES,
            };
        },
        "server.info": () => serverInfo(),
    };
}

/**
 * Capabilities handshake: lets a client discover the methods and event types
 * this server speaks without version-sniffing. `defaults` saves a remote
 * client (which has no local settings) from guessing a model/cwd for
 * session.create.
 */
function serverInfo() {
    return {
        protocol: "2.0",
        methods: RPC_METHODS,
        // The turn stream plus what the SERVER itself reports about
        // a turn. `session-running` has no emitter behind it — it
        // is this server's own flag (see `setRunning`) — so it
        // cannot live in the build-checked TurnEvents list, but a
        // client discovering capabilities still has to see it.
        events: [...TURN_EVENT_NAMES, "session-running"],
        defaults: {
            model: getSetting("defaultModel") ?? null,
            // Which provider runs it, so a client can name the
            // model's provider without guessing from the id.
            provider: providerOfModel(String(getSetting("defaultModel") ?? "")) ?? null,
            cwd: process.cwd(),
            // The level a turn runs at when `session.send` omits
            // `thinking` — runTurn's own fallback. A GUI effort
            // picker has to start on this or it would silently
            // override what the user set with /thinking.
            thinking: getSetting("thinkingLevel") ?? "off",
        },
    };
}
