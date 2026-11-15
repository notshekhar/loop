/**
 * One remote session as a slot here: the socket to its host, opening the
 * session, and turning the host's event stream into what the slot draws.
 */
import {
    CostTracker,
    RemoteHostClient,
    type AskQuestion,
    type Entry,
    type RemoteHostRecord,
    type RemoteSessionEvent,
} from "@notshekhar/loop-core";
import type { EventEmitter } from "node:events";
import { ChatHistory } from "../components/chat-history";
import { TodoPanel } from "../components/todo-panel";
import { formatError } from "../format-error";
import { renderBranchEntries } from "../replay";
import type { RemoteLink, SessionSlot } from "../slots";
import { accent, dim, err, warn } from "../ui/text";
import { firstUserText, providerOf, say, TURN_EVENTS, type RemoteState } from "./state";
import { beginTurn, endTurn } from "./turn";

interface RemoteHistory {
    entries: Entry[];
    model: string;
    name?: string;
    seq: number;
    running: boolean;
    info: { cwd: string };
}

/** The socket to `record`'s host, reused while its address and token stay the same. */
export function clientFor(state: RemoteState, record: RemoteHostRecord): RemoteHostClient {
    const { slots, tui } = state.host;
    const existing = state.clients.get(record.id);
    // Re-paired with a new address or token: the old socket is stale.
    if (existing && existing.host.url === record.url && existing.host.token === record.token) return existing;
    existing?.close();
    const client = new RemoteHostClient(record);
    let wasOpen = false;
    client.onStatus((status) => {
        const mine = slots.all().filter((s) => s.remote?.client === client);
        if (status === "reconnecting" && wasOpen) {
            for (const slot of mine) slot.history.addSystem(warn(`lost ${record.label} — reconnecting…`));
            tui.requestRender();
        }
        if (status === "open") {
            if (wasOpen) for (const slot of mine) void reattach(state, slot);
            wasOpen = true;
        }
    });
    state.clients.set(record.id, client);
    return client;
}

async function answerAsk(
    state: RemoteState,
    slot: SessionSlot,
    data: { askId: string; questions: AskQuestion[] },
): Promise<void> {
    const link = slot.remote!;
    const signal = slot.abort.signal;
    // Same rule as a local ask: it opens when this session is on screen.
    const onScreen = await state.host.slots.waitForForeground(slot, "question", signal);
    const answers = onScreen
        ? await state.host.ask(data.questions, { signal })
        : data.questions.map(() => ({ answers: [], declined: true }));
    await link.client.call("session.answer", { sessionId: link.sessionId, askId: data.askId, answers }).catch(() => {});
}

/**
 * Idle compaction runs between turns, with no `session-running` around
 * it: opening a turn for it left one that never closed (the prompt
 * queued behind it, and the next real turn reused its emitter). It is a
 * note in the transcript, not a turn.
 */
function noteIdleCompaction(state: RemoteState, slot: SessionSlot, type: string, data: unknown): void {
    const end = data as { aborted?: boolean; tokensBefore?: number; tokensAfter?: number } | undefined;
    if (type !== "compact-end" || end?.aborted) return;
    const size =
        end?.tokensBefore && end.tokensAfter
            ? ` (${Math.round(end.tokensBefore / 1000)}k → ${Math.round(end.tokensAfter / 1000)}k tokens)`
            : "";
    slot.history.addSystem(dim(`compacted while idle${size}`));
    state.host.tui.requestRender();
}

function onEvent(state: RemoteState, slot: SessionSlot, e: RemoteSessionEvent): void {
    const link = slot.remote;
    if (!link || e.seq <= link.seq) return;
    link.seq = e.seq;
    const { type, data } = e.part;
    if (type === "session-running") {
        if ((data as { running?: boolean }).running) beginTurn(state, slot);
        else endTurn(state, slot);
        return;
    }
    if (type === "ask") {
        void answerAsk(state, slot, data as { askId: string; questions: AskQuestion[] });
        return;
    }
    if (!TURN_EVENTS.has(type)) return;
    if ((type === "compact-start" || type === "compact-end") && !state.turns.get(slot)) {
        noteIdleCompaction(state, slot, type, data);
        return;
    }
    // An event with no turn open (joined mid-turn, or a recap after the
    // end) still renders; it just opens one to render into.
    const turn = state.turns.get(slot) ?? (type === "data-recap" ? null : beginTurn(state, slot));
    if (turn) (turn.emitter as unknown as EventEmitter).emit(type, data);
    else if (type === "data-recap") slot.history.addRecap((data as { text: string }).text);
    state.host.tui.requestRender();
}

/** Back on a host after a dropped socket: resume the stream where it stopped. */
async function reattach(state: RemoteState, slot: SessionSlot): Promise<void> {
    const link = slot.remote;
    if (!link) return;
    try {
        const res = await link.client.call<{ seq: number; running: boolean; resync: boolean }>("session.attach", {
            sessionId: link.sessionId,
            afterSeq: link.seq,
        });
        if (res.resync) {
            slot.history.addSystem(
                warn(`back on ${link.host.label}, but some output was missed — /hosts reopens it in full`),
            );
            link.seq = res.seq;
        } else {
            slot.history.addSystem(dim(`back on ${link.host.label}`));
        }
        if (!res.running && slot.busy) endTurn(state, slot);
    } catch (e) {
        slot.history.addError(`${link.host.label}: ${formatError(e)}`);
    }
    state.host.tui.requestRender();
}

/** A slot for one of a host's sessions, its transcript replayed from `history`. */
function addRemoteSlot(
    state: RemoteState,
    record: RemoteHostRecord,
    client: RemoteHostClient,
    sessionId: string,
    history: RemoteHistory,
): SessionSlot {
    const { slots, tui } = state.host;
    const cwd = history.info.cwd;
    const chat = new ChatHistory(tui, cwd);
    const todoPanel = new TodoPanel();
    let unsubscribe = () => {};
    const link: RemoteLink = {
        host: record,
        client,
        sessionId,
        title: history.name || firstUserText(history.entries),
        model: history.model,
        seq: history.seq,
        dispose: () => unsubscribe(),
    };
    const template = slots.foreground;
    const slot = slots.add({
        cwd,
        modelId: history.model,
        provider: providerOf(history.model) as never,
        thinkingLevel: template.thinkingLevel,
        agent: template.agent,
        oneShotAgent: null,
        session: null,
        latestContextTokens: 0,
        busy: false,
        abort: new AbortController(),
        pendingInjection: null,
        startupHooksDone: null,
        pendingPlan: null,
        planModeViaCycle: false,
        history: chat,
        todoPanel,
        tracker: new CostTracker(),
        remote: link,
    });
    chat.addSystem(accent(`${record.label}`) + dim(` · ${cwd} · session ${sessionId}`));
    renderBranchEntries(history.entries, sessionId, chat, history.model, todoPanel);
    unsubscribe = client.onSessionEvent(sessionId, (e) => onEvent(state, slot, e));
    return slot;
}

/** Open (or go to) one of a host's sessions. */
export async function openRemote(
    state: RemoteState,
    record: RemoteHostRecord,
    client: RemoteHostClient,
    sessionId: string,
): Promise<void> {
    const { slots, tui } = state.host;
    const live = slots.all().find((s) => s.remote?.host.id === record.id && s.remote.sessionId === sessionId);
    if (live) {
        slots.switchTo(live);
        return;
    }
    let history: RemoteHistory;
    try {
        history = await client.call<RemoteHistory>("session.history", { sessionId });
    } catch (e) {
        say(state, err(`${record.label}: ${formatError(e)}`));
        return;
    }
    const slot = addRemoteSlot(state, record, client, sessionId, history);
    slots.switchTo(slot);
    try {
        const res = await client.call<{ running: boolean; resync: boolean; seq: number }>("session.attach", {
            sessionId,
            afterSeq: history.seq,
        });
        if (res.running && !slot.busy) {
            state.sentHere.add(slot); // not news: it was running when opened
            beginTurn(state, slot);
        }
    } catch (e) {
        slot.history.addError(`${record.label}: ${formatError(e)}`);
    }
    tui.requestRender();
}
