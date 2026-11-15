import type { SlashCommand } from "../registry";
import { aliasOf } from "./define";

/** Start over, compact, or switch the session into plan mode. */
export const lifecycleCommands: SlashCommand[] = [
    {
        name: "new",
        description: "Start a new session",
        handler: async (ctx) => {
            await ctx.newSession();
        },
    },
    {
        name: "clear",
        description: "Start a new session (clears screen)",
        handler: async (ctx) => {
            ctx.clearScreen();
            await ctx.newSession();
        },
    },
    {
        name: "compact",
        description: "Compact the session context now (/compact <focus> steers the summary)",
        handler: async (ctx, args) => {
            await ctx.manualCompact(args);
        },
    },
    {
        name: "plan",
        description: "Toggle plan mode — read-only until a plan is approved (/plan <task> to start planning)",
        handler: async (ctx, args) => {
            await ctx.togglePlanMode(args);
        },
    },
];

const resumeCommand: SlashCommand = {
    name: "resume",
    description: "Resume a different session",
    handler: async (ctx) => {
        await ctx.showSessions();
    },
};

const nameCommand: SlashCommand = {
    name: "name",
    description: "Set session display name (no arg = rename prompt)",
    handler: (ctx, args) => ctx.setSessionName(args ?? ""),
};

/** Moving between sessions, hosts and team threads, and naming this one. */
export const navigationCommands: SlashCommand[] = [
    resumeCommand,
    aliasOf(resumeCommand, "sessions"),
    {
        name: "hosts",
        description: "Other machines: switch to one, pair one (/hosts add <link>), /hosts remove <name>",
        handler: async (ctx, args) => {
            await ctx.manageHosts(args);
        },
    },
    {
        name: "rc",
        description: "Remote control: let your phone or another loop drive this one (/rc off to stop)",
        handler: async (ctx, args) => {
            await ctx.remoteControl(args);
        },
    },
    {
        name: "team",
        description: "Thread team: see every thread and jump to one (/team stop stops them all)",
        handler: async (ctx, args) => {
            if (ctx.manageTeam) await ctx.manageTeam(args);
            else ctx.stub("team");
        },
    },
    {
        name: "lead",
        description: "Back to the thread that started this one (thread teams)",
        handler: async (ctx) => {
            if (ctx.manageTeam) await ctx.manageTeam("lead");
            else ctx.stub("lead");
        },
    },
    {
        name: "session",
        description: "Show session info and stats",
        handler: (ctx) => {
            ctx.showSessionInfo();
        },
    },
    nameCommand,
    aliasOf(nameCommand, "rename"),
];

/** Images into the next message. */
export const attachCommands: SlashCommand[] = [
    {
        name: "attach",
        description: "Attach an image (paste from clipboard, or /attach <path>)",
        handler: async (ctx, args) => {
            await ctx.attachImage(args || undefined);
        },
    },
    {
        name: "paste",
        description: "Alias for /attach (paste image from clipboard)",
        handler: async (ctx) => {
            await ctx.attachImage();
        },
    },
];

const cdCommand: SlashCommand = {
    name: "cd",
    description: "Move this session to a new working directory: /cd <path>",
    handler: (ctx, args) => {
        if (!args) return ctx.emit("help", `cwd: ${ctx.cwd}`);
        ctx.setCwd(args);
    },
};

export const cwdCommands: SlashCommand[] = [cdCommand, aliasOf(cdCommand, "cwd")];

/** Getting the transcript out (clipboard, file) and back in. */
export const transcriptCommands: SlashCommand[] = [
    {
        name: "copy",
        description: "Copy last assistant message to clipboard",
        handler: async (ctx) => {
            await ctx.copyLastAssistant();
        },
    },
    {
        name: "export",
        description: "Export session (path optional, .jsonl/.html)",
        handler: async (ctx, args) => {
            await ctx.exportSession(args || undefined);
        },
    },
    {
        name: "import",
        description: "Import a session from a JSONL file",
        handler: async (ctx, args) => {
            if (!args) return ctx.emit("error", "usage: /import <path>");
            await ctx.importSession(args);
        },
    },
];

/** Branching the session tree, and sharing it. */
export const branchCommands: SlashCommand[] = [
    {
        name: "fork",
        description: "Create a new fork from a previous user message",
        handler: (ctx) => ctx.forkFromMessage(),
    },
    {
        name: "clone",
        description: "Duplicate the current session at current position",
        handler: async (ctx) => {
            await ctx.cloneSession();
        },
    },
    { name: "tree", description: "Navigate session tree (switch branches)", handler: (ctx) => ctx.showTree() },
    {
        name: "share",
        description: "Share session as a secret GitHub gist (needs gh CLI)",
        handler: async (ctx) => {
            await ctx.shareSession();
        },
    },
];

/** Work that leaves this conversation: saved recipes, side threads, handoffs. */
export const workflowCommands: SlashCommand[] = [
    {
        name: "recipe",
        description: "Reusable workflows: save <name> [focus], list, show/edit/rm <name>, or <name> [inputs]",
        handler: (ctx, args) => ctx.manageRecipes(args.trim()),
    },
    {
        name: "btw",
        description:
            "Ask a side question in its own thread — the conversation here never sees it (/btw lists them, /btw back returns)",
        handler: async (ctx, args) => {
            if (ctx.askBtw) await ctx.askBtw(args.trim());
            else ctx.stub("btw");
        },
    },
    {
        name: "handoff",
        description: "Continue in a fresh session with an editable brief and model/agent choice (optional focus)",
        handler: (ctx, args) => ctx.manageHandoff(args.trim()),
    },
];

const quitCommand: SlashCommand = { name: "quit", description: "Quit loop-agent", handler: (ctx) => ctx.exit() };

export const quitCommands: SlashCommand[] = [quitCommand, aliasOf(quitCommand, "exit")];
