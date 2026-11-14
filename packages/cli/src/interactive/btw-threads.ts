/**
 * `/btw` in the TUI: ask a side question without touching the chat you are in.
 *
 * The question runs in a copy of this session (core sessions/btw.ts), opened
 * as a background slot — so it works while this chat's turn is still running,
 * and Ctrl+S (or `/btw` alone) opens it to follow up. When the answer is in,
 * it is shown here as a ruled card that is NOT part of this conversation: the
 * model on this side never sees the question or the answer.
 */
import {
    btwParentIn,
    createBtwThread,
    extractMessageText,
    type Session,
    type SessionManager,
} from "@notshekhar/loop-core";
import { Container, Markdown, Text, type TUI } from "@notshekhar/loop-tui";
import type { SlotFor } from "./background-slot";
import type { AppDeps } from "./deps";
import type { SessionRoster } from "./session-roster";
import type { SessionSlot, SlotManager } from "./slots";
import { DynamicBorder } from "./ui/messages";
import { getMarkdownTheme } from "./ui/theme";
import { accent, accentTitle, dim, warn } from "./ui/text";

export interface BtwThreadsHost {
    slots: SlotManager;
    roster: SessionRoster;
    deps: AppDeps;
    tui: TUI;
    manager: SessionManager;
    /** The app's one slot opener (background-slot.ts). */
    slotFor: SlotFor;
}

export interface BtwThreads {
    askBtw(question: string): Promise<void>;
}

/** A side thread, as `/btw` lists it. */
interface AskedThread {
    readonly sessionId: string;
    readonly question: string;
}

/** The reply to the side question: the last thing the thread said after it was asked. */
function answerOf(thread: Session, questionEntryCount: number): string {
    const after = thread.getBranch().slice(questionEntryCount);
    for (let i = after.length - 1; i >= 0; i--) {
        const entry = after[i]!;
        if (entry.type !== "message" || entry.role !== "assistant") continue;
        const text = extractMessageText(entry.content).trim();
        if (text) return text;
    }
    return "";
}

/** The answer card for the chat the question was asked from. */
function answerCard(question: string, answer: string): Container {
    const card = new Container();
    card.addChild(new Text(accent("↳ ") + accentTitle("btw") + dim(` · ${question.replace(/\s+/g, " ")}`), 1, 0));
    card.addChild(new DynamicBorder());
    card.addChild(new Markdown(answer, 1, 0, getMarkdownTheme()));
    card.addChild(new DynamicBorder());
    card.addChild(new Text(dim("not part of this conversation · /btw opens the thread to follow up"), 1, 0));
    return card;
}

export function createBtwThreads(host: BtwThreadsHost): BtwThreads {
    const { slots, roster, deps, tui, manager, slotFor } = host;
    /** Side threads by the session they were asked from, oldest first. */
    const asked = new Map<string, AskedThread[]>();

    const say = (slot: SessionSlot, text: string): void => {
        slot.history.addSystem(text);
        tui.requestRender();
    };

    const openThread = async (sessionId: string): Promise<void> => {
        slots.switchTo(await slotFor(sessionId));
    };

    /** Where this chat was asked from, when it is a side thread itself. */
    const parentOf = (slot: SessionSlot) => (slot.session ? btwParentIn(slot.session.getBranch()) : null);

    const goBack = async (source: SessionSlot): Promise<void> => {
        const parent = parentOf(source);
        if (!parent) {
            say(source, dim("this chat is not a side thread — /btw <question> asks one"));
            return;
        }
        await openThread(parent.parentId);
    };

    const BACK = "\x00back";

    const listThreads = async (source: SessionSlot): Promise<void> => {
        const threads = source.session ? (asked.get(source.session.id) ?? []) : [];
        const parent = parentOf(source);
        if (threads.length === 0 && !parent) {
            say(source, dim("no side threads here yet — /btw <question> asks one without touching this chat"));
            return;
        }
        const pick = await deps.selectOnce(
            [
                ...(parent
                    ? [{ value: BACK, label: `← Back to “${parent.parentTitle}”`, description: "the chat this was asked from" }]
                    : []),
                ...[...threads].reverse().map((t) => ({
                    value: t.sessionId,
                    label: t.question,
                    description: slots.bySessionId(t.sessionId)?.busy ? "answering…" : "open to follow up",
                })),
            ],
            threads.length > 0 ? `Side threads · ${threads.length}` : "Side thread",
        );
        if (!pick) return;
        if (pick.value === BACK) await goBack(source);
        else await openThread(pick.value);
    };

    const ask = async (source: SessionSlot, sourceSession: Session, question: string): Promise<void> => {
        const { session, meta } = await createBtwThread(manager, sourceSession, question);
        const slot = await slotFor(session.id, {
            choose: () => ({ modelId: source.modelId, thinkingLevel: source.thinkingLevel, agent: source.agent }),
        });
        const threads = asked.get(sourceSession.id) ?? [];
        threads.push({ sessionId: session.id, question });
        asked.set(sourceSession.id, threads);
        say(source, accent("↳ ") + "btw" + dim(" · asking in a side thread — the answer shows here; /btw opens it"));

        // Not awaited: the command returns at once, so this chat's own queue
        // keeps draining while the side thread answers.
        // The slot holds its own Session object for this id; the turn appends there.
        const thread = slot.session ?? session;
        const copied = thread.getBranch().length;
        void roster
            .runnerFor(slot)(question, { chatOnly: true, btw: meta })
            .then(() => deliverAnswer(source, question, answerOf(thread, copied)))
            .catch((error: unknown) => say(source, warn("btw") + dim(` · ${String(error)}`)));
    };

    const deliverAnswer = (source: SessionSlot, question: string, answer: string): void => {
        if (!answer) {
            say(source, warn("btw") + dim(" · the side thread ended without an answer — /btw opens it"));
            return;
        }
        source.history.addChild(answerCard(question, answer));
        tui.requestRender();
    };

    return {
        async askBtw(question) {
            const source = slots.foreground;
            if (!question) return listThreads(source);
            if (question === "back") return goBack(source);
            const sourceSession = source.session;
            if (!sourceSession || !sourceSession.getBranch().some((e) => e.type === "message")) {
                say(source, dim("nothing to ask about yet — this chat is empty, so just ask it here"));
                return;
            }
            if (!source.modelId) {
                say(source, dim("choose a model with /model first"));
                return;
            }
            await ask(source, sourceSession, question);
        },
    };
}
