import { getAppProfile } from "../app-profile";
import type { CommandRegistry, SlashCommand } from "./registry";
import { registerAgentCommands } from "./builtins/agent-commands";
import { aliasCommand, registerUserAliases } from "./builtins/alias";
import { assistCommands, helpCommand, reportCommands, statusCommands } from "./builtins/info";
import { accountCommands, scopedModelsCommand, thinkingCommands } from "./builtins/model";
import { scheduleCommands } from "./builtins/schedule";
import {
    attachCommands,
    branchCommands,
    cwdCommands,
    lifecycleCommands,
    navigationCommands,
    quitCommands,
    transcriptCommands,
    workflowCommands,
} from "./builtins/session";
import { appCommands, configCommands, gatewaysCommand, soundCommand } from "./builtins/settings";
import { registerPromptCommands, registerSkillCommands } from "./builtins/skills-and-prompts";

export { CommandRegistry, type CommandContext, type ImportPreview, type SlashCommand } from "./registry";
export { INIT_PROMPT } from "./builtins/info";
export { registerAliasCommand } from "./builtins/alias";
export { registerAgentCommand } from "./builtins/agent-commands";

/** Builtins in the order /help and the palette list them — the order here is the order users see. */
function builtinCommands(reg: CommandRegistry): SlashCommand[] {
    return [
        helpCommand(reg),
        ...accountCommands,
        ...lifecycleCommands,
        ...thinkingCommands,
        ...navigationCommands,
        ...scheduleCommands,
        ...statusCommands,
        ...attachCommands,
        soundCommand,
        ...cwdCommands,
        ...transcriptCommands,
        ...appCommands,
        ...assistCommands,
        ...configCommands,
        ...branchCommands,
        scopedModelsCommand,
        gatewaysCommand,
        ...reportCommands,
        ...workflowCommands,
        ...quitCommands,
        aliasCommand(reg),
    ];
}

export async function registerBuiltins(reg: CommandRegistry, opts: { cwd?: string } = {}): Promise<void> {
    for (const c of builtinCommands(reg)) reg.register(c);

    for (const name of getAppProfile().hiddenCommands ?? []) reg.unregister(name);
    for (const cmd of getAppProfile().commands ?? []) reg.register(cmd);

    await registerSkillCommands(reg, opts.cwd ?? process.cwd());
    registerPromptCommands(reg);
    if (getAppProfile().agents !== false) registerAgentCommands(reg);
    registerUserAliases(reg);
}
