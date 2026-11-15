/**
 * Read side of the host: every extension's contributions merged into the
 * views the rest of the app consumes (commands, tools, middleware, providers,
 * models, agents, skills, themes, status line).
 */
import type {
    AgentPlugin,
    ExtensionThemeJson,
    ProviderPlugin,
    StatusLineContributor,
    StatusLineTransform,
    ToolCallMiddleware,
    ToolResultMiddleware,
    ToolSummaryContext,
    TurnMiddleware,
} from "../api";
import { collectProviderModelInfos } from "../providers";
import { applyCommandOps, type Loaded, type ModelInfo, type Tool, type ToolMatcher } from "./contributions";

export class ContributionAggregates {
    /** Every loaded extension, keyed by name, in load order. */
    protected readonly loaded = new Map<string, Loaded>();

    /** Apply every extension's command ops to a registry (after builtins). */
    applyCommands(reg: import("../../commands").CommandRegistry): void {
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

    getToolCallMiddleware(): { match: ToolMatcher; mw: ToolCallMiddleware }[] {
        return [...this.loaded.values()].flatMap((l) => l.contributions.toolCallMws);
    }

    getToolResultMiddleware(): { match: ToolMatcher; mw: ToolResultMiddleware }[] {
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
     * Palettes contributed by extensions. The CLI resolves theme names against
     * these alongside its own — core only collects them, since the theme
     * engine lives in the CLI.
     */
    getThemes(): ExtensionThemeJson[] {
        return [...this.loaded.values()].flatMap((l) => l.contributions.themes);
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

    isLoaded(name: string): boolean {
        return this.loaded.has(name);
    }
}
