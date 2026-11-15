import type { CommandRegistry } from "../registry";
import { DATA_ANALYST_AGENT_NAME, listAgents } from "../../agent/agents";

/** /<agent> for every agent but "default" (what plain messages already use), plus /data. */
export function registerAgentCommands(reg: CommandRegistry): void {
    for (const agent of listAgents()) {
        if (agent.name === "default") continue;
        registerAgentCommand(reg, agent.name);
    }

    // Short alias for the data-analyst agent.
    if (!reg.has("data")) {
        reg.register({
            name: "data",
            description: "Run one message with the data-analyst agent: /data <message>",
            handler: (ctx, args) => ctx.useAgent(DATA_ANALYST_AGENT_NAME, args || undefined),
        });
    }
}

/** Register /<name> for an agent. Skipped when the name collides with an existing command. */
export function registerAgentCommand(reg: CommandRegistry, name: string): boolean {
    if (reg.has(name)) return false;
    reg.register({
        name,
        description: `Run one message with agent "${name}": /${name} <message>`,
        handler: (ctx, args) => ctx.useAgent(name, args || undefined),
    });
    return true;
}
