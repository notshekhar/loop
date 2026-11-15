/**
 * The pane's agent state (working / blocked / idle) and everything outside
 * loop that follows it: herdr, notch, chimes, cmux, Orca, the terminal tab
 * title, and the Notification hook.
 */
import { runHooks, getSetting, getAppProfile } from "@notshekhar/loop-core";
import { createAgentStatusBus, type AgentStatusBus } from "../agent-status";
import { attachSoundReporter } from "../sound-reporter";
import { attachCmuxReporter, setCmuxReporter } from "../cmux-reporter";
import { attachOrcaReporter } from "../orca-reporter";
import { attachTerminalTitle, defaultTabName } from "../session-title";
import { attachHerdrReporter } from "../herdr-reporter";
import { attachNotchReporter } from "../notch-reporter";
import type { AppDeps } from "../deps";
import type { AppCore } from "./context";

export interface PaneReporters {
    agentStatus: AgentStatusBus;
    /** Hand every watcher back its pane on exit; each is bounded-time. */
    release(): Promise<void>[];
    /** Put the tab back to a plain name. */
    stopTerminalTitle(): void;
}

export function attachPaneReporters(core: AppCore): PaneReporters {
    const agentStatus = createPaneStatus(core);
    const release = attachExternalReporters(core, agentStatus);

    // Name the tab immediately. A resumed session carries its own title; a
    // fresh one says which agent this pane is until its first turn earns one —
    // either beats the stale shell command a terminal shows otherwise, which
    // is what cmux was rendering on loop's pane card.
    const titleDeps = { tui: core.tui } as unknown as AppDeps;
    const stopTerminalTitle = attachTerminalTitle(
        agentStatus,
        titleDeps,
        core.state.session?.getName() || defaultTabName(),
    );

    attachNotificationHook(core, agentStatus);
    return { agentStatus, release, stopTerminalTitle };
}

/**
 * Agent-status bus: the semantic working/blocked/idle state of this pane.
 * Fed by the two seams that already see everything — the working
 * indicator (turns, compaction, hook commands, goal mode, Esc-interrupt)
 * and showSelector (every modal prompt). Consumed by agent-state
 * watchers: the herdr reporter and the Notification hook bridge.
 */
function createPaneStatus(core: AppCore): AgentStatusBus {
    const { slots } = core;
    const agentStatus = createAgentStatusBus();
    // The loader shows the foreground session; the bus reports the whole
    // pane, so it is working while ANY session is.
    slots.onChange(() => {
        if (slots.all().some((s) => s.status === "working" || s.busy)) agentStatus.setWorking();
        else agentStatus.setIdle();
    });
    return agentStatus;
}

function attachExternalReporters(core: AppCore, agentStatus: AgentStatusBus): () => Promise<void>[] {
    const { state } = core;
    const sessionRef = () => (state.session ? { id: state.session.id, path: state.session.path } : null);
    const cwd = () => state.cwd;

    // herdr agent-state reporting (inert outside a herdr pane).
    const herdr = attachHerdrReporter(agentStatus, { getSession: sessionRef, disabled: getSetting("herdr") === false });

    // notch agent-state reporting (inert unless the notch app is running).
    const notch = attachNotchReporter(agentStatus, {
        getSession: () =>
            state.session ? { id: state.session.id, path: state.session.path, name: state.session.getName() } : null,
        cwd,
        disabled: getSetting("notch") === false,
    });

    // Interface chimes on the two things worth hearing: a turn that ended, and
    // the agent blocked on you. Silent unless `sound` is on (macOS default).
    const sound = attachSoundReporter(agentStatus, { disabled: getSetting("sound") === "off" });

    // cmux integration (inert outside a cmux pane). Unlike herdr's this one
    // does not read the status bus: cmux speaks lifecycle EVENTS, and loop
    // already emits every one of them as a hook — including the Notification
    // the bus fires below. It is registered globally because the approval and
    // ask bridges, built further down, ask for it at prompt time.
    const cmuxReporter = attachCmuxReporter(agentStatus, {
        getSession: sessionRef,
        cwd,
        disabled: getSetting("cmux") === false,
    });
    setCmuxReporter(cmuxReporter);

    // Orca integration (inert outside an Orca pane): the same hook events,
    // posted to Orca's per-pane hook endpoint so its workspace card and phone
    // app follow this pane, and a woken workspace resumes this session.
    const orcaReporter = attachOrcaReporter(agentStatus, { getSessionId: () => state.session?.id, cwd });

    return () => [
        herdr.release(),
        notch.release(),
        cmuxReporter.release(),
        orcaReporter.release(),
        // Synchronous; listed here so every reporter is released in
        // one place rather than two.
        Promise.resolve(sound.release()),
    ];
}

/**
 * Notification hook on agent-driven waits (Claude Code parity): when a
 * prompt opens mid-turn, external watchers get the "needs attention"
 * signal — same event the PreToolUse-denial path in core fires. Gated on
 * state.busy so user-opened menus (/provider, /theme) don't ping.
 */
function attachNotificationHook(core: AppCore, agentStatus: AgentStatusBus): void {
    const { state, slots } = core;
    agentStatus.on((e) => {
        if (e.status !== "blocked" || !slots.all().some((s) => s.busy)) return;
        void runHooks(
            "Notification",
            undefined,
            {
                session_id: state.session?.id,
                transcript_path: state.session?.path,
                message: `Waiting for input: ${e.label ?? "prompt"}`,
                title: getAppProfile().name,
            },
            state.cwd,
        ).then((n) => {
            for (const s of n.terminalSequences) process.stdout.write(s);
        });
    });
}
