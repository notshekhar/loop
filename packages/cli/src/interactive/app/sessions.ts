/**
 * The live sessions of this loop: the roster that runs them, the remote and
 * team sessions and /btw threads built on it, and the input that drives the
 * one on screen.
 */
import type { AskUserBridge } from "@notshekhar/loop-core";
import { hookBus } from "@notshekhar/loop-core";
import { createCommandContext } from "../command-handlers";
import { createInputHandler } from "../input-handler";
import { createSessionRoster } from "../session-roster";
import { createRemoteSessions } from "../remote-sessions";
import { createTeamSessions } from "../team-sessions";
import { createBtwThreads } from "../btw-threads";
import { createSlotOpener } from "../background-slot";
import type { WorkingIndicator } from "../working-indicator";
import type { AppDeps } from "../deps";
import type { AppCore } from "./context";
import type { ForegroundWorking } from "./assemble-deps";
import type { Layout } from "./layout";

export interface SessionParts {
    deps: AppDeps;
    layout: Layout;
    workingIndicator: WorkingIndicator;
    askBridge: AskUserBridge;
}

export function wireSessions(core: AppCore, parts: SessionParts): void {
    const { tui, slots, manager, late } = core;
    const { deps, layout, workingIndicator } = parts;
    const ctx = createCommandContext(core.state, deps);
    const roster = createSessionRoster({
        slots,
        shared: core.shared,
        deps,
        ctx,
        tui,
        editor: layout.editor,
        statusLine: core.statusLine,
        manager,
        indicator: { show: (m) => workingIndicator.showWorking(m), hide: () => workingIndicator.hideWorking() },
        refreshShells: layout.refreshShells,
    });
    late.roster = roster;
    late.remoteSessions = createRemoteSessions({
        slots,
        roster,
        deps,
        ctx,
        commands: core.commands,
        tui,
        ask: (questions, o) => parts.askBridge.ask(questions, o),
        version: core.opts.version,
    });
    deps.remote = late.remoteSessions;
    // Thread teams: this loop runs the threads its sessions start.
    const slotFor = createSlotOpener({ slots, deps, tui, manager });
    late.teamSessions = createTeamSessions({ slots, roster, deps, tui, slotFor });
    deps.team = late.teamSessions;
    deps.btw = createBtwThreads({ slots, roster, deps, tui, manager, slotFor });
    tui.addInputListener(createInputHandler(core.state, deps, ctx));
    // The editor submits to whichever session is on screen.
    layout.editor.onSubmit = (raw) => roster.runnerFor(slots.foreground)(raw);
}

/**
 * Plugin hooks ship statusMessage ("Loading caveman mode…") — transient
 * "while running" text, so it rides the loader, never the chat (a chat line
 * per prompt would spam every turn). Loader restores when the hook ends.
 */
export function showHookStatusOnLoader(core: AppCore, working: ForegroundWorking): void {
    let hookStatusDepth = 0;
    hookBus.on("start", (e: { statusMessage?: string }) => {
        if (!e.statusMessage) return;
        hookStatusDepth++;
        working.showWorking(e.statusMessage);
    });
    hookBus.on("end", (e: { statusMessage?: string }) => {
        if (!e.statusMessage) return;
        hookStatusDepth = Math.max(0, hookStatusDepth - 1);
        if (hookStatusDepth === 0) {
            if (core.state.busy) working.showWorking("Generating");
            else working.hideWorking();
        }
    });
}
