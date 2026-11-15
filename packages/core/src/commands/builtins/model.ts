import type { SlashCommand } from "../registry";
import { aliasOf } from "./define";

/** Provider sign-in and the active model/provider. */
export const accountCommands: SlashCommand[] = [
    {
        name: "login",
        description: "Configure provider authentication",
        handler: async (ctx, args) => {
            await ctx.startLogin(args || undefined);
        },
    },
    {
        name: "logout",
        description: "Remove provider authentication (opens picker)",
        handler: async (ctx, args) => {
            await ctx.startLogout(args || undefined);
        },
    },
    {
        name: "model",
        description: "Select model (opens picker, or /model provider/id)",
        handler: async (ctx, args) => {
            if (args) await ctx.setModel(args);
            else await ctx.openModelPicker();
        },
    },
    {
        name: "provider",
        description: "Switch active provider (opens picker, or /provider <id>)",
        handler: async (ctx, args) => {
            await ctx.setProvider(args || undefined);
        },
    },
];

const thinkingCommand: SlashCommand = {
    name: "thinking",
    description: "Set reasoning/thinking level (off|minimal|low|medium|high|xhigh)",
    handler: async (ctx, args) => {
        await ctx.setThinking(args || undefined);
    },
};

export const thinkingCommands: SlashCommand[] = [
    thinkingCommand,
    aliasOf(
        thinkingCommand,
        "effort",
        "Alias for /thinking — set reasoning effort (off|minimal|low|medium|high|xhigh)",
    ),
];

export const scopedModelsCommand: SlashCommand = {
    name: "scoped-models",
    description: "Enable/disable models for Ctrl+P cycling (panel, or add/rm <id>)",
    handler: async (ctx, args) => {
        await ctx.manageScopedModels(args.trim());
    },
};
