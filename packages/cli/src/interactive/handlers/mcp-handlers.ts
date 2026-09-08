/**
 * MCP server panel: /mcp opens an interactive list (status per server) where
 * each server can be authorized, reconnected, enabled/disabled, or deleted.
 * `/mcp reconnect [name]` keeps a scriptable, non-interactive shortcut.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    getMcpManager,
    hasStoredTokens,
    isGlobalServer,
    isOAuthServer,
    isHttpServer,
    isMcpEnabled,
    isServerEnabled,
    McpUnsupportedServerError,
    isTrusted,
    loadMcpServers,
    setServerEnabled,
    unsupportedRemoteServer,
    type CommandContext,
    type McpServerConfig,
    type ServerSnapshot,
    CONFIG_DIR_NAME,
    PRODUCT_NAME,
} from "@notshekhar/loop-core";
import { openBrowser } from "../../open-browser";
import { dim } from "../ui/text";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";

type McpHandlers = Pick<CommandContext, "manageMcp">;

// Sentinel list value for the "add server" row — a NUL prefix can't collide
// with a real server name.
const ADD_SERVER = "\0add-server";

const STATUS_LABEL: Record<ServerSnapshot["status"], string> = {
    ready: "ready",
    connecting: "connecting…",
    disabled: "disabled",
    error: "error",
    "needs-auth": "needs authorization",
};

export function createMcpHandlers(state: AppState, deps: AppDeps): McpHandlers {
    const { tui, history, selectOnce, searchOnce, promptOnce } = deps;

    /** Prompt for a new server's config and connect it. Esc at any field aborts. */
    async function addServerFlow(): Promise<void> {
        // The flow ends in a connect, so it asks the same question first. The
        // panel writes to user scope, so trust does not enter into it.
        if (!mayConnect(false)) return;
        const name = (await promptOnce("MCP server name (e.g. filesystem)")).trim();
        if (!name) return;

        const transport = await selectOnce(
            [
                { value: "stdio", label: "stdio", description: "local command over stdin/stdout" },
                { value: "http", label: "http", description: "remote streamable-HTTP server" },
                { value: "sse", label: "sse", description: "remote server-sent-events server" },
            ],
            "Transport",
        );
        if (!transport) return;

        const cfg = transport.value === "stdio" ? await promptStdioConfig() : await promptHttpConfig(transport.value);
        if (!cfg) return;

        // Refused before it is written: an entry that can never authenticate
        // looks like configuration and behaves like a fault.
        if (isHttpServer(cfg)) {
            const unsupported = unsupportedRemoteServer(cfg.url);
            if (unsupported) {
                history.addError(unsupported);
                tui.requestRender();
                return;
            }
        }

        history.addSystem(`adding ${name}…`);
        tui.requestRender();
        try {
            await getMcpManager().add(name, cfg);
            const added = getMcpManager().getServer(name);
            history.addSystem(`${name} → ${added ? STATUS_LABEL[added.status] : "added"}`);
        } catch (err) {
            history.addError(`failed to add ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        tui.requestRender();
    }

    async function promptStdioConfig(): Promise<McpServerConfig | undefined> {
        const command = (await promptOnce("command (e.g. npx)")).trim();
        if (!command) return undefined;
        const argsRaw = (await promptOnce("args (space-separated, optional)")).trim();
        const args = argsRaw ? argsRaw.split(/\s+/) : undefined;
        // A stdio child inherits only HOME/LOGNAME/PATH/SHELL/TERM/USER, so a
        // server that reads a token straight out of the environment gets
        // nothing and looks broken for no visible reason.
        history.addSystem(
            dim(
                `note: stdio servers inherit only HOME, PATH, SHELL, TERM and USER — declare anything else as "env" in ~/${CONFIG_DIR_NAME}/settings.json (\${env:VAR} is resolved at connect time)`,
            ),
        );
        // env/headers with secrets go in ~/.loop/settings.json as ${env:VAR}.
        return { type: "stdio", command, ...(args ? { args } : {}) };
    }

    async function promptHttpConfig(type: string): Promise<McpServerConfig | undefined> {
        const url = (await promptOnce("url (https://…)")).trim();
        if (!url) return undefined;
        const auth = await selectOnce(
            [
                { value: "none", label: "none", description: "no auth, or static headers set in settings.json" },
                { value: "oauth", label: "oauth", description: "browser login on first connect" },
            ],
            "Auth",
        );
        if (!auth) return undefined;
        if (auth.value !== "oauth") return { type: type as "http" | "sse", url };

        // Optional pre-registered client — for servers that block automatic
        // registration (e.g. Figma). Blank = let loop register dynamically.
        const clientId = (await promptOnce("OAuth client ID (optional — blank = auto-register)")).trim();
        const clientSecret = clientId
            ? (await promptOnce("OAuth client secret (optional; supports ${env:VAR})")).trim()
            : "";
        const scopesRaw = (await promptOnce("OAuth scopes (space-separated, optional)")).trim();
        return {
            type: type as "http" | "sse",
            url,
            auth: "oauth" as const,
            ...(clientId ? { clientId } : {}),
            ...(clientSecret ? { clientSecret } : {}),
            ...(scopesRaw ? { scopes: scopesRaw.split(/\s+/) } : {}),
        };
    }

    /**
     * Every configured server, whether or not this process has connected it.
     *
     * The panel used to list only what the manager held, which is nothing at
     * all in an untrusted project (auto-connect is trust-gated) or when a
     * server was added to settings.json by hand after launch — so `/mcp` showed
     * an empty list while `loop mcp list` showed the servers, and there was no
     * way in to reconnect or authorize them.
     */
    function panelRows(): Array<{ snapshot: ServerSnapshot; connected: boolean }> {
        const manager = getMcpManager();
        const live = new Map(manager.listServers().map((s) => [s.name, s]));
        const rows: Array<{ snapshot: ServerSnapshot; connected: boolean }> = [];
        for (const [name, config] of Object.entries(loadMcpServers(state.cwd))) {
            const snapshot = live.get(name);
            live.delete(name);
            rows.push(
                snapshot
                    ? { snapshot, connected: true }
                    : {
                          snapshot: {
                              name,
                              config,
                              toolCount: 0,
                              status: isServerEnabled(config) ? "error" : "disabled",
                              // A row for a server nothing has tried to connect
                              // reads as "error", which is the only status the
                              // shape has for it — so say WHY, or the panel
                              // accuses a perfectly good server of failing.
                              ...(isServerEnabled(config) ? { error: notConnectedReason(name) } : {}),
                          },
                          connected: false,
                      },
            );
        }
        // Anything connected but no longer in the config (removed from the file
        // mid-session) still deserves a row while its connection is alive.
        for (const snapshot of live.values()) rows.push({ snapshot, connected: true });
        return rows;
    }

    /** Why a configured server has no live connection in this process. */
    function notConnectedReason(name: string): string {
        if (!isMcpEnabled()) return `not connected — MCP is off ("mcp": false in settings.json)`;
        if (!isGlobalServer(name) && !isTrusted(state.cwd)) {
            return `not connected — declared in ${CONFIG_DIR_NAME}/mcp.json, which only loads in a trusted project`;
        }
        return "not connected yet — choose reconnect";
    }

    function detail(s: ServerSnapshot): string {
        if (s.status === "ready") return `${s.toolCount} tools`;
        if (s.status === "error" && s.error) return s.error;
        return STATUS_LABEL[s.status];
    }

    /**
     * Whether an action that actually brings a server up may proceed.
     *
     * Scope decides. A user-scope server is the user's own declaration, no repo
     * has any say in it, and startup connects it in every folder — so gating
     * the panel's reconnect/authorize on project trust only produced buttons
     * that refuse to work on servers that are already running. A project-scoped
     * server is code that arrived with the repo, and that is what trust is for.
     *
     * The old refusal also told people to "run /trust", which is not a command
     * loop has; the way out of an untrusted folder is the startup prompt, or
     * moving the server to user scope, so say that instead.
     */
    function mayConnect(projectScoped: boolean): boolean {
        if (!isMcpEnabled()) {
            history.addSystem('MCP is off — set "mcp": true in settings.json to use servers');
            tui.requestRender();
            return false;
        }
        if (projectScoped && !isTrusted(state.cwd)) {
            history.addError(
                `this project is not trusted, so servers in ${CONFIG_DIR_NAME}/mcp.json stay off here — ` +
                    `loop asks about trust at startup, or move the server to user scope with ` +
                    `\`${PRODUCT_NAME} mcp add --scope user …\``,
            );
            tui.requestRender();
            return false;
        }
        return true;
    }

    /** True for a server that has to wait for trust: anything not user-scope. */
    function isProjectScoped(name: string): boolean {
        return !isGlobalServer(name);
    }

    async function reconnect(name: string | undefined): Promise<void> {
        // Reconnecting everything re-reads the project file too.
        if (!mayConnect(name ? isProjectScoped(name) : true)) return;
        history.addSystem(name ? `reconnecting ${name}…` : "reconnecting all MCP servers…");
        tui.requestRender();
        await getMcpManager().reconnect(name || undefined);
    }

    async function authorize(name: string, config?: McpServerConfig): Promise<void> {
        if (!mayConnect(isProjectScoped(name))) return;
        history.addSystem(`Opening browser to authorize ${name}… complete the login, then return here.`);
        tui.requestRender();
        try {
            // The config travels with the row: a server this process never
            // connected (untrusted project, hand-edited settings) is exactly
            // the one you most need to be able to sign in to, and the manager
            // has nothing on file for it.
            await getMcpManager().authorize(name, (url) => openBrowser(url), config);
            history.addSystem(`${name} authorized and connected.`);
        } catch (err) {
            // A server that cannot issue loop credentials has already said
            // everything worth reading; prefixing it with "authorization
            // failed" only buries the part that names the way forward.
            if (err instanceof McpUnsupportedServerError) history.addError(err.message);
            else
                history.addError(
                    `authorization failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
                );
        }
        tui.requestRender();
    }

    /** Action submenu for one server. Returns to the list afterwards. */
    async function serverActions(s: ServerSnapshot): Promise<void> {
        const global = isGlobalServer(s.name);
        const items: SelectItem[] = [];
        // Offered whenever signing in applies to this server AT ALL, not only
        // when it has already broken. An OAuth session expires on the server's
        // clock, not ours — the status still reads "ready" while every call is
        // being refused — so a signed-in server has to keep the way back in.
        if (isOAuthServer(s.name, s.config, s.status === "needs-auth" || s.status === "error")) {
            const again = hasStoredTokens(s.name);
            items.push({
                value: "authorize",
                label: again ? "re-authorize" : "authorize",
                description: again ? "sign in again — replaces the current session" : "run the OAuth browser login",
            });
        }
        items.push({ value: "reconnect", label: "reconnect", description: "retry the connection" });
        if (global) {
            items.push(
                s.status === "disabled"
                    ? { value: "enable", label: "enable", description: "turn this server on" }
                    : { value: "disable", label: "disable", description: "turn this server off" },
            );
            items.push({
                value: "delete",
                label: "delete",
                description: `remove from ~/${CONFIG_DIR_NAME}/settings.json`,
            });
        }

        const pick = await selectOnce(items, `${s.name} — ${STATUS_LABEL[s.status]}`);
        if (!pick) return;

        const manager = getMcpManager();
        if (pick.value === "authorize") return authorize(s.name, s.config);
        if (pick.value === "reconnect") return reconnect(s.name);
        if (pick.value === "enable" || pick.value === "disable") {
            const enabled = pick.value === "enable";
            if (enabled && !mayConnect(isProjectScoped(s.name))) return;
            // setEnabled only knows servers this process connected; for one it
            // has never seen, flip the setting and connect it directly.
            if (!(await manager.setEnabled(s.name, enabled))) {
                if (setServerEnabled(s.name, enabled)) {
                    if (enabled) await manager.adopt(s.name, { ...s.config, enabled: true });
                    else await manager.forget(s.name);
                } else {
                    history.addError(
                        `${s.name} is not a global server — edit ${CONFIG_DIR_NAME}/mcp.json to change it`,
                    );
                    tui.requestRender();
                    return;
                }
            }
            history.addSystem(`${s.name} ${pick.value}d`);
            tui.requestRender();
            return;
        }
        if (pick.value === "delete") {
            await manager.remove(s.name);
            history.addSystem(`${s.name} removed`);
            tui.requestRender();
        }
    }

    return {
        async manageMcp(args: string) {
            const manager = getMcpManager();
            const [sub, name] = args.split(/\s+/);

            // Non-interactive shortcut for scripts/muscle memory.
            if (sub === "reconnect") {
                await reconnect(name || undefined);
                const after = manager
                    .listServers()
                    .map((s) => `  ${s.name}: ${STATUS_LABEL[s.status]}${s.error ? ` (${s.error})` : ""}`)
                    .join("\n");
                history.addSystem(after ? `MCP servers:\n${after}` : "No MCP servers configured.");
                tui.requestRender();
                return;
            }

            // Interactive panel: loop so action submenus return to the list.
            // "+ add server" is always offered, so an empty config isn't a
            // dead end. `lastIndex` keeps the cursor on the row just acted on
            // instead of snapping to the top after every action.
            let lastIndex = 0;
            while (true) {
                const rows = panelRows();
                const items: SelectItem[] = [
                    { value: ADD_SERVER, label: "+ add server", description: "configure and connect a new MCP server" },
                    ...rows.map(({ snapshot, connected }) => ({
                        value: snapshot.name,
                        label: `${snapshot.name} — ${connected ? STATUS_LABEL[snapshot.status] : "not connected"}`,
                        description: connected ? detail(snapshot) : "configured; reconnect to bring it up",
                    })),
                ];
                const pick = await searchOnce(items, "MCP servers (type to filter, Esc to close)", {
                    initialIndex: lastIndex,
                });
                if (!pick) return;
                lastIndex = Math.max(
                    0,
                    items.findIndex((i) => i.value === pick.value),
                );
                if (pick.value === ADD_SERVER) {
                    await addServerFlow();
                    continue;
                }
                const server = rows.find((r) => r.snapshot.name === pick.value)?.snapshot;
                if (server) await serverActions(server);
            }
        },
    };
}
