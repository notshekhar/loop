/**
 * What one extension contributed, tracked per extension so unload can drop
 * exactly that — plus how command contributions apply to a registry and how
 * live UI contributions are torn down.
 */
import type {
    AgentPlugin,
    DockHandle,
    ExtensionManifest,
    ExtensionModule,
    ExtensionThemeJson,
    ProviderPlugin,
    StatusLineContributor,
    StatusLineTransform,
    TerminalHandle,
    ToolCallMiddleware,
    ToolResultMiddleware,
    ToolSummaryRenderer,
    TurnMiddleware,
    WidgetHandle,
} from "../api";
import type { ExtensionRecord } from "../store";
import { clearContextPolicy, getContextPolicy } from "../../agent/context-policy";

export type Tool = unknown; // ai-sdk Tool; kept loose here to avoid a hard ai import in the host
type SlashCommand = import("../../commands").SlashCommand;
export type ModelInfo = import("../../types").ModelInfo;
type CommandRegistry = import("../../commands").CommandRegistry;

export type ToolMatcher = (name: string) => boolean;

export type CommandOp =
    | { kind: "register"; cmd: SlashCommand }
    | { kind: "override"; name: string; cmd: Partial<SlashCommand> & { handler: SlashCommand["handler"] } }
    | { kind: "unregister"; name: string };

export interface Contributions {
    commandOps: CommandOp[];
    tools: Map<string, Tool>;
    toolRemovals: Set<string>;
    toolGrants: { agent: string; tool: string }[];
    toolCallMws: { match: ToolMatcher; mw: ToolCallMiddleware }[];
    toolResultMws: { match: ToolMatcher; mw: ToolResultMiddleware }[];
    toolSummaries: { match: ToolMatcher; fn: ToolSummaryRenderer }[];
    themes: ExtensionThemeJson[];
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

export interface Loaded {
    record: ExtensionRecord;
    manifest: ExtensionManifest;
    pkgDir: string;
    module: ExtensionModule;
    contributions: Contributions;
}

export function emptyContributions(): Contributions {
    return {
        commandOps: [],
        tools: new Map(),
        toolRemovals: new Set(),
        toolGrants: [],
        toolCallMws: [],
        toolResultMws: [],
        toolSummaries: [],
        themes: [],
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

export function toMatcher(match: string | string[] | ToolMatcher): ToolMatcher {
    if (typeof match === "function") return match;
    const set = new Set(Array.isArray(match) ? match : [match]);
    return (name: string) => set.has(name);
}

/** Apply one extension's command ops to a registry. Exported for tests. */
export function applyCommandOps(reg: CommandRegistry, ops: CommandOp[]): void {
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

/**
 * Release what an unloaded extension left live: global state and painted UI
 * that outlive the contribution lists, so they are torn down here rather than
 * simply dropped.
 */
export function releaseLiveContributions(c: Contributions): void {
    // A context policy is global singleton state, not a list the host
    // filters on read — so unloading its owner has to release it explicitly
    // or a disabled extension keeps owning the context boundary.
    if (c.contextPolicies.includes(getContextPolicy()?.name ?? "")) clearContextPolicy();
    // A widget the TUI already removed, or a dock already closed, is still
    // unloaded — and so is a listener the TUI already dropped.
    disposeEach(c.widgets, (widget) => widget.hide());
    disposeEach(c.docks, (dock) => dock.close());
    // Terminals are child processes: dropping the reference would leave a
    // shell running with nothing able to reach or stop it.
    disposeEach(c.terminals, (term) => term.kill());
    disposeEach(c.keymapDisposers, (dispose) => dispose());
}

/** Run `dispose` on every item; one that throws (already gone) never stops the rest. */
function disposeEach<T>(items: T[], dispose: (item: T) => void): void {
    for (const item of items) {
        try {
            dispose(item);
        } catch {
            // already gone
        }
    }
}
