/**
 * Capabilities served by calling core directly, with no wire protocol.
 *
 * This is the point of embedding core. Everything in `RPC_METHODS` had to be
 * designed as a protocol — a name, a dispatch case, a `server.info` entry, a
 * guard for the case where the installed binary predates the app. Nothing here
 * needs any of that: core is imported, so a capability is a function call and
 * a line in this table.
 *
 * `CoreHost` checks this table before handing anything to core's own dispatch,
 * so a name here shadows the RPC of the same name. Names are still
 * `namespace.verb` because that is the shape `window.loop.call` already
 * carries, and because it keeps the two halves visually consistent from the
 * renderer's side.
 *
 * **These exist only when core is embedded.** With `LOOP_SPAWN_BINARY=1`, and
 * over `loop serve` in a browser, the request reaches core's RPC dispatch
 * instead and fails as an unknown method — which is honest: those surfaces
 * genuinely cannot do this yet.
 */
import {
    addGoal,
    addReminder,
    deleteGoal,
    deleteReminder,
    listGoals,
    listReminders,
    updateGoal,
    updateReminder,
    type GoalSchedule,
    type ReminderSchedule,
} from "@notshekhar/loop-core/embed-scheduling";

/** A handler: whatever the renderer sent, answered from core. */
export type DirectHandler = (params: Record<string, unknown>) => unknown;

function str(value: unknown, what: string): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new Error(`${what} is required`);
    return text;
}

/**
 * A schedule off the wire.
 *
 * Validated rather than trusted: a cron expression is stored verbatim and
 * executed by the daemon later, so a malformed one becomes a task that
 * silently never runs. `once` timestamps are checked for being a real number
 * for the same reason — `at: NaN` is a reminder that can never be due.
 */
function reminderSchedule(raw: unknown): ReminderSchedule {
    const record = (raw ?? {}) as Record<string, unknown>;
    if (record.kind === "cron") {
        return { kind: "cron", expr: str(record.expr, "a cron expression") };
    }
    const at = Number(record.at);
    if (!Number.isFinite(at)) throw new Error("a one-off reminder needs a time");
    return { kind: "once", at };
}

function goalSchedule(raw: unknown): GoalSchedule {
    const record = (raw ?? {}) as Record<string, unknown>;
    if (record.kind === "cron") {
        return { kind: "cron", expr: str(record.expr, "a cron expression") };
    }
    if (record.kind === "once") {
        const at = Number(record.at);
        if (!Number.isFinite(at)) throw new Error("a one-off task needs a time");
        return { kind: "once", at };
    }
    // "none" is a real state, not a fallback: an unscheduled task is one the
    // user runs on demand.
    return { kind: "none" };
}

/** Optional string patch field: absent leaves it alone, null clears it. */
function optional(record: Record<string, unknown>, key: string): string | null | undefined {
    if (!(key in record)) return undefined;
    const value = record[key];
    if (value === null || value === "") return null;
    return String(value);
}

export function createDirectHandlers(): Record<string, DirectHandler> {
    return { ...reminderHandlers(), ...backgroundTaskHandlers() };
}

/**
 * Reminders — the terminal's /reminder.
 *
 * Deliberately reported with `firesOnlyWhileOpen`. Core's reminders fire
 * from a 1s ticker inside a running loop and there is NO seen/missed tracking
 * (see reminders.ts) — so a reminder set here is not an OS notification that
 * will find you later. A UI that implied otherwise would be lying about the
 * one thing that matters.
 */
function reminderHandlers(): Record<string, DirectHandler> {
    return {
        "reminders.list": () => ({
            reminders: listReminders(),
            firesOnlyWhileOpen: true,
        }),
        "reminders.add": (params) => ({
            reminder: addReminder(str(params.text, "reminder text"), reminderSchedule(params.schedule)),
        }),
        "reminders.update": (params) => {
            const patch: Parameters<typeof updateReminder>[1] = {};
            if (typeof params.text === "string") patch.text = params.text;
            if (typeof params.enabled === "boolean") patch.enabled = params.enabled;
            if (params.schedule !== undefined) patch.schedule = reminderSchedule(params.schedule);
            const reminder = updateReminder(str(params.id, "a reminder id"), patch);
            // `ok: false` rather than a throw: "already deleted" is an outcome
            // the caller can act on, not a fault.
            return reminder ? { ok: true, reminder } : { ok: false };
        },
        "reminders.remove": (params) => ({ ok: deleteReminder(str(params.id, "a reminder id")) }),
    };
}

/**
 * Background tasks — the terminal's /background.
 *
 * A task is bound to a folder, so `cwd` is required rather than defaulted:
 * silently attaching one to the process's anchor directory would run it
 * somewhere the user never chose.
 */
function backgroundTaskHandlers(): Record<string, DirectHandler> {
    return {
        "background.list": (params) => ({
            tasks: listGoals(typeof params.cwd === "string" && params.cwd ? params.cwd : undefined),
        }),
        "background.add": (params) => {
            const options: Parameters<typeof addGoal>[3] = {};
            const model = optional(params, "model");
            const agent = optional(params, "agent");
            if (model) options.model = model;
            if (agent) options.agent = agent;
            return {
                task: addGoal(
                    str(params.text, "task text"),
                    str(params.cwd, "a folder"),
                    goalSchedule(params.schedule),
                    options,
                ),
            };
        },
        "background.update": (params) => {
            const patch: Parameters<typeof updateGoal>[1] = {};
            if (typeof params.text === "string") patch.text = params.text;
            if (typeof params.enabled === "boolean") patch.enabled = params.enabled;
            const model = optional(params, "model");
            const agent = optional(params, "agent");
            if (model !== undefined) patch.model = model;
            if (agent !== undefined) patch.agent = agent;
            if (params.schedule !== undefined) patch.schedule = goalSchedule(params.schedule);
            const task = updateGoal(str(params.id, "a task id"), patch);
            return task ? { ok: true, task } : { ok: false };
        },
        "background.remove": (params) => ({ ok: deleteGoal(str(params.id, "a task id")) }),
    };
}
