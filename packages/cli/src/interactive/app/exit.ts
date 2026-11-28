/**
 * The way out: give the terminal back, say what was left behind, release
 * everything loop holds, then exit.
 */
import {
    runHooks,
    closeAllPools,
    closeDb,
    getMcpManager,
    getExtensionHost,
    killAllBashChildren,
    getAppProfile,
    snapshotOwnProcesses,
    stopProcesses,
    type OwnProcess,
} from "@notshekhar/loop-core";
import { interruptRunningTurns } from "../still-running";
import { stopSystemSchemeProbes } from "../ui/system-scheme";
import { printResumeHint } from "../resume-hint";
import { resetCanvasWash } from "../ui/canvas-wash";
import { closeExtensionDocks } from "../extension-widgets";
import { stopRunningGateways } from "../gateway-process";
import type { AppCore } from "./context";
import type { PaneReporters } from "./reporters";

/** How long SessionEnd hooks and reporter releases get before loop exits regardless. */
const EXIT_GRACE_MS = 3_000;

export interface ExitParts {
    stopTicker: () => void;
    hideWorking: () => void;
    reporters: PaneReporters;
}

export function createCleanExit(core: AppCore, parts: ExitParts): (code?: number) => void {
    let leaving = false;
    return (code = 0) => {
        // The way out now waits for turns to settle; a second call in that
        // window would tear everything down twice.
        if (leaving) return;
        leaving = true;
        // FIRST, while the tree is whole: closing an MCP server below kills
        // only that process, and its own children go to pid 1 the same moment.
        const children = snapshotOwnProcesses();
        leaveScreen(core, parts);
        // After leaveScreen released the team runtime, so a thread that
        // settles here cannot hand its mail to a new turn on the way out.
        const turns = interruptRunningTurns(core.slots);
        printLeftovers(core, turns.count);
        // Put the tab back to a plain name: whatever spinner frame was showing
        // would otherwise be the last thing this terminal was told.
        parts.reporters.stopTerminalTitle();
        void turns.settled.then(() => releaseAndExit(core, parts.reporters, code, children));
    };
}

function leaveScreen(core: AppCore, parts: ExitParts): void {
    const { tui, late } = core;
    parts.stopTicker();
    // Sockets to other machines, and /rc's server if it is on.
    late.remoteSessions?.dispose();
    late.teamSessions?.dispose();
    // BEFORE tui.stop(): the exit path renders this frame one last time,
    // without a viewport, and that render is what lands in the user's
    // scrollback. A dock still mounted would print its rows there — a band
    // of dead panel under the conversation, permanently. Extensions are
    // only deactivated further down (after tui.stop), which is too late.
    closeExtensionDocks();
    // Paint the dock-free frame synchronously. requestRender defers to the
    // next tick, and tui.stop() runs before that tick ever arrives — so
    // without this the last thing painted still contains the panel, and its
    // rows are left on the terminal above the returning shell prompt.
    tui.renderNow(true);
    // Clear the OSC 9;4 tab progress bar before leaving the TUI.
    parts.hideWorking();
    // BEFORE tui.stop(): a query still in flight when the TUI lets go of
    // stdin is answered into the SHELL.
    stopSystemSchemeProbes();
    tui.stop();
    // Give the terminal its own background back (OSC 111; no-op unwashed).
    resetCanvasWash();
}

function printLeftovers(core: AppCore, interrupted: number): void {
    const { slots, state } = core;
    // Background shells die with the loop that started them. They are
    // process-lifetime by design (nothing is persisted, nothing is adopted
    // on resume), so leaving them running would strand processes nobody
    // can see or kill. The helper covers the detached foreground strays
    // too, and is what every other surface calls on its own way out.
    const strayShells = killAllBashChildren();
    if (strayShells > 0) {
        process.stdout.write(`\nStopped ${strayShells} background shell${strayShells === 1 ? "" : "s"}.\n`);
    }
    if (interrupted > 0) {
        process.stdout.write(
            `\nStopped ${interrupted} running turn${interrupted === 1 ? "" : "s"} — saved where ${interrupted === 1 ? "it" : "they"} stopped.\n`,
        );
    }
    printResumeHint(state.session?.id);
    // The others died with this process too; each can be picked up again.
    const others = slots.all().filter((s) => !slots.isForeground(s) && s.session);
    if (others.length > 0 && process.stdout.isTTY) {
        process.stdout.write(`\nOther sessions from this run:\n`);
        for (const s of others) process.stdout.write(`  ${getAppProfile().name} --session ${s.session!.id}\n`);
    }
}

function releaseAndExit(core: AppCore, reporters: PaneReporters, code: number, children: OwnProcess[]): void {
    const { state } = core;
    // Tear down MCP transports (stdio subprocesses, sockets) on the way out.
    void getMcpManager().close();
    // Gateways run in this process: release their transports so a phone
    // bridge never keeps polling (and running shell commands) after the
    // loop that owns it is gone, and so the pidfile frees up for the next.
    stopRunningGateways();
    // Run extensions' deactivate() so they can release resources.
    void getExtensionHost().close();
    // Close any open datasource connection pools.
    void closeAllPools();
    // SessionEnd hooks + herdr/cmux/Orca release: give them a moment, then
    // exit regardless. Release hands the pane back to herdr's own detection
    // so the sidebar doesn't keep showing a stale loop state, clears the
    // cmux status chip, and lets Orca receive the SessionEnd row.
    void Promise.race([
        Promise.allSettled([
            runHooks(
                "SessionEnd",
                undefined,
                { session_id: state.session?.id, transcript_path: state.session?.path, reason: "exit" },
                state.cwd,
            ),
            ...reporters.release(),
        ]),
        new Promise((r) => setTimeout(r, EXIT_GRACE_MS)),
    ]).finally(() => {
        // Whatever the closes above left behind — a server that ignored its
        // SIGTERM, the processes a server started.
        stopProcesses(children);
        // Checkpoint + close the session DB last — SessionEnd hooks above
        // may still read it, and bun:sqlite close is synchronous.
        closeDb();
        process.exit(code);
    });
}
