/**
 * /shells — the user's half of background shells. The agent reaches them
 * through the `shells` tool; this is the same registry from the other side, so
 * a process the agent started (or forgot) can always be inspected and killed
 * by hand.
 *
 * `/shells` opens a picker: choose a shell, then stop it or read its output ·
 * `/shells run <cmd>` starts one · `/shells kill <id>` or `/shells kill all`
 * stops them without a menu · `/shells <id>` prints the tail of one shell's log
 * into the transcript.
 *
 * `run` is the user's own hand on the keyboard, so it skips the denylist and
 * the approval prompt — those exist to gate what the MODEL runs, and a person
 * typing a command into their own shell has already approved it. It lands in
 * the same registry, so a server the user starts is one the agent can read.
 */
import { spawn } from "node:child_process";
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    formatDuration,
    getShellConfig,
    getShellEnv,
    killSessionShells,
    killShell,
    listShells,
    readShell,
    registerShell,
    runningShellCount,
    MAX_BACKGROUND_SHELLS,
    type CommandContext,
    type ShellInfo,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { dim, heading } from "../ui/text";

type ShellsHandlers = Pick<CommandContext, "manageShells">;

/** The picker's "stop every running shell" row — not a shell id, so it cannot collide with one. */
const STOP_ALL = "\0stop-all";

function statusText(s: ShellInfo): string {
    if (s.status === "running") return `running ${formatDuration(Date.now() - s.startedAt)}`;
    if (s.status === "killed") return "killed";
    if (s.status === "failed") return "failed to start";
    return s.exitCode === 0 ? "exited 0" : `exited ${s.exitCode ?? "?"}`;
}

function firstLine(command: string): string {
    return command.split("\n")[0];
}

/** One picker row per shell, running ones first, plus "stop all" when more than one is running. */
export function shellPickerItems(shells: readonly ShellInfo[]): SelectItem[] {
    const running = shells.filter((s) => s.status === "running");
    const ordered = [...running, ...shells.filter((s) => s.status !== "running")];
    const items: SelectItem[] = ordered.map((s) => ({
        value: s.id,
        label: `${s.id}  ${firstLine(s.command)}`,
        description: statusText(s),
    }));
    if (running.length > 1) {
        items.unshift({ value: STOP_ALL, label: `Stop all ${running.length} running shells`, description: "" });
    }
    return items;
}

export function createShellsHandlers(state: AppState, deps: AppDeps): ShellsHandlers {
    const { tui, history, shellsPanel } = deps;
    const sessionId = () => state.session?.id;

    const refresh = () => {
        shellsPanel.setShells(listShells(sessionId()));
        tui.requestRender();
    };

    const say = (text: string) => {
        history.addSystem(text);
        tui.requestRender();
    };

    const fail = (text: string) => {
        history.addError(text);
        tui.requestRender();
    };

    function stopAll(): void {
        const n = killSessionShells(sessionId());
        history.addSystem(n > 0 ? `Stopped ${n} shell${n === 1 ? "" : "s"}.` : dim("Nothing was running."));
        refresh();
    }

    function stopOne(id: string): void {
        const info = killShell(sessionId(), id);
        if (!info) history.addError(`No shell ${id}.`);
        else history.addSystem(`${info.id} stopped.`);
        refresh();
    }

    function runShell(command: string): void {
        if (!command) return fail("Usage: /shells run <command>");
        if (runningShellCount(sessionId()) >= MAX_BACKGROUND_SHELLS) {
            return fail(`Already running ${MAX_BACKGROUND_SHELLS} shells — stop one first.`);
        }
        try {
            const { shell, args: shellArgs } = getShellConfig();
            const child = spawn(shell, [...shellArgs, command], {
                cwd: state.cwd,
                detached: process.platform !== "win32",
                env: getShellEnv(),
                stdio: ["ignore", "pipe", "pipe"],
            });
            const info = registerShell({ sessionId: sessionId(), command, cwd: state.cwd, child });
            history.addSystem(`${info.id} started (pid ${info.pid ?? "?"}) · ${command}`);
        } catch (err) {
            history.addError(`Could not start: ${(err as Error).message}`);
        }
        refresh();
    }

    /**
     * Print a shell's recent output. `advance: false` deliberately — reading
     * along with the agent must not consume output the agent has not seen yet.
     */
    function showOutput(id: string): void {
        const result = readShell(sessionId(), id, { advance: false });
        if (!result) return fail(`No shell ${id}. Try /shells.`);
        const body = result.text.trim();
        say(
            [
                heading(`${result.info.id} — ${statusText(result.info)}`),
                dim(firstLine(result.info.command)),
                "",
                body || dim("(no output yet)"),
            ].join("\n"),
        );
    }

    /** What to do with the shell the user picked: stop it (when it runs) or read it. */
    async function actOn(shell: ShellInfo): Promise<void> {
        const actions: SelectItem[] = [];
        if (shell.status === "running") actions.push({ value: "stop", label: "Stop it", description: "" });
        actions.push({ value: "output", label: "Show its output", description: "" });
        const action = await deps.selectOnce(actions, `${shell.id} · ${firstLine(shell.command)}`);
        if (action?.value === "stop") stopOne(shell.id);
        else if (action?.value === "output") showOutput(shell.id);
    }

    /** `/shells` alone: the picker, the visible way to stop something. */
    async function pickShell(): Promise<void> {
        const shells = listShells(sessionId());
        if (shells.length === 0) {
            return say(dim("No background shells. /shells run <cmd> starts one, or bash run_in_background does."));
        }
        const picked = await deps.selectOnce(shellPickerItems(shells), "Background shells — pick one to stop or read");
        if (!picked) return;
        if (picked.value === STOP_ALL) return stopAll();
        const shell = shells.find((s) => s.id === picked.value);
        if (shell) await actOn(shell);
    }

    function kill(target: string | undefined): void {
        if (!target) return fail("Usage: /shells kill <id> · /shells kill all");
        if (target === "all") stopAll();
        else stopOne(target);
    }

    return {
        async manageShells(args: string) {
            const trimmed = args.trim();
            const [verb, target] = trimmed.split(/\s+/).filter(Boolean);
            if (!verb) return pickShell();
            if (verb === "run") return runShell(trimmed.slice(verb.length).trim());
            if (verb === "kill" || verb === "stop") return kill(target);
            // Anything else is treated as a shell id.
            showOutput(verb);
        },
    };
}
