import { buildContextReport } from "../../agent";
import { listAgents } from "../../agent/agents";
import { refreshConfigStores } from "../../auth";
import { bustCatalogCache, getCatalog, listUsableProviders } from "../../catalog";
import { CommandRegistry, registerBuiltins } from "../../commands";
import { closeAllPools } from "../../datasources/client";
import { getExtensionHost, setBuiltinEnabled, setRecordEnabled } from "../../extensions";
import { getMcpManager } from "../../mcp";
import { getSetting, setSetting, type AppSettings } from "../../settings";
import { cwdParam, type HandlerTable, type RpcHost } from "./rpc-host";

type SettingsHost = Pick<RpcHost, "contexts" | "commands">;

/**
 * Settings a remote client may read and toggle — the boolean rows of the
 * TUI's /settings screen. An allowlist (not a passthrough) so the RPC surface
 * can't write arbitrary keys; terminal-only toggles (clock, theme…) and
 * structured settings (hooks, sandbox…) stay local.
 */
const WEB_SETTINGS: ReadonlyArray<{ key: keyof AppSettings; label: string; description: string; def: boolean }> = [
    { key: "subagents", label: "subagents", description: "task tool: delegate work to parallel subagents", def: true },
    { key: "memory", label: "memory", description: "agent saves per-project facts across sessions", def: true },
    { key: "skills", label: "skills", description: "let the agent load project skills", def: true },
    { key: "recap", label: "recap", description: "short AI recap under responses that changed files", def: false },
    {
        key: "webSearch",
        label: "websearch",
        description: "websearch tool (DuckDuckGo scrape, may rate-limit)",
        def: false,
    },
    { key: "todos", label: "todos", description: "visible checklist during multi-step tasks", def: false },
    {
        key: "idleCompact",
        label: "idle compaction",
        description: "compact a chat over 70% full just before its prompt cache expires, while you are away",
        def: true,
    },
    {
        key: "threadTeams",
        label: "thread teams",
        description: "let the agent split a job across threads that work in parallel and report back",
        def: false,
    },
    {
        key: "backgroundShells",
        label: "background shells",
        description: "let bash start servers/watchers that keep running after the tool call",
        def: false,
    },
    {
        key: "codeMode",
        label: "code mode",
        description: "the agent writes JavaScript that calls its tools — parallel, chained, filtered — in a sandbox",
        def: false,
    },
    {
        key: "artifacts",
        label: "artifacts",
        description: "let the agent publish documents it writes as pages you can open",
        def: false,
    },
    { key: "reminders", label: "reminders", description: "fire /reminder alerts", def: true },
    {
        key: "mcp",
        label: "mcp servers",
        description: "connect configured MCP servers and expose their tools",
        def: true,
    },
    {
        key: "serve",
        label: "serve (web UI)",
        description: "allow loop serve — turning this off blocks the NEXT serve start",
        def: false,
    },
];

/** Settings, the context report, config reload and extensions. */
export function settingsHandlers(host: SettingsHost): HandlerTable {
    return {
        "settings.list": () => {
            return WEB_SETTINGS.map((s) => ({
                key: s.key,
                label: s.label,
                description: s.description,
                value: (getSetting(s.key) as boolean | undefined) ?? s.def,
            }));
        },
        "settings.set": (params) => {
            const key = String(params.key);
            const entry = WEB_SETTINGS.find((s) => s.key === key);
            if (!entry) throw new Error(`setting not writable over RPC: ${key}`);
            if (typeof params.value !== "boolean") throw new Error("value must be boolean");
            setSetting(entry.key, params.value as never);
            return { key, value: params.value };
        },
        "context.report": (params) => contextReport(host, params),
        "config.reload": (params) => reloadConfig(host, params),
        "extension.list": () => getExtensionHost().listAll(),
        "extension.setEnabled": (params) => setExtensionEnabled(params),
    };
}

/**
 * The /context breakdown for an open session, or — for a draft (no session
 * yet) — the fixed overhead a new session in that cwd would start with.
 * Read-only; buildContextReport mutates nothing.
 */
async function contextReport(host: SettingsHost, params: Record<string, unknown>) {
    if (params.sessionId) {
        const ctx = await host.contexts.ensureCtx(String(params.sessionId));
        return buildContextReport({
            session: ctx.session,
            modelId: ctx.modelId,
            cwd: ctx.session.info.cwd,
        });
    }
    const model = String(params.model ?? getSetting("defaultModel") ?? "");
    return buildContextReport({ session: null, modelId: model, cwd: cwdParam(params) });
}

/**
 * The GUI's `/reload`, and the same act as the terminal's: every config
 * surface re-read from disk and the model catalog re-fetched, in one round
 * trip.
 *
 * Editing settings.json (or an agent, or an MCP entry) by hand was invisible
 * to a running server — CachedStore serves reads from memory and the catalog
 * is cached for the process — so the only way to pick an edit up was to
 * restart the app. Now it is a call.
 *
 * Deliberately NOT here: the session's own model/agent choice. A reload
 * refreshes what the app knows, it does not re-decide what an open
 * conversation is running.
 *
 * All three JSON stores, not just settings: auth.json (custom providers) and
 * datasources.json are hand-editable too, and the internal docs tell the agent
 * to write them and then ask for a reload.
 */
async function reloadConfig(host: SettingsHost, params: Record<string, unknown>) {
    refreshConfigStores();
    // Datasource pools are keyed by connectionId, so an edited
    // host/password would keep dialing the old one until restart.
    await closeAllPools();

    const reloadCwd = cwdParam(params);
    host.commands = await freshCommands(reloadCwd);

    bustCatalogCache();
    const catalog = await getCatalog({ refresh: true });

    // MCP: close resets the manager's `initialized` flag (init() is
    // a no-op once connected), so added/removed/edited servers are
    // actually re-read rather than the old connections being kept.
    await getMcpManager().close();
    await getMcpManager().init(reloadCwd);

    const models = Object.values(catalog);
    return {
        models: models.length,
        availableModels: models.filter((m) => m.available).length,
        commands: host.commands.list().length,
        agents: listAgents().length,
        providers: (await listUsableProviders()).length,
    };
}

/**
 * Prompts, skills and agents are read from disk at registration, so the
 * registry is rebuilt rather than mutated. Extension command contributions are
 * re-applied on top, exactly as the server's startup does, or a reload would
 * silently drop them.
 */
async function freshCommands(cwd: string): Promise<CommandRegistry> {
    const fresh = new CommandRegistry();
    await registerBuiltins(fresh, { cwd });
    getExtensionHost().applyCommands(fresh);
    return fresh;
}

/**
 * Enable/disable only — install/uninstall stay local-only, a remote client
 * must not be able to pull new code onto the box.
 */
async function setExtensionEnabled(params: Record<string, unknown>) {
    const name = String(params.name ?? "");
    if (typeof params.value !== "boolean") throw new Error("value must be boolean");
    const entry = getExtensionHost()
        .listAll()
        .find((e) => e.name === name);
    if (!entry) throw new Error(`unknown extension: ${name}`);
    if (entry.builtin) setBuiltinEnabled(name, params.value);
    else setRecordEnabled(name, params.value);
    const host = getExtensionHost();
    if (params.value) await host.reload(name);
    else await host.unload(name);
    bustCatalogCache();
    return { name, value: params.value };
}
