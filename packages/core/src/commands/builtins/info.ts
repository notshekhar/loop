import type { CommandRegistry, SlashCommand } from "../registry";
import { PRODUCT_NAME } from "../../brand";
import { aliasOf } from "./define";

/** /help — lists whatever is registered at the time it runs, so late additions show up. */
export function helpCommand(reg: CommandRegistry): SlashCommand {
    return {
        name: "help",
        description: "Show available commands",
        handler: (ctx) => {
            const lines = reg.list().map((c) => `/${c.name} — ${c.description}`);
            ctx.emit("help", lines.join("\n"));
        },
    };
}

const notesCommand: SlashCommand = {
    name: "notes",
    description: "This session's notes: /notes opens them (submit or delete one, remove all) · /notes <text> adds one",
    handler: (ctx, args) => ctx.manageNotes(args ?? ""),
};

/** Usage, context and the session's side panels. */
export const statusCommands: SlashCommand[] = [
    {
        name: "cost",
        description: "Show cost breakdown (session, directory, today, 7d, month, lifetime)",
        handler: (ctx) => ctx.showCost(),
    },
    {
        name: "context",
        description: "Show context window usage breakdown",
        handler: async (ctx) => {
            await ctx.showContext();
        },
    },
    {
        name: "shells",
        description:
            "Background shells: /shells picks one to stop or read · /shells run <cmd> · /shells <id> · /shells kill <id>|all",
        handler: (ctx, args) => ctx.manageShells(args ?? ""),
    },
    notesCommand,
    aliasOf(notesCommand, "note", "Add a note to this session: /note <text>"),
    {
        name: "steak",
        description: "Token-usage heatmap, GitHub-contributions style: /steak · /steak <year>",
        handler: (ctx, args) => ctx.showSteak(args ?? ""),
    },
];

/** /init — runs as a normal agent turn via the "run-prompt" emit. */
export const INIT_PROMPT = `Analyze this codebase and write an AGENTS.md file for coding agents working in this repository.

First check whether AGENTS.md (or CLAUDE.md) already exists at the repo root — if it does, read it and improve it in place: fill gaps, fix anything stale, keep what's accurate. Don't create a duplicate.

What to include (only what you can verify from the repo):
- The exact commands to build, test (including running a single test), lint, and typecheck.
- A short architecture overview: the main packages/directories and how they relate.
- Project-specific conventions an agent must follow (code style, naming, error handling, commit rules).
- Gotchas that would trip up a newcomer (non-obvious setup, generated files, things that must be run after edits).

Keep it concise — aim for 20-60 lines. No generic advice ("write clean code"), no restating what's obvious from file names. Every line should save an agent a wrong turn.`;

/** Recaps, diagnostics and AGENTS.md memory. */
export const assistCommands: SlashCommand[] = [
    {
        name: "recap",
        description: "Generate a short recap of the last turn now",
        handler: async (ctx) => {
            await ctx.generateRecap();
        },
    },
    {
        name: "doctor",
        description: `Diagnose and verify your ${PRODUCT_NAME} installation and settings`,
        handler: async (ctx) => {
            await ctx.runDoctor();
        },
    },
    {
        name: "memory",
        description: "Open an AGENTS.md memory file in your editor",
        handler: async (ctx) => {
            await ctx.openMemory();
        },
    },
    {
        name: "init",
        description: "Analyze the codebase and create or improve AGENTS.md",
        handler: (ctx) => ctx.emit("run-prompt", INIT_PROMPT),
    },
];

/** Pages and traces the session produced, opened in the browser. */
export const reportCommands: SlashCommand[] = [
    {
        name: "artifacts",
        description: "Pages the agent wrote — pick one to open it in your browser",
        handler: async (ctx) => {
            await ctx.manageArtifacts();
        },
    },
    {
        name: "trace",
        description: "Where this session's time and money went — opens in your browser (path optional)",
        handler: async (ctx, args) => {
            await ctx.openTrace(args.trim() || undefined);
        },
    },
];
