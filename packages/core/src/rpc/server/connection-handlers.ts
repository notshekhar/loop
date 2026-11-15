import {
    type DataSourceConfig,
    deleteDatasource,
    getDatasource,
    isValidConnectionId,
    listDatasources,
    saveDatasource,
} from "../../datasources/config";
import { closePool, testConnection } from "../../datasources/client";
import {
    addProjectServer,
    getMcpManager,
    getProjectServers,
    removeProjectServer,
    setProjectServerEnabled,
} from "../../mcp";
import { parseDatasourceConfig } from "../datasource-flows";
import { cancelMcpLogin, listMcpServers, parseServerConfig, pollMcpLogin, startMcpLogin } from "../mcp-flows";
import { cwdParam, type HandlerTable } from "./rpc-host";

/** What the agent connects out to: SQL datasources and MCP servers. */
export function connectionHandlers(): HandlerTable {
    return { ...datasourceHandlers(), ...mcpHandlers() };
}

/**
 * An omitted password KEEPS the stored one.
 *
 * The list withholds it, so an edit form has nothing to send back — and
 * treating that silence as "clear the password" would break the connection
 * every time someone corrected a port. Clearing is still possible, by sending
 * an empty string.
 */
function withSavedPassword(draft: DataSourceConfig, saved: DataSourceConfig | undefined): DataSourceConfig {
    return draft.password === undefined && saved?.password !== undefined
        ? { ...draft, password: saved.password }
        : draft;
}

function datasourceHandlers(): HandlerTable {
    return {
        /**
         * Saved database connections, with the secret withheld.
         *
         * `loop serve` is reachable over a network, so a stored password
         * must never ride a list response — the client only needs to know
         * whether one is set, and to render it if it is a `${env:VAR}`
         * reference, which is a pointer rather than a secret.
         */
        "datasource.list": () => {
            return listDatasources().map(({ id, config }) => {
                const { password, ...rest } = config;
                const isRef = typeof password === "string" && password.startsWith("${env:");
                return {
                    id,
                    config: { ...rest, ...(isRef ? { password } : {}) },
                    hasPassword: Boolean(password),
                    passwordIsEnvRef: isRef,
                };
            });
        },
        "datasource.save": async (params) => {
            const id = String(params.id ?? "").trim();
            if (!isValidConnectionId(id)) throw new Error(`invalid connection id: ${id}`);
            const config = withSavedPassword(parseDatasourceConfig(params.config), getDatasource(id));
            saveDatasource(id, config);
            // The cached pool still holds the OLD credentials; leaving it
            // would mean the next query silently used the config the user
            // just replaced.
            await closePool(id);
            return { id };
        },
        "datasource.remove": async (params) => {
            const id = String(params.id ?? "").trim();
            const removed = deleteDatasource(id);
            if (removed) await closePool(id);
            return { ok: removed };
        },
        /**
         * Probe a connection without saving it.
         *
         * Takes either a draft config (the form's current contents, before
         * the user commits) or the id of a saved one. A draft that omits
         * its password falls back to the saved secret, so "Test" works on
         * an edit form that never received it.
         */
        "datasource.test": async (params) => {
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (params.config === undefined) {
                const saved = id ? getDatasource(id) : undefined;
                if (!saved) throw new Error(`unknown datasource: ${id || "(none)"}`);
                return await testConnection(saved);
            }
            const draft = parseDatasourceConfig(params.config);
            return await testConnection(withSavedPassword(draft, id ? getDatasource(id) : undefined));
        },
    };
}

/** MCP servers and their sign-in flows. */
function mcpHandlers(): HandlerTable {
    return {
        "mcp.list": (params) => listMcpServers(cwdParam(params)),
        "mcp.add": (params) => addMcpServer(params),
        "mcp.remove": async (params) => {
            const name = String(params.name ?? "").trim();
            const cwd = cwdParam(params);
            if (params.scope === "project") {
                // The live connection has to go too, or its tools stay in
                // the agent's tool set for the rest of the process.
                const removed = removeProjectServer(cwd, name);
                if (removed) await getMcpManager().forget(name);
                return { ok: removed };
            }
            return { ok: await getMcpManager().remove(name) };
        },
        "mcp.setEnabled": async (params) => {
            const name = String(params.name ?? "").trim();
            if (typeof params.value !== "boolean") throw new Error("value must be boolean");
            const cwd = cwdParam(params);
            if (params.scope === "project") {
                const ok = setProjectServerEnabled(cwd, name, params.value);
                if (!ok) return { ok };
                const config = getProjectServers(cwd)[name];
                if (config) await getMcpManager().adopt(name, config);
                return { ok };
            }
            return { ok: await getMcpManager().setEnabled(name, params.value) };
        },
        "mcp.reconnect": (params) => reconnectMcp(params),
        "mcp.login.start": (params) => startMcpLogin(String(params.name ?? ""), cwdParam(params)),
        "mcp.login.poll": (params) => pollMcpLogin(String(params.flowId ?? ""), Number(params.cursor ?? 0)),
        "mcp.login.cancel": (params) => cancelMcpLogin(String(params.flowId ?? "")),
    };
}

/**
 * Scope matters: a project server lives in the repo's own file and travels
 * with it, a global one in ~/<config>/settings.json. The manager only knows
 * the global half, so a project add is written and then picked up by the
 * reconnect below.
 */
async function addMcpServer(params: Record<string, unknown>) {
    const name = String(params.name ?? "").trim();
    if (!name) throw new Error("server name required");
    const config = parseServerConfig(params.config);
    const cwd = cwdParam(params);
    if (params.scope === "project") {
        addProjectServer(cwd, name, config);
        await getMcpManager().adopt(name, config);
    } else {
        await getMcpManager().add(name, config);
    }
    return { name, server: getMcpManager().getServer(name) ?? null };
}

/** No name = all of them. This is also what makes the first `mcp.list` meaningful: nothing connects until asked. */
async function reconnectMcp(params: Record<string, unknown>) {
    const name = String(params.name ?? "").trim();
    const cwd = cwdParam(params);
    const manager = getMcpManager();
    await manager.init(cwd);
    // `init` captures cwd once and is a no-op ever after, so a
    // client that has moved (another workspace, a different tab)
    // was reconnecting against the directory this process started
    // in — wrong project file, wrong trust decision.
    await manager.setCwd(cwd);
    await manager.reconnect(name || undefined);
    return listMcpServers(cwd);
}
