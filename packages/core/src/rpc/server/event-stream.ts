import { TURN_EVENT_NAMES } from "../../agent";
import { applyEvent } from "../../transcript";
import { trackSaved, type ActiveSession, type RingEntry, type StreamPart, type Transport } from "./active-session";

/** Events kept per active session for reconnect replay (session.attach). */
const EVENT_RING_SIZE = 2048;

/** Turn events whose payload can carry a thrown Error. See plainError. */
const ERROR_BEARING_EVENTS = new Set(["error", "tool-error"]);

/**
 * An Error, turned into something that survives leaving this process.
 *
 * `JSON.stringify(new Error("boom"))` is `{}` — `message`, `name` and `stack`
 * are all non-enumerable — so every failure this stream carried reached a
 * client as an empty object. MEASURED against the desktop app: a `write` that
 * threw rendered a red row whose entire detail was `{}`, and a 401 from the
 * provider ended the turn with a banner that said nothing at all. The TUI
 * never noticed because it holds the Error itself and runs `formatError` on
 * it; anything crossing the wire has to be made of plain data first.
 *
 * The enumerable own properties are kept alongside the message because that is
 * where the AI SDK puts what matters — `statusCode`, `responseBody`, `data` —
 * and a client's own formatter reads them to turn a 401 into "invalid
 * x-api-key". `stack` is deliberately dropped: it is noise in a UI and the
 * biggest field on the object.
 */
export function plainError(value: unknown, depth = 0): unknown {
    if (depth > 4) return undefined;
    if (value instanceof Error) {
        const error = value as Error & Record<string, unknown>;
        const out: Record<string, unknown> = { name: error.name, message: error.message };
        for (const [key, entry] of Object.entries(error)) {
            if (key === "stack") continue;
            out[key] = entry;
        }
        // Non-enumerable on a native Error, and where node/bun bury the real
        // syscall failure (ECONNREFUSED under a vague fetch message).
        if (error.cause !== undefined) out.cause = plainError(error.cause, depth + 1);
        return out;
    }
    if (Array.isArray(value)) return value.map((entry) => plainError(entry, depth + 1));
    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(source)) out[key] = plainError(entry, depth + 1);
        return out;
    }
    return value;
}

/**
 * A turn event's payload, safe to send. Only the two that can carry an Error
 * pay for the rewrite — the others include every text/reasoning/input delta,
 * and copying those per token would be a cost with no payoff.
 */
export function wirePart(type: string, data: unknown): StreamPart {
    return { type, data: ERROR_BEARING_EVENTS.has(type) ? plainError(data) : data };
}

/** The notification that carries one event of a session's stream. */
function sessionEvent(sessionId: string, seq: number, part: StreamPart) {
    return { jsonrpc: "2.0" as const, method: "session.event", params: { sessionId, seq, part } };
}

/** Stamp a seq, remember for replay, fan out to every subscriber. */
export function broadcast(sessionId: string, ctx: ActiveSession, part: StreamPart): void {
    const seq = ++ctx.seq;
    ctx.ring.push({ seq, part });
    ctx.transcript = applyEvent(ctx.transcript, part);
    if (ctx.ring.length > EVENT_RING_SIZE) ctx.ring.shift();
    for (const sub of ctx.subscribers) sub.send(sessionEvent(sessionId, seq, part));
}

/**
 * Forward the ENTIRE turn stream — reasoning, tool lifecycle, subagents, step
 * usage, recap — not a hand-picked subset. TURN_EVENT_NAMES is the single
 * source of truth: a new event on the agent loop reaches clients automatically
 * (and can't be forgotten — the list is build-checked).
 */
export function wireCtx(sessionId: string, ctx: ActiveSession): void {
    trackSaved(ctx);
    for (const event of TURN_EVENT_NAMES) {
        ctx.emitter.on(event, (data: unknown) => broadcast(sessionId, ctx, wirePart(event, data)));
    }
}

/** What the running turn has streamed so far: the ring after its last `session-running` start. */
export function eventsSinceTurnStart(ctx: ActiveSession): StreamPart[] {
    let start = -1;
    for (let i = ctx.ring.length - 1; i >= 0; i--) {
        const part = ctx.ring[i]!.part;
        if (part.type === "session-running" && (part.data as { running?: boolean })?.running) {
            start = i;
            break;
        }
    }
    return ctx.ring.slice(start + 1).map((entry) => entry.part);
}

/**
 * Catch a re-attaching client up from `afterSeq`: replay what the ring still
 * holds, or report `resync` when the gap has left the ring (the client falls
 * back to a full session.history render).
 */
export function replayAfter(sessionId: string, ctx: ActiveSession, afterSeq: number | undefined, to: Transport) {
    if (afterSeq === undefined) return { resync: false };
    if (afterSeq > ctx.seq) {
        // Client is ahead of us: the server restarted and the seq
        // counter reset. Its transcript is stale — full resync.
        return { resync: true };
    }
    if (afterSeq === ctx.seq) return { resync: false };
    const oldest = ctx.ring.length ? ctx.ring[0].seq : ctx.seq + 1;
    if (afterSeq < oldest - 1) return { resync: true };
    const missed: RingEntry[] = ctx.ring.filter((entry) => entry.seq > afterSeq);
    for (const entry of missed) to.send(sessionEvent(sessionId, entry.seq, entry.part));
    return { resync: false };
}
