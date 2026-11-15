import { createBtwThread } from "../../sessions";
import { CompactAbortedError, runCompact } from "../../agent";
import { stopTeam, teamOf, teamSnapshot, teamSnapshotForSession } from "../../teams";
import { abortTurn, requireIdle, type Transport } from "./active-session";
import { writeAttachmentPayloads } from "./attachments";
import { broadcast } from "./event-stream";
import { turnChoices } from "./turns";
import type { HandlerTable, RpcHost } from "./rpc-host";

type TurnHost = Pick<RpcHost, "contexts" | "turns" | "asks" | "announce">;

/** Turns: sending, side questions, stopping, compacting, answering — and the teams that run them. */
export function sessionTurnHandlers(host: TurnHost): HandlerTable {
    return {
        "session.send": (params) => sendTurn(host, params),
        "session.btw": (params, transport) => askBtw(host, params, transport),
        "session.cancel": (params) => {
            const id = String(params.sessionId);
            const live = host.contexts.live?.get(id);
            if (live) live.cancel();
            else abortTurn(host.contexts.requireSession(id));
            return { ok: true };
        },
        "session.compact": (params) => compactSession(host, params),
        "session.answer": (params) => host.asks.answer(params),
        ...teamHandlers(host),
    };
}

function sendTurn(host: TurnHost, params: Record<string, unknown>) {
    const id = String(params.sessionId);
    // Nothing to say is a client bug, not a turn: running it put an
    // empty user message in the transcript and sent the model the
    // conversation with nothing new at the end.
    const hasImages = Array.isArray(params.images) && params.images.length > 0;
    if (String(params.input ?? "").trim() === "" && !hasImages) {
        throw new Error("session.send needs a message: `input` is empty and there are no images");
    }
    // Remote clients (web UI) attach images as base64 payloads: each
    // is written to a temp file and referenced with the same
    // [image:<path>] sentinel paste/drag produces in the TUI, so the
    // whole existing pipeline (extraction, transcript, replay)
    // applies unchanged.
    //
    // Open in the TUI: it runs there, on screen, and streams to
    // every client through publishLive. A turn already running
    // there queues this one rather than refusing it — the TUI's
    // own rule for anything typed mid-turn.
    const live = host.contexts.live?.get(id);
    if (live) {
        live.send(String(params.input ?? "") + writeAttachmentPayloads(params.images));
        return { ok: true };
    }
    const ctx = host.contexts.requireSession(id);
    requireIdle(id, ctx, "already has");
    const input = String(params.input ?? "") + writeAttachmentPayloads(params.images);
    const modelId = String(params.model ?? ctx.modelId);
    ctx.modelId = modelId;
    host.turns.start(id, ctx, input, { modelId, ...turnChoices(params) });
    return { ok: true };
}

/**
 * `/btw`: the question runs in a copy of this session, which is never touched
 * — so it works while a turn is running here. The reply streams on the NEW
 * session; subscribe to it.
 */
async function askBtw(host: TurnHost, params: Record<string, unknown>, transport: Transport) {
    const question = String(params.question ?? "").trim();
    if (!question) throw new Error("session.btw needs a question");
    const choices = turnChoices(params);
    const source = await host.contexts.ensureCtx(String(params.sessionId));
    const { session, meta } = await createBtwThread(host.contexts.manager, source.session, question);
    const ctx = await host.contexts.ensureCtx(session.id);
    // The asker watches the answer stream, as session.create's caller does.
    ctx.subscribers.add(transport);
    ctx.modelId = String(params.model ?? source.modelId);
    host.announce({ sessionId: session.id, change: "created" });
    host.turns.start(session.id, ctx, question, { modelId: ctx.modelId, btw: meta, ...choices });
    return { sessionId: session.id, cwd: session.info.cwd, name: session.getName() };
}

/**
 * Announced on the same event stream the turn uses, and for the same reason
 * auto-compaction announces itself in runTurn: a compaction rewrites what the
 * conversation IS, and a client that only sees the return value has no way to
 * show that it happened, or that it is happening — this call can take tens of
 * seconds. `manual` matches the CLI's own /compact trigger.
 */
async function compactSession(host: TurnHost, params: Record<string, unknown>) {
    const id = String(params.sessionId);
    const ctx = host.contexts.requireSession(id);
    requireIdle(id, ctx, "already has");
    host.contexts.setRunning(id, ctx, true);
    broadcast(id, ctx, { type: "compact-start", data: { reason: "manual" } });
    try {
        const focus = typeof params.focus === "string" ? params.focus.trim() : "";
        const result = await runCompact({
            session: ctx.session,
            modelId: ctx.modelId,
            manual: true,
            ...(focus ? { focus } : {}),
            tracker: ctx.tracker,
            cwd: ctx.session.info.cwd,
            // session.cancel aborts this, as it does a turn.
            abortSignal: ctx.abort.signal,
        });
        broadcast(id, ctx, { type: "compact-end", data: result });
        return result;
    } catch (err) {
        // A failed compaction must still close the event, or a
        // client renders "Compacting…" forever — and say WHY, so a
        // provider error is not shown as a cancel.
        const aborted = err instanceof CompactAbortedError;
        const reason = aborted ? { aborted: true } : { error: err instanceof Error ? err.message : String(err) };
        broadcast(id, ctx, {
            type: "compact-end",
            data: { summary: "", cutAt: 0, tokensBefore: 0, tokensAfter: 0, ...reason },
        });
        throw err;
    } finally {
        host.contexts.setRunning(id, ctx, false);
    }
}

/** Thread teams (teams/): the panel's data, and its Stop button. */
function teamHandlers(host: TurnHost): HandlerTable {
    return {
        "team.get": (params) => {
            // By team or by any thread in it — a member's view asks with
            // its own session id and gets the whole team back.
            if (typeof params.teamId === "string" && params.teamId) return teamSnapshot(params.teamId);
            if (typeof params.sessionId === "string" && params.sessionId) {
                return teamSnapshotForSession(params.sessionId);
            }
            throw new Error("team.get needs a teamId or a sessionId");
        },
        "team.stop": (params) => {
            const teamId =
                typeof params.teamId === "string" && params.teamId
                    ? params.teamId
                    : typeof params.sessionId === "string"
                      ? teamOf(params.sessionId)?.teamId
                      : undefined;
            if (!teamId) throw new Error("team.stop needs a teamId or a sessionId in a team");
            stopTeam(teamId);
            // A turn in a TUI-run session is the TUI's to stop. The lead's
            // keeps going, as it does in stopTeam.
            for (const member of teamSnapshot(teamId)?.members ?? []) {
                host.contexts.live?.get(member.id)?.cancel();
            }
            return { ok: true, teamId };
        },
    };
}
