/**
 * Interface chimes, wired to the two seams that already know when something
 * happened worth hearing: the hook bus (a turn ended) and the agent-status bus
 * (the agent is blocked on you).
 *
 * Shaped like the herdr / notch / cmux reporters beside it — same bus, same
 * attach-and-release — so there is one pattern here to understand, not four.
 *
 * The turn's OUTCOME is the part that needs care. `Stop` fires when a turn ends
 * without being aborted, but it says nothing about whether the turn went well:
 * a stream that died mid-flight emits `error` on the turn emitter and then goes
 * on to fire `Stop` anyway. Playing off `Stop` alone would congratulate the
 * user on a turn that just failed, and playing off both would play two chimes.
 * So an error seen during the turn is remembered, and `Stop` resolves to one
 * cue: error if anything went wrong, success otherwise.
 *
 * Interrupts stay silent here on purpose — an aborted turn never reaches `Stop`
 * at all, and the Esc path plays its own `press` cue at the moment the user
 * asks, which is when they want to hear it.
 */
import { hookBus, playAttention, playCue, type Cue, type HookPayload } from "@notshekhar/loop-core";
import type { AgentStatusBus, AgentStatusEvent } from "./agent-status";

export interface SoundReporter {
    release(): void;
}

/**
 * The players are injectable so the wiring can be tested without a speaker —
 * what is worth asserting here is WHICH cue a sequence of events resolves to,
 * and that is invisible from outside a process that spawns `afplay`.
 */
export interface SoundPlayers {
    cue(cue: Cue): void;
    attention(): void;
}

export interface SoundReporterOptions {
    disabled?: boolean;
    players?: SoundPlayers;
}

/**
 * Set when a turn emits an error, cleared when the outcome is played.
 *
 * Module state rather than a field because the turn emitter is wired in its own
 * module (`turn-emitter.ts`) and there is exactly one turn in flight per
 * process — a second one would be a bug elsewhere, not a case to model here.
 */
let errorSeen = false;

/** Called by the turn emitter when a turn reports an error. */
export function noteTurnError(): void {
    errorSeen = true;
}

/** Test seam: forget any remembered outcome between cases. */
export function resetTurnOutcomeForTests(): void {
    errorSeen = false;
}

export function attachSoundReporter(bus: AgentStatusBus, opts: SoundReporterOptions = {}): SoundReporter {
    if (opts.disabled) return { release: () => {} };
    const players: SoundPlayers = opts.players ?? { cue: playCue, attention: () => playAttention() };

    const onHookEvent = (payload: HookPayload): void => {
        if (payload.hook_event_name !== "Stop") return;
        // A stop-hook continuation is not the end of anything; the final one
        // is. Same guard the cmux reporter uses for its completion notice.
        if (payload.stop_hook_active === true) return;
        const failed = errorSeen;
        errorSeen = false;
        players.cue(failed ? "error" : "success");
    };

    // A new prompt starts a fresh outcome: an error from the previous turn
    // must not colour this one, and `Stop` is the only thing that clears it.
    const onPrompt = (payload: HookPayload): void => {
        if (payload.hook_event_name === "UserPromptSubmit") errorSeen = false;
    };

    hookBus.on("event", onHookEvent);
    hookBus.on("event", onPrompt);

    let lastStatus: AgentStatusEvent["status"] = bus.current().status;
    bus.on((e) => {
        // Only the transition INTO blocked: the bus re-emits while a nested ask
        // flow reopens its selector per question, and a chime per question is
        // the fastest way to make a feature hateful.
        if (e.status === "blocked" && lastStatus !== "blocked") players.attention();
        lastStatus = e.status;
    });

    let released = false;
    return {
        release() {
            if (released) return;
            released = true;
            hookBus.off("event", onHookEvent);
            hookBus.off("event", onPrompt);
        },
    };
}
