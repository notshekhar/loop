import { afterEach, describe, expect, test } from "bun:test";
import { hookBus, type HookPayload } from "@notshekhar/loop-core";
import { createAgentStatusBus } from "../src/interactive/agent-status";
import {
    attachSoundReporter,
    noteTurnError,
    resetTurnOutcomeForTests,
    type SoundPlayers,
} from "../src/interactive/sound-reporter";

/**
 * What matters here is which cue a SEQUENCE resolves to. A turn that failed
 * mid-stream still fires `Stop`, so playing off `Stop` alone congratulates the
 * user on a failure — that is the bug these cases exist to hold shut.
 */
function harness(): { played: string[]; release: () => void; bus: ReturnType<typeof createAgentStatusBus> } {
    const played: string[] = [];
    const players: SoundPlayers = {
        cue: (c) => played.push(c),
        attention: () => played.push("attention"),
    };
    // No settle delay: the downward-transition debounce is the status bus's
    // business, not this reporter's, and waiting on it would only add flake.
    const bus = createAgentStatusBus(0);
    const reporter = attachSoundReporter(bus, { players });
    return { played, release: () => reporter.release(), bus };
}

const fire = (payload: Partial<HookPayload> & { hook_event_name: string }): void => {
    hookBus.emit("event", { cwd: "/tmp", ...payload } as HookPayload);
};

afterEach(() => {
    resetTurnOutcomeForTests();
});

describe("turn outcome", () => {
    test("a clean turn plays success", () => {
        const h = harness();
        fire({ hook_event_name: "Stop" });
        expect(h.played).toEqual(["success"]);
        h.release();
    });

    test("a turn that errored plays error, and only once", () => {
        const h = harness();
        noteTurnError();
        fire({ hook_event_name: "Stop" });
        // Not ["error", "success"] — the error is the outcome, not an extra.
        expect(h.played).toEqual(["error"]);
        h.release();
    });

    test("the next turn is not coloured by the last one's failure", () => {
        const h = harness();
        noteTurnError();
        fire({ hook_event_name: "Stop" });
        fire({ hook_event_name: "UserPromptSubmit" });
        fire({ hook_event_name: "Stop" });
        expect(h.played).toEqual(["error", "success"]);
        h.release();
    });

    test("a new prompt clears a stale error even if the turn never stopped", () => {
        const h = harness();
        noteTurnError();
        fire({ hook_event_name: "UserPromptSubmit" });
        fire({ hook_event_name: "Stop" });
        expect(h.played).toEqual(["success"]);
        h.release();
    });

    test("a stop-hook continuation is not the end of anything", () => {
        const h = harness();
        fire({ hook_event_name: "Stop", stop_hook_active: true });
        expect(h.played).toEqual([]);
        // The final continuation still lands.
        fire({ hook_event_name: "Stop" });
        expect(h.played).toEqual(["success"]);
        h.release();
    });

    test("unrelated hooks are silent", () => {
        const h = harness();
        for (const e of ["PreToolUse", "PostToolUse", "Notification", "SessionStart", "SessionEnd"]) {
            fire({ hook_event_name: e });
        }
        expect(h.played).toEqual([]);
        h.release();
    });
});

describe("attention", () => {
    test("blocking on the user chimes once, not once per question", () => {
        const h = harness();
        const close1 = h.bus.modalOpened("question");
        const close2 = h.bus.modalOpened("question");
        expect(h.played).toEqual(["attention"]);
        close2();
        close1();
        h.release();
    });

    test("a later block chimes again", async () => {
        const h = harness();
        h.bus.modalOpened("bash approval")();
        // Let the bus settle back down before the second block.
        await new Promise((r) => setTimeout(r, 20));
        h.bus.modalOpened("bash approval")();
        expect(h.played).toEqual(["attention", "attention"]);
        h.release();
    });
});

describe("release", () => {
    test("a released reporter stops listening", () => {
        const h = harness();
        h.release();
        fire({ hook_event_name: "Stop" });
        expect(h.played).toEqual([]);
    });
});
