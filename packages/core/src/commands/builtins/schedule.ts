import type { SlashCommand } from "../registry";
import { aliasOf } from "./define";

const reminderCommand: SlashCommand = {
    name: "reminder",
    description: "Manage reminders (one-time or cron-scheduled)",
    handler: (ctx) => ctx.openReminders(),
};

const backgroundCommand: SlashCommand = {
    name: "background",
    description: "Background tasks: /background opens the manager · /background <text> runs or schedules one",
    handler: (ctx, args) => ctx.manageBackground(args ?? ""),
};

/** Timers, reminders, background tasks and goal mode — work that runs on its own clock. */
export const scheduleCommands: SlashCommand[] = [
    {
        name: "timer",
        description: "Countdown timer: /timer 1h30m · /timer off · /timer shows remaining",
        handler: (ctx, args) => ctx.setTimer(args ?? ""),
    },
    reminderCommand,
    aliasOf(reminderCommand, "reminders"),
    backgroundCommand,
    aliasOf(backgroundCommand, "bg"),
    {
        name: "goal",
        description: "Goal mode: /goal <objective> works autonomously until verified done · pause|resume|status|clear",
        handler: (ctx, args) => ctx.manageGoalMode(args ?? ""),
    },
    {
        name: "daemon",
        description: "Background scheduler for background tasks: /daemon toggles it · /daemon on|off|status",
        handler: (ctx, args) => ctx.manageDaemon(args ?? ""),
    },
];
