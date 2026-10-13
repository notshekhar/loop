/**
 * How the TUI draws compaction events (turn-emitter.ts): a rollover shows its
 * recovery record live, and an idle compaction that lands after /new or
 * /resume moved the screen to another session stays out of that session.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { asTurnEmitter } from "@notshekhar/loop-core";
import { wireTurnEmitter, type TurnEmitterDeps } from "../src/interactive/turn-emitter";

function harness(sessionId: string) {
    const drawn: string[] = [];
    const working: string[] = [];
    const state = { session: { id: sessionId }, busy: false, latestContextTokens: 5 };
    const history = {
        addSystem: (text: string) => drawn.push(`system:${text}`),
        addCompactionSummary: (summary: string, _tokens: number, _ts?: number, handoff?: string) =>
            drawn.push(handoff ? `rollover:${handoff}` : `summary:${summary}`),
    };
    const emitter = asTurnEmitter(new EventEmitter());
    wireTurnEmitter(emitter, {
        history,
        tui: { requestRender: () => {} },
        state,
        turnProvider: "anthropic",
        subagentStream: {},
        todoPanel: { setItems: () => {} },
        showWorking: (m?: string) => working.push(`show:${m}`),
        hideWorking: () => working.push("hide"),
        refreshStatusLine: () => {},
        onTurnError: () => {},
        sessionId,
    } as unknown as TurnEmitterDeps);
    return { emitter, drawn, working, state };
}

describe("compaction in the TUI", () => {
    test("a rollover draws its recovery record", () => {
        const { emitter, drawn, state } = harness("s1");
        emitter.emit("compact-start", { reason: "auto", mode: "rollover" });
        emitter.emit("compact-end", { summary: "", handoff: "## asked\n1. fix it", cutAt: 4, tokensBefore: 900 });
        expect(drawn).toEqual(["rollover:## asked\n1. fix it"]);
        expect(state.latestContextTokens).toBe(0);
    });

    test("an idle compaction draws into its own session", () => {
        const { emitter, drawn, working } = harness("s1");
        emitter.emit("compact-start", { reason: "idle" });
        emitter.emit("compact-end", { summary: "the gist", cutAt: 3, tokensBefore: 900, tokensAfter: 100 });
        expect(working).toEqual(["show:Compacting while idle", "hide"]);
        expect(drawn.at(-1)).toBe("summary:the gist");
    });

    test("an idle compaction after /new stays out of the new session", () => {
        const { emitter, drawn, working, state } = harness("s1");
        emitter.emit("compact-start", { reason: "idle" });
        state.session = { id: "s2" };
        emitter.emit("compact-end", { summary: "the gist", cutAt: 3, tokensBefore: 900 });
        expect(drawn).toEqual([]);
        // The line it put up still comes down.
        expect(working).toEqual(["show:Compacting while idle", "hide"]);
        expect(state.latestContextTokens).toBe(5);
    });

    test("one that starts after the switch shows nothing at all", () => {
        const { emitter, drawn, working, state } = harness("s1");
        state.session = { id: "s2" };
        emitter.emit("compact-start", { reason: "idle" });
        emitter.emit("compact-end", { summary: "the gist", cutAt: 3, tokensBefore: 900 });
        expect(drawn).toEqual([]);
        expect(working).toEqual([]);
    });
});
