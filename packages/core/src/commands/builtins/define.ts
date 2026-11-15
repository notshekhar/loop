import type { SlashCommand } from "../registry";

/** A second name for `target` — same handler, its own description. */
export function aliasOf(target: SlashCommand, name: string, description = `Alias for /${target.name}`): SlashCommand {
    return { name, description, handler: target.handler };
}
