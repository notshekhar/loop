import type { SlashCommand } from "../registry";
import { PRODUCT_NAME } from "../../brand";
import { setSetting } from "../../settings";
import { playCue, soundLevel, type SoundLevel } from "../../notifications/sound";
import { aliasOf } from "./define";

export const soundCommand: SlashCommand = {
    name: "sound",
    description: "Interface chimes: /sound · /sound on|off|max",
    handler: (ctx, args) => {
        const arg = args.trim().toLowerCase();
        const current = soundLevel();
        // Bare /sound toggles; `max` is only ever asked for explicitly,
        // so a toggle can never surprise someone with the chatty tier.
        const next: SoundLevel | undefined =
            arg === ""
                ? current === "off"
                    ? "on"
                    : "off"
                : arg === "on" || arg === "off" || arg === "max"
                  ? arg
                  : undefined;
        if (!next) return ctx.emit("error", "usage: /sound [on|off|max]");

        setSetting("sound", next);
        // Confirm by ear as well as on screen — the whole point of the
        // setting is whether you can hear it, and at `off` the silence
        // is the confirmation.
        if (next !== "off") playCue("click");
        const where = process.platform === "darwin" ? "" : " (terminal bell — chimes need macOS)";
        ctx.emit("help", `sound ${next}${where}`);
    },
};

const changelogCommand: SlashCommand = {
    name: "changelog",
    description: "Show changelog entries",
    handler: (ctx) => ctx.showChangelog(),
};

/** The app itself: settings, theme, keys, reload and updates. */
export const appCommands: SlashCommand[] = [
    {
        name: "settings",
        description: "Open settings menu",
        handler: async (ctx) => {
            await ctx.openSettings();
        },
    },
    {
        name: "theme",
        description: "Show or switch the theme: /theme · /theme <name>",
        handler: (ctx, args) => ctx.switchTheme(args ?? ""),
    },
    {
        name: "hotkeys",
        description: "Show all keyboard shortcuts",
        handler: (ctx) => {
            ctx.showHotkeys();
        },
    },
    {
        name: "reload",
        description: "Reload prompts, keybindings, settings",
        handler: async (ctx) => {
            await ctx.reload();
        },
    },
    {
        name: "update",
        description: `Update ${PRODUCT_NAME} to the latest release`,
        handler: async (ctx) => {
            await ctx.updateApp();
        },
    },
    changelogCommand,
    aliasOf(changelogCommand, "release-notes"),
];

/** What the agent may use: agents, hooks, guardrails, MCP, extensions, datasources. */
export const configCommands: SlashCommand[] = [
    {
        name: "agents",
        description: "Create, select, or edit agents (custom system prompts)",
        handler: async (ctx) => {
            await ctx.manageAgents();
        },
    },
    {
        name: "hooks",
        description: "List, add, and remove lifecycle hooks (loop-owned and imported)",
        handler: async (ctx) => {
            await ctx.manageHooks();
        },
    },
    {
        name: "bashdeny",
        description: "Add or remove bash commands the agent is refused (denylist guardrail)",
        handler: async (ctx) => {
            await ctx.manageBashDeny();
        },
    },
    {
        name: "permissions",
        description: "Manage allow/ask/deny permission rules (Bash(git *), Read(secrets/**), …)",
        handler: async (ctx) => {
            await ctx.managePermissions();
        },
    },
    // /mcp is always available — the panel handles the disabled/no-servers case
    // itself, and registering it unconditionally means toggling `mcp` in
    // /settings takes effect without rebuilding the command list or restarting.
    {
        name: "mcp",
        description: "List MCP servers and their tools (mcp reconnect [name])",
        handler: (ctx, args) => ctx.manageMcp(args.trim()),
    },
    {
        name: "extensions",
        description: "Manage extensions: enable/disable, uninstall, info, reload",
        handler: (ctx, args) => ctx.manageExtensions(args.trim()),
    },
    {
        name: "install",
        description: "Install an extension: /install <npm|github|path>",
        handler: (ctx, args) => ctx.manageExtensions(`install ${args}`.trim()),
    },
    {
        name: "datasource",
        description: "Manage database connections for the data-analyst agent",
        handler: async (ctx) => {
            await ctx.manageDatasources();
        },
    },
];

export const gatewaysCommand: SlashCommand = {
    name: "gateways",
    description: "Set up remote chat gateways — each runs as its own daemon",
    handler: async (ctx) => {
        await ctx.manageGateways();
    },
};
