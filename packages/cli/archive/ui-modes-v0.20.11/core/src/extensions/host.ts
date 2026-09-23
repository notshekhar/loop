/**
 * The ExtensionHost loads enabled extensions once at startup, hands each an
 * `api` object, and aggregates their contributions for the rest of the app to
 * read (commands, tools, providers, models, agents, skills, turn middleware).
 *
 * Ownership is tracked per extension, so disable/uninstall/reload tears down
 * exactly what an extension added — extensions never clean up after themselves.
 * Loading is in-process dynamic import: the embedded Bun runtime transpiles the
 * extension's TypeScript entry on import (verified to work inside a
 * `bun --compile` binary), and resolves the extension's own node_modules deps.
 */
import { EXTENSION_MANIFEST_KEYS, getConfigDir, PRODUCT_NAME } from "../brand";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CachedStore, settingsStore } from "../auth/storage";
import { startCallbackServer } from "../auth/oauth-callback";
import type {
    AgentPlugin,
    ExtensionManifest,
    ExtensionModule,
    ExtensionAPI,
    ExtensionUI,
    ProviderPlugin,
    StatusLineContributor,
    StatusLineTransform,
    ToolCallMiddleware,
    ToolResultMiddleware,
    ExtensionThemeJson,
    ExtensionUiMode,
    ToolSummaryContext,
    ToolSummaryRenderer,
    TurnMiddleware,
    TerminalHandle,
    TerminalSpawnOptions,
    DockOptions,
    DockHandle,
    WidgetRenderer,
    WidgetOptions,
    WidgetHandle,
} from "./api";
import { EXTENSION_API_VERSION, requiredApiRange } from "./api";
import { isCompatible, resolveEntry, resolvePkgDir } from "./manifest";
import { collectProviderModelInfos } from "./providers";
import { getBuiltinEnabled, listRecords, type ExtensionRecord } from "./store";
import { BUILTIN_EXTENSIONS, getBuiltin, type BuiltinExtension } from "./builtin";
import {
    clearContextPolicy,
    getContextPolicy,
    readActiveBranch,
    readContextBudget,
    registerContextPolicy,
    requestContextBoundary,
} from "../agent/context-policy";

type Tool = unknown; // ai-sdk Tool; kept loose here to avoid a hard ai import in the host
type SlashCommand = import("../commands").SlashCommand;
type ModelInfo = import("../types").ModelInfo;

/**
 * UI/browser capabilities the host can't implement itself — they live in the
 * CLI/TUI layer, which core cannot import. The CLI injects them via
 * `setServices` before `init()`. Absent in headless/print mode, where `ui` is
 * undefined (so `api.ui` throws) and `openExternal` is a no-op.
 */
export interface HostServices {
    ui?: ExtensionUI;
    openExternal?: (url: string) => void;
    /** Ask the interactive UI to repaint (e.g. a live status line). No-op in print mode. */
    requestRender?: () => void;
    /** Floating widgets. Absent outside interactive mode. */
    widgets?: { show(renderer: WidgetRenderer, options?: WidgetOptions): WidgetHandle };
    /** Terminal size in cells. Absent outside interactive mode. */
    screen?: () => { rows: number; cols: number };
    /** Docked panels. Absent outside interactive mode. */
    docks?: { open(renderer: WidgetRenderer, options?: DockOptions): DockHandle };
    /** Global key bindings. Absent outside interactive mode. */
    keymap?: { set(key: string, handler: () => boolean | void): () => void };
    /**
     * Set by the interactive app before `init()`, while the TUI does not exist
     * yet. It is what tells the host that a widget or key binding requested
     * during activation is worth queueing rather than discarding.
     */
    interactive?: boolean;
}

/** State a script set on a widget before the screen was ready to show it. */
interface PendingWidgetCell {
    cancelled: boolean;
    hidden: boolean;
    focused: boolean;
    position?: { row: number; col: number };
    handle?: WidgetHandle;
}

/** A handle that stands in for a widget until the TUI can really show it. */
function pendingWidgetHandle(cell: PendingWidgetCell): WidgetHandle {
    return {
        hide: () => {
            cell.cancelled = true;
            cell.handle?.hide();
        },
        setPosition: (row: number, col: number) => {
            cell.position = { row, col };
            cell.handle?.setPosition(row, col);
        },
        getPosition: () => cell.handle?.getPosition() ?? cell.position,
        setHidden: (hidden: boolean) => {
            cell.hidden = hidden;
            cell.handle?.setHidden(hidden);
        },
        isHidden: () => cell.handle?.isHidden() ?? cell.hidden,
        focus: () => {
            cell.focused = true;
            cell.handle?.focus();
        },
        unfocus: () => {
            cell.focused = false;
            cell.handle?.unfocus();
        },
    };
}

/**
 * Per-extension secrets (OAuth tokens, API keys). Kept out of settings.json in
 * its own file, mirroring the MCP auth store (mcp/oauth.ts). Shape:
 * `{ <extension>: { <key>: <value> } }`.
 */
const extAuthStore = new CachedStore(
    `${PRODUCT_NAME}-agent-ext-auth`,
    {},
    { configPath: join(getConfigDir(), "ext-auth.json") },
);
type SecretBag = Record<string, Record<string, string>>;

type CommandOp =
    | { kind: "register"; cmd: SlashCommand }
    | { kind: "override"; name: string; cmd: Partial<SlashCommand> & { handler: SlashCommand["handler"] } }
    | { kind: "unregister"; name: string };

interface Contributions {
    commandOps: CommandOp[];
    tools: Map<string, Tool>;
    toolRemovals: Set<string>;
    toolGrants: { agent: string; tool: string }[];
    toolCallMws: { match: (name: string) => boolean; mw: ToolCallMiddleware }[];
    toolResultMws: { match: (name: string) => boolean; mw: ToolResultMiddleware }[];
    toolSummaries: { match: (name: string) => boolean; fn: ToolSummaryRenderer }[];
    uiModes: ExtensionUiMode[];
    themeAdditions: { modeId: string; themes: ExtensionThemeJson[] }[];
    providers: Map<string, ProviderPlugin>;
    modelInfos: ModelInfo[];
    agents: AgentPlugin[];
    skillDirs: string[];
    turnMws: TurnMiddleware[];
    /** Names of policies this extension registered — so unload can release them. */
    contextPolicies: string[];
    statusContributors: StatusLineContributor[];
    statusTransforms: StatusLineTransform[];
    /**
     * Live UI an extension put on screen. Unlike every other contribution these
     * are not filtered on read — they are already painted — so unload has to
     * take them down explicitly or a disabled extension leaves a widget stuck
     * over the chat with nothing left to remove it.
     */
    widgets: WidgetHandle[];
    docks: DockHandle[];
    /** Live terminals — child processes, so unload must kill them. */
    terminals: TerminalHandle[];
    keymapDisposers: (() => void)[];
}

interface Loaded {
    record: ExtensionRecord;
    manifest: ExtensionManifest;
    pkgDir: string;
    module: ExtensionModule;
    contributions: Contributions;
}

/** One row of the /extensions panel — a built-in or an installed external. */
export interface ExtensionListEntry {
    name: string;
    displayName: string;
    description?: string;
    enabled: boolean;
    builtin: boolean;
    version?: string;
    source?: string;
    linkPath?: string;
}

function emptyContributions(): Contributions {
    return {
        commandOps: [],
        tools: new Map(),
        toolRemovals: new Set(),
        toolGrants: [],
        toolCallMws: [],
        toolResultMws: [],
        toolSummaries: [],
        uiModes: [],
        themeAdditions: [],
        providers: new Map(),
        modelInfos: [],
        agents: [],
        skillDirs: [],
        turnMws: [],
        contextPolicies: [],
        statusContributors: [],
        statusTransforms: [],
        widgets: [],
        docks: [],
        terminals: [],
        keymapDisposers: [],
    };
}

function toMatcher(match: string | string[] | ((name: string) => boolean)): (name: string) => boolean {
    if (typeof match === "function") return match;
    const set = new Set(Array.isArray(match) ? match : [match]);
    return (name: string) => set.has(name);
}

export class ExtensionHost {
    private loaded = new Map<string, Loaded>();
    /** Per-extension status reporters (api.extension.setStatus), for the banner/panel. */
    private statusFns = new Map<string, () => string | undefined>();
    private initialized = false;
    /** Warnings keyed by extension, so a reload replaces (not appends to) its entries. */
    private warnings = new Map<string, string[]>();
    /** CLI-injected UI/browser bridge (see HostServices). Set before init(). */
    private services: HostServices = {};

    /**
     * Widgets and key bindings asked for before the TUI existed.
     *
     * `init()` runs before the interactive app builds its TUI, so an extension
     * that binds a key or shows a widget from `activate` — which is exactly
     * where a Lua script's top level runs — would otherwise get a silent no-op.
     * These queue instead, and `setServices` flushes them once the screen is
     * real. Print mode never provides the services, so the queue is simply
     * dropped, which is the correct outcome there.
     */
    private pendingKeymaps: {
        key: string;
        handler: () => boolean | void;
        cell: { dispose?: () => void; cancelled: boolean };
    }[] = [];
    private pendingWidgets: {
        renderer: WidgetRenderer;
        options?: WidgetOptions;
        cell: PendingWidgetCell;
    }[] = [];

    /**
     * Inject UI/browser capabilities from the CLI layer. Call before `init()`:
     * the interactive app passes a real `ui`; print mode passes only
     * `openExternal`, leaving `api.ui` to throw.
     */
    setServices(services: HostServices): void {
        // Merge so the CLI can inject `openExternal` before init() and the
        // interactive `ui` later (once the TUI/deps exist) without clobbering.
        this.services = { ...this.services, ...services };
        this.flushPendingUi();
    }

    /** Bind and show everything that was requested before the screen existed. */
    private flushPendingUi(): void {
        const keymap = this.services.keymap;
        if (keymap && this.pendingKeymaps.length > 0) {
            for (const pending of this.pendingKeymaps.splice(0)) {
                if (pending.cell.cancelled) continue;
                pending.cell.dispose = keymap.set(pending.key, pending.handler);
            }
        }
        const widgets = this.services.widgets;
        if (widgets && this.pendingWidgets.length > 0) {
            for (const pending of this.pendingWidgets.splice(0)) {
                if (pending.cell.cancelled) continue;
                const handle = widgets.show(pending.renderer, pending.options);
                pending.cell.handle = handle;
                // Replay the state the script set while it was still queued.
                if (pending.cell.hidden) handle.setHidden(true);
                if (pending.cell.focused) handle.focus();
                const at = pending.cell.position;
                if (at) handle.setPosition(at.row, at.col);
            }
        }
    }

    private warn(name: string, message: string): void {
        const list = this.warnings.get(name) ?? [];
        list.push(message);
        this.warnings.set(name, list);
    }

    /** Load every enabled extension. Safe to call once per session. */
    async init(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        this.warnings.clear();
        // Built-in (bundled) extensions first, so an external install can still
        // override/extend afterwards. Each is opt-in (default disabled).
        for (const b of BUILTIN_EXTENSIONS) {
            if (!getBuiltinEnabled(b.name, b.defaultEnabled)) continue;
            try {
                await this.loadBuiltin(b);
            } catch (err) {
                this.warn(b.name, `built-in extension "${b.name}" failed to load: ${(err as Error).message}`);
            }
        }
        for (const record of listRecords()) {
            if (!record.enabled) continue;
            try {
                await this.loadOne(record);
            } catch (err) {
                this.warn(record.name, `extension "${record.name}" failed to load: ${(err as Error).message}`);
            }
        }
    }

    /** Activate a bundled extension from its statically-imported module. */
    private async loadBuiltin(b: BuiltinExtension): Promise<void> {
        const record: ExtensionRecord = {
            name: b.name,
            version: "built-in",
            source: "built-in",
            sourceKind: "builtin",
            enabled: true,
            installedAt: 0,
        };
        const manifest: ExtensionManifest = {
            name: b.name,
            [EXTENSION_MANIFEST_KEYS[0]]: { displayName: b.displayName },
        };
        const contributions = emptyContributions();
        const api = this.makeApi(record, manifest, "", contributions);
        await b.module.activate?.(api);
        this.loaded.set(b.name, { record, manifest, pkgDir: "", module: b.module, contributions });
    }

    private async loadOne(record: ExtensionRecord): Promise<void> {
        const pkgDir = resolvePkgDir(record);
        const pkgJsonPath = join(pkgDir, "package.json");
        if (!existsSync(pkgJsonPath)) throw new Error(`missing package.json at ${pkgDir}`);
        const manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as ExtensionManifest;
        if (!isCompatible(manifest)) {
            throw new Error(
                `requires ${PRODUCT_NAME} API ${requiredApiRange(manifest)}, host is ${EXTENSION_API_VERSION}`,
            );
        }
        const entry = resolveEntry(pkgDir, manifest);
        if (!existsSync(entry)) throw new Error(`entry not found: ${entry}`);

        // file:// keeps absolute paths importable on Windows; the ?t= query
        // busts the ESM registry so /reload picks up edited code (each reload
        // keeps the old module instance alive — acceptable for a dev loop).
        const entryUrl = pathToFileURL(entry);
        entryUrl.searchParams.set("t", String(Date.now()));
        const imported = (await import(entryUrl.href)) as { default?: ExtensionModule } & ExtensionModule;
        const module: ExtensionModule = imported.default ?? imported;
        const contributions = emptyContributions();
        const api = this.makeApi(record, manifest, pkgDir, contributions);
        await module.activate?.(api);

        this.loaded.set(record.name, { record, manifest, pkgDir, module, contributions });
    }

    private makeApi(
        record: ExtensionRecord,
        manifest: ExtensionManifest,
        pkgDir: string,
        c: Contributions,
    ): ExtensionAPI {
        // Info-level: routes to the chat as a dim system line, not a red error.
        const log = (...args: unknown[]) => console.log(`[${record.name}]`, ...args);
        // Per-extension settings live under one un-dotted top-level key as a
        // nested object: settingsStore uses dot-prop for `.set`, so a dotted key
        // would write a nested path that flat reads can't see. Read-modify-write
        // the whole bag keeps it consistent with CachedStore's flat get.
        const OWN = "extensionSettings";
        type Bag = Record<string, Record<string, unknown>>;
        const readOwn = (k: string) => ((settingsStore.get(OWN) as Bag)?.[record.name] ?? {})[k];
        const writeOwn = (k: string, v: unknown) => {
            // Fresh read before the bag rewrite so a concurrent process's
            // settings write isn't clobbered from a stale cache.
            settingsStore.refresh();
            const bag = { ...((settingsStore.get(OWN) as Bag) ?? {}) };
            bag[record.name] = { ...(bag[record.name] ?? {}), [k]: v };
            settingsStore.set(OWN, bag);
        };

        // api.ui — proxy to the CLI-injected bridge; throw when absent (print
        // mode) so an extension never silently no-ops an interactive flow.
        const requireUi = (): ExtensionUI => {
            if (!this.services.ui) {
                throw new Error(
                    `api.ui is not available in this context (non-interactive / print mode); ` +
                        `extension "${record.name}" tried to open an interactive UI`,
                );
            }
            return this.services.ui;
        };
        const ui: ExtensionUI = {
            select: (items, title, opts) => requireUi().select(items, title, opts),
            search: (items, title, opts) => requireUi().search(items, title, opts),
            prompt: (label, initial) => requireUi().prompt(label, initial),
            note: (text) => requireUi().note(text),
            error: (text) => requireUi().error(text),
        };

        // api.auth — per-extension secrets + browser/OAuth helpers.
        const readSecret = (k: string) => ((extAuthStore.get("secrets") as SecretBag)?.[record.name] ?? {})[k];
        const writeSecrets = (mutate: (bag: Record<string, string>) => void) => {
            const all = { ...((extAuthStore.get("secrets") as SecretBag) ?? {}) };
            const mine = { ...(all[record.name] ?? {}) };
            mutate(mine);
            all[record.name] = mine;
            extAuthStore.set("secrets", all);
        };
        const openExternal = (url: string) => {
            if (this.services.openExternal) this.services.openExternal(url);
            else log(`cannot open browser (no opener in this context): ${url}`);
        };
        const auth: ExtensionAPI["auth"] = {
            getSecret: (key) => readSecret(key),
            setSecret: (key, value) => writeSecrets((bag) => void (bag[key] = value)),
            deleteSecret: (key) => writeSecrets((bag) => void delete bag[key]),
            openExternal,
            loopbackOAuth: async (opts) => {
                const server = await startCallbackServer();
                try {
                    openExternal(await opts.buildAuthorizeUrl(server.redirectUri));
                    const { code, state } = await server.waitForCode(opts.timeoutMs ?? 180_000);
                    return { code, state, redirectUri: server.redirectUri };
                } finally {
                    server.close();
                }
            },
        };

        return {
            version: EXTENSION_API_VERSION,
            ui,
            auth,
            extension: {
                dir: pkgDir,
                manifest,
                log,
                setStatus: (fn) => this.statusFns.set(record.name, fn),
            },
            commands: {
                register: (cmd) => c.commandOps.push({ kind: "register", cmd }),
                unregister: (name) => c.commandOps.push({ kind: "unregister", name }),
                override: (name, cmd) => c.commandOps.push({ kind: "override", name, cmd }),
            },
            tools: {
                add: (name, tool) => c.tools.set(name, tool),
                remove: (name) => c.toolRemovals.add(name),
                grant: (agent, tool) => c.toolGrants.push({ agent, tool }),
                onCall: (match, mw) => c.toolCallMws.push({ match: toMatcher(match), mw }),
                onResult: (match, mw) => c.toolResultMws.push({ match: toMatcher(match), mw }),
                summary: (match, fn) => c.toolSummaries.push({ match: toMatcher(match), fn }),
            },
            settings: {
                get: (key) => settingsStore.get(key as string) as never,
                set: (key, value) => settingsStore.set(key as string, value),
                getOwn: ((key: string, fallback?: unknown) => {
                    const v = readOwn(key);
                    return (v === undefined ? fallback : v) as never;
                }) as ExtensionAPI["settings"]["getOwn"],
                setOwn: ((key: string, value: unknown) => writeOwn(key, value)) as never,
            },
            uiModes: {
                register: (mode) => c.uiModes.push(mode),
                addThemes: (modeId, ...themes) => c.themeAdditions.push({ modeId, themes }),
            },

            providers: {
                register: (provider) => c.providers.set(provider.id, provider),
                unregister: (id) => c.providers.delete(id),
            },
            models: { add: (...infos) => c.modelInfos.push(...infos) },
            agents: { register: (agent) => c.agents.push(agent) },
            skills: { addDir: (dir) => c.skillDirs.push(dir) },
            turn: { use: (mw) => c.turnMws.push(mw) },
            context: {
                registerPolicy: (policy) => {
                    c.contextPolicies.push(policy.name);
                    registerContextPolicy(policy);
                },
                requestBoundary: (handoff) => requestContextBoundary(handoff),
                read: () => readContextBudget(),
                branch: () => readActiveBranch(),
            },
            statusLine: {
                add: (fn) => c.statusContributors.push(fn),
                transform: (fn) => c.statusTransforms.push(fn),
                refresh: () => this.services.requestRender?.(),
            },
            widgets: {
                show: (renderer: WidgetRenderer, options?: WidgetOptions): WidgetHandle | undefined => {
                    if (this.services.widgets) {
                        const handle = this.services.widgets.show(renderer, options);
                        c.widgets.push(handle);
                        return handle;
                    }
                    // Interactive but not yet on screen: hand back a handle that
                    // records what the script does and replays it at flush time.
                    // Print mode has no interactive layer at all, so there is
                    // nothing to wait for and nothing to return.
                    if (!this.services.interactive) return undefined;
                    const cell: PendingWidgetCell = { cancelled: false, hidden: false, focused: false };
                    this.pendingWidgets.push({ renderer, options, cell });
                    const handle = pendingWidgetHandle(cell);
                    c.widgets.push(handle);
                    return handle;
                },
            },
            screen: () => this.services.screen?.(),
            terminal: {
                available: async (): Promise<boolean> => {
                    try {
                        const { ptyAvailable } = await import("../terminal/session");
                        return ptyAvailable();
                    } catch {
                        return false;
                    }
                },
                spawn: async (options?: TerminalSpawnOptions): Promise<TerminalHandle> => {
                    // Loaded here rather than at module scope: the emulator is
                    // megabytes a session that never opens a terminal should not
                    // pay for.
                    const { createTerminalSession } = await import("../terminal/session");
                    const session = createTerminalSession(options) as TerminalHandle;
                    c.terminals.push(session);
                    return session;
                },
            },
            docks: {
                open: (renderer: WidgetRenderer, options?: DockOptions): DockHandle | undefined => {
                    // No queueing here, unlike widgets: a dock changes the
                    // frame's layout, and replaying that against a screen built
                    // later is a worse failure than simply not having one during
                    // activation. Scripts open docks from a key or a command.
                    const handle = this.services.docks?.open(renderer, options);
                    if (handle) c.docks.push(handle);
                    return handle;
                },
            },
            keymap: {
                set: (key: string, handler: () => boolean | void): (() => void) => {
                    if (this.services.keymap) {
                        const dispose = this.services.keymap.set(key, handler);
                        c.keymapDisposers.push(dispose);
                        return dispose;
                    }
                    if (!this.services.interactive) return () => {};
                    const cell = { cancelled: false } as { dispose?: () => void; cancelled: boolean };
                    this.pendingKeymaps.push({ key, handler, cell });
                    const dispose = (): void => {
                        cell.cancelled = true;
                        cell.dispose?.();
                    };
                    c.keymapDisposers.push(dispose);
                    return dispose;
                },
            },
        };
    }

    /** Unload one extension, running its deactivate and dropping its contributions. */
    async unload(name: string): Promise<void> {
        const l = this.loaded.get(name);
        if (!l) return;
        try {
            await l.module.deactivate?.();
        } catch (err) {
            this.warn(name, `extension "${name}" deactivate threw: ${(err as Error).message}`);
        }
        // A context policy is global singleton state, not a list the host
        // filters on read — so unloading its owner has to release it explicitly
        // or a disabled extension keeps owning the context boundary.
        if (l.contributions.contextPolicies.includes(getContextPolicy()?.name ?? "")) clearContextPolicy();
        // Painted UI and live key bindings outlive the contribution lists, so
        // they are torn down here rather than simply dropped.
        for (const widget of l.contributions.widgets) {
            try {
                widget.hide();
            } catch {
                // A widget the TUI already removed is still unloaded.
            }
        }
        for (const dock of l.contributions.docks) {
            try {
                dock.close();
            } catch {
                // already closed
            }
        }
        // Terminals are child processes: dropping the reference would leave a
        // shell running with nothing able to reach or stop it.
        for (const term of l.contributions.terminals) {
            try {
                term.kill();
            } catch {
                // already gone
            }
        }
        for (const dispose of l.contributions.keymapDisposers) {
            try {
                dispose();
            } catch {
                // Same: a listener the TUI already dropped is fine.
            }
        }
        this.loaded.delete(name);
        this.statusFns.delete(name);
    }

    /** Reload one extension (pick up edits / re-enable). Handles built-ins too. */
    async reload(name: string): Promise<void> {
        await this.unload(name);
        // A reload's outcome replaces whatever the previous load/unload reported.
        this.warnings.delete(name);
        const builtin = getBuiltin(name);
        if (builtin) {
            if (getBuiltinEnabled(builtin.name, builtin.defaultEnabled)) await this.loadBuiltin(builtin);
            return;
        }
        const record = listRecords().find((r) => r.name === name);
        if (record?.enabled) await this.loadOne(record);
    }

    /**
     * Re-run every loaded extension from disk — what `/reload` needs so an
     * edited extension (a Lua script above all, since those are files a user or
     * an agent writes mid-session) takes effect without restarting loop.
     *
     * Each is unloaded and loaded again, so `deactivate` runs and long-lived
     * resources are released: an LSP server is shut down and re-provisioned on
     * next use, which is the intended cost of an explicit hard reload.
     */
    async reloadAll(): Promise<void> {
        for (const name of [...this.loaded.keys()]) await this.reload(name);
    }

    /** Deactivate every loaded extension (app shutdown). Safe to re-init after. */
    async close(): Promise<void> {
        for (const name of [...this.loaded.keys()]) await this.unload(name);
        this.initialized = false;
        this.warnings.clear();
    }

    // ---- aggregate getters (consumed across the app) ----

    /** Apply every extension's command ops to a registry (after builtins). */
    applyCommands(reg: import("../commands").CommandRegistry): void {
        for (const l of this.loaded.values()) applyCommandOps(reg, l.contributions.commandOps);
    }

    /** Extension-added tools, minus any an extension asked to remove. */
    getTools(): { add: Map<string, Tool>; remove: Set<string> } {
        const add = new Map<string, Tool>();
        const remove = new Set<string>();
        for (const l of this.loaded.values()) {
            for (const [k, v] of l.contributions.tools) add.set(k, v);
            for (const r of l.contributions.toolRemovals) remove.add(r);
        }
        return { add, remove };
    }

    getToolCallMiddleware(): { match: (name: string) => boolean; mw: ToolCallMiddleware }[] {
        return [...this.loaded.values()].flatMap((l) => l.contributions.toolCallMws);
    }

    getToolResultMiddleware(): { match: (name: string) => boolean; mw: ToolResultMiddleware }[] {
        return [...this.loaded.values()].flatMap((l) => l.contributions.toolResultMws);
    }

    /**
     * The extension-supplied summary for a tool call, or undefined to use the
     * built-in formatting. First matching renderer that returns a string wins;
     * a throwing renderer is ignored rather than breaking the repaint.
     */
    renderToolSummary(
        toolName: string,
        args: Record<string, unknown>,
        ctx: Omit<ToolSummaryContext, "toolName">,
    ): string | undefined {
        for (const l of this.loaded.values()) {
            for (const { match, fn } of l.contributions.toolSummaries) {
                if (!match(toolName)) continue;
                try {
                    const text = fn(args, { ...ctx, toolName });
                    if (typeof text === "string") return text;
                } catch {
                    // a broken renderer must never take down the UI
                }
            }
        }
        return undefined;
    }

    /**
     * UI modes and extra palettes contributed by extensions. The CLI drains
     * these into its mode registry after `init()` and after any reload — core
     * only collects them, since the registry and renderer live in the CLI.
     */
    getUiModes(): { modes: ExtensionUiMode[]; themeAdditions: { modeId: string; themes: ExtensionThemeJson[] }[] } {
        return {
            modes: [...this.loaded.values()].flatMap((l) => l.contributions.uiModes),
            themeAdditions: [...this.loaded.values()].flatMap((l) => l.contributions.themeAdditions),
        };
    }

    /** Status-line contributors + transforms, aggregated across extensions. */
    getStatusLine(): { contributors: StatusLineContributor[]; transforms: StatusLineTransform[] } {
        return {
            contributors: [...this.loaded.values()].flatMap((l) => l.contributions.statusContributors),
            transforms: [...this.loaded.values()].flatMap((l) => l.contributions.statusTransforms),
        };
    }

    /** Tool names extensions granted to a specific agent's allowlist. */
    getToolGrants(agent: string): string[] {
        const out = new Set<string>();
        for (const l of this.loaded.values()) {
            for (const g of l.contributions.toolGrants) if (g.agent === agent) out.add(g.tool);
        }
        return [...out];
    }

    getProvider(id: string): ProviderPlugin | undefined {
        for (const l of this.loaded.values()) {
            const p = l.contributions.providers.get(id);
            if (p) return p;
        }
        return undefined;
    }

    getModelInfos(): ModelInfo[] {
        return [...this.loaded.values()].flatMap((l) => l.contributions.modelInfos);
    }

    /** All registered provider plugins (last registration of an id wins). */
    private allProviders(): Map<string, ProviderPlugin> {
        const merged = new Map<string, ProviderPlugin>();
        for (const l of this.loaded.values()) {
            for (const [id, p] of l.contributions.providers) merged.set(id, p);
        }
        return merged;
    }

    /** Catalog entries from provider declarative models + direct model adds. */
    getProviderModelInfos(): ModelInfo[] {
        return collectProviderModelInfos(this.allProviders().values(), this.getModelInfos());
    }

    /** Login/picker descriptors for registered providers (id, name, auth). */
    getProviderDescriptors(): { id: string; name: string; auth?: ProviderPlugin["auth"] }[] {
        return [...this.allProviders().values()].map((p) => ({ id: p.id, name: p.name ?? p.id, auth: p.auth }));
    }

    getAgents(): AgentPlugin[] {
        return [...this.loaded.values()].flatMap((l) => l.contributions.agents);
    }

    getSkillDirs(): string[] {
        return [...this.loaded.values()].flatMap((l) => l.contributions.skillDirs);
    }

    getTurnMiddleware(): TurnMiddleware[] {
        return [...this.loaded.values()].flatMap((l) => l.contributions.turnMws);
    }

    /**
     * One line per currently-loaded extension for the startup banner / panel:
     * "displayName — status" (status from api.extension.setStatus, if set).
     */
    activeStatuses(): string[] {
        const out: string[] = [];
        for (const name of this.loaded.keys()) {
            let status: string | undefined;
            try {
                status = this.statusFns.get(name)?.();
            } catch {
                status = undefined;
            }
            // Short name + terse status, e.g. "ponytail (full)" — stays compact
            // even with many extensions loaded.
            out.push(status ? `${name} (${status})` : name);
        }
        return out;
    }

    getWarnings(): string[] {
        return [...this.warnings.values()].flat();
    }

    isLoaded(name: string): boolean {
        return this.loaded.has(name);
    }

    /** Unified list for the /extensions panel: built-ins + installed externals. */
    listAll(): ExtensionListEntry[] {
        const out: ExtensionListEntry[] = BUILTIN_EXTENSIONS.map((b) => ({
            name: b.name,
            displayName: b.displayName,
            description: b.description,
            enabled: getBuiltinEnabled(b.name, b.defaultEnabled),
            builtin: true,
        }));
        for (const r of listRecords()) {
            out.push({
                name: r.name,
                displayName: r.name,
                enabled: r.enabled,
                builtin: false,
                version: r.version,
                source: r.source,
                linkPath: r.linkPath,
            });
        }
        return out;
    }
}

/** Apply one extension's command ops to a registry. Exported for tests. */
export function applyCommandOps(reg: import("../commands").CommandRegistry, ops: CommandOp[]): void {
    for (const op of ops) {
        if (op.kind === "register") reg.register(op.cmd);
        else if (op.kind === "unregister") reg.unregister(op.name);
        else {
            // Merge over the command being overridden so fields the partial
            // omits (e.g. description) survive the override.
            const existing = reg.get(op.name);
            reg.register({
                ...existing,
                ...op.cmd,
                name: op.name,
                description: op.cmd.description ?? existing?.description ?? op.name,
                handler: op.cmd.handler,
            });
        }
    }
}

let singleton: ExtensionHost | undefined;

export function getExtensionHost(): ExtensionHost {
    if (!singleton) singleton = new ExtensionHost();
    return singleton;
}
