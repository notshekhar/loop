import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { basename } from "node:path";
import { spawnJsonLines, stripAnsi } from "./process";
import {
    finishReason,
    makeUsage,
    trackTurnProcess,
    waitForPreviousTurn,
    type NativeAgentProviderId,
    type NativeAgentTurnContext,
    type PromptPlan,
    type TurnOutcome,
} from "./shared";

/**
 * One turn of a CLI that prints its events as JSON lines (Cursor's and
 * Antigravity's print modes): spawn it, hand each event to the provider's
 * reader, and decide how the turn ended when the process exits.
 */
export interface JsonLinesReader {
    read(event: Record<string, unknown>): void;
    /** The CLI reported the end of the turn (its `result`). */
    readonly finished: boolean;
    /** Anything was shown — after that, a failed resume can't be retried fresh. */
    readonly producedOutput: boolean;
    /** Close any open text/reasoning block. */
    endAll(): void;
}


export async function runJsonLinesTurn(turn: {
    provider: NativeAgentProviderId;
    /** How errors name the CLI ("Cursor", "Antigravity"). */
    label: string;
    binary: string;
    args: readonly string[];
    stdin?: string;
    ctx: NativeAgentTurnContext | undefined;
    plan: PromptPlan;
    signal: AbortSignal | undefined;
    reader: JsonLinesReader;
    enqueue: (part: LanguageModelV4StreamPart) => void;
}): Promise<TurnOutcome> {
    const { reader } = turn;
    let exit: { code: number | null; stderr: string } | undefined;
    // One process per loop session at a time — see waitForPreviousTurn.
    const gateKey = turn.ctx ? `${turn.provider}:${turn.ctx.loopSessionId}` : undefined;
    await waitForPreviousTurn(gateKey);
    for await (const event of spawnJsonLines(turn.binary, turn.args, {
        cwd: turn.ctx?.cwd,
        stdin: turn.stdin,
        signal: turn.signal,
        onExit: (code, stderr) => (exit = { code, stderr }),
        onSpawn: (exited) => trackTurnProcess(gateKey, exited),
    })) {
        reader.read(event);
    }

    if (reader.finished) return "done";
    reader.endAll();
    if (turn.signal?.aborted) {
        turn.enqueue({ type: "finish", usage: makeUsage({}), finishReason: finishReason("other", "aborted") });
        return "done";
    }
    // A resume that died before saying anything: the session is most likely gone.
    if (!reader.producedOutput && turn.plan.resumeId) return "missing-session";
    const detail = stripAnsi(exit?.stderr ?? "").trim() || `${basename(turn.binary)} exited with code ${exit?.code ?? "?"}`;
    throw new Error(`${turn.label}: ${detail}`);
}
