import type { CommandContext, CommandRegistry, SlashCommand } from "../registry";
import { getSetting, setSetting } from "../../settings";

export function aliasCommand(reg: CommandRegistry): SlashCommand {
    return {
        name: "alias",
        description: "Command aliases: /alias · /alias <name> </cmd args…> · /alias rm <name>",
        handler: (ctx, args) => handleAliasCommand(reg, ctx, args),
    };
}

/**
 * User-defined aliases go last so they can never shadow a real command —
 * a stale alias silently loses to whatever claimed the name above.
 */
export function registerUserAliases(reg: CommandRegistry): void {
    for (const [name, expansion] of Object.entries(getSetting("aliases") ?? {})) {
        if (reg.has(name)) continue;
        registerAliasCommand(reg, name, expansion);
    }
}

const ALIAS_NAME_RE = /^[a-zA-Z0-9_:-]+$/;
/** Alias-within-alias dispatch depth cap; chains are fine, cycles are not. */
const MAX_ALIAS_DEPTH = 8;
let aliasDepth = 0;

/** Register /<name> that re-dispatches its expansion (extra args appended). */
export function registerAliasCommand(reg: CommandRegistry, name: string, expansion: string): void {
    reg.register({
        name,
        description: `Alias for ${expansion}`,
        handler: async (ctx, args) => {
            if (aliasDepth >= MAX_ALIAS_DEPTH) {
                ctx.emit("error", `/${name}: alias chain too deep (cycle?)`);
                return;
            }
            aliasDepth++;
            try {
                const input = args ? `${expansion} ${args}` : expansion;
                const handled = await reg.run(input, ctx);
                if (!handled) ctx.emit("error", `/${name} expands to unknown command: ${expansion}`);
            } finally {
                aliasDepth--;
            }
        },
    });
}

/**
 * /alias — list, define, or remove user aliases. Definitions persist in
 * settings and register immediately; "commands-changed" tells the host UI to
 * rebuild autocomplete.
 */
async function handleAliasCommand(reg: CommandRegistry, ctx: CommandContext, rawArgs: string): Promise<void> {
    const aliases = { ...(getSetting("aliases") ?? {}) };
    const args = rawArgs.trim();

    if (!args) {
        const entries = Object.entries(aliases);
        if (entries.length === 0) {
            ctx.emit("help", "No aliases defined. Usage: /alias <name> </cmd args…> · /alias rm <name>");
            return;
        }
        const w = Math.max(...entries.map(([n]) => n.length));
        ctx.emit("help", entries.map(([n, e]) => `/${n.padEnd(w)} → ${e}`).join("\n"));
        return;
    }

    const [first = "", second = ""] = args.split(/\s+/);
    if (first === "rm" || first === "remove" || first === "delete") {
        const name = second.replace(/^\//, "");
        if (!name) return ctx.emit("error", "usage: /alias rm <name>");
        if (!(name in aliases)) return ctx.emit("error", `no such alias: /${name}`);
        delete aliases[name];
        setSetting("aliases", aliases);
        reg.unregister(name);
        ctx.emit("help", `removed alias /${name}`);
        ctx.emit("commands-changed");
        return;
    }

    const name = first.replace(/^\//, "");
    const expansion = args.slice(args.indexOf(first) + first.length).trim();
    if (!expansion) {
        if (name in aliases) return ctx.emit("help", `/${name} → ${aliases[name]}`);
        return ctx.emit("error", "usage: /alias <name> </cmd args…>  e.g. /alias m /model");
    }
    if (!ALIAS_NAME_RE.test(name)) return ctx.emit("error", `invalid alias name: ${name}`);
    if (!expansion.startsWith("/")) return ctx.emit("error", `expansion must be a /command, got: ${expansion}`);
    if (name === "alias" || (reg.has(name) && !(name in aliases))) {
        return ctx.emit("error", `/${name} is an existing command — pick another name`);
    }

    aliases[name] = expansion;
    setSetting("aliases", aliases);
    reg.unregister(name);
    registerAliasCommand(reg, name, expansion);
    ctx.emit("help", `/${name} → ${expansion}`);
    ctx.emit("commands-changed");
}
