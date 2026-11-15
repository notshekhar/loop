import type { AskAnswer, AskQuestion } from "../../tools/ask-bridge";
import { currentSessionId } from "../../host/session-scope";
import { broadcast } from "./event-stream";
import type { SessionContexts } from "./session-contexts";

/** The ask tool's questions, put to RPC clients and answered by `session.answer`. */
export class AskRelay {
    /** askId -> the tool call waiting on `session.answer`. */
    private pending = new Map<string, (answers: AskAnswer[]) => void>();
    private nextAskId = 1;

    constructor(private readonly contexts: SessionContexts) {}

    /**
     * Put a question to whichever client is watching this session.
     *
     * Declining is the safe default everywhere: no session context, nobody
     * subscribed, or the turn aborted all resolve as "declined" rather than
     * hanging the turn on an answer that can never arrive. The tool then tells
     * the model to proceed without asking.
     */
    ask(questions: AskQuestion[], opts?: { signal?: AbortSignal }): Promise<AskAnswer[]> {
        const declined = (): AskAnswer[] => questions.map(() => ({ answers: [], declined: true }));
        const sessionId = currentSessionId();
        const ctx = sessionId ? this.contexts.get(sessionId) : undefined;
        if (!sessionId || !ctx || ctx.subscribers.size === 0) return Promise.resolve(declined());

        const askId = `ask-${this.nextAskId++}`;
        return new Promise<AskAnswer[]>((resolve) => {
            let settled = false;
            const finish = (answers: AskAnswer[]) => {
                if (settled) return;
                settled = true;
                this.pending.delete(askId);
                opts?.signal?.removeEventListener("abort", onAbort);
                resolve(answers);
            };
            const onAbort = () => finish(declined());
            if (opts?.signal?.aborted) return finish(declined());
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            this.pending.set(askId, finish);
            // Rides the same event channel as the turn stream, so a client
            // already rendering the turn needs no second subscription.
            broadcast(sessionId, ctx, { type: "ask", data: { askId, questions } });
        });
    }

    /**
     * `session.answer`: index-aligned with the questions the `ask` event
     * carried. Unknown id = the turn already moved on (aborted, or answered by
     * another client); say so rather than failing.
     */
    answer(params: Record<string, unknown>): { ok: boolean; askId: string } {
        const askId = String(params.askId ?? "");
        const resolve = this.pending.get(askId);
        if (!resolve) return { ok: false, askId };
        const answers = Array.isArray(params.answers) ? (params.answers as AskAnswer[]) : [];
        resolve(answers);
        return { ok: true, askId };
    }
}
