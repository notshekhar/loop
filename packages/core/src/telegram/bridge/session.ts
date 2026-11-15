/**
 * The paired chat's conversation: which session it talks to, on what model,
 * and the lifecycle of its turns — start, interrupt, queue, stream, finish.
 * A single paired chat by design, so this is one object, not a map.
 */
import type { ThinkingLevel } from "../../agent/thinking";
import type { CostBreakdown } from "../../types";
import type { ModelRow } from "../menus";
import { escapeHtml, sessionTranscriptMessages, truncate } from "../render";
import type { PairedChat } from "./chat";
import { LiveTurn } from "./live-turn";
import type { RpcCaller } from "./rpc-peer";

export interface PromptImage {
    data: string;
    mediaType: string;
}

/** A prompt waiting to run. `interrupt` marks one that displaced the turn in
 * flight (a plain message sent mid-turn) — those keep their arrival order ahead
 * of anything explicitly /queue'd. */
export interface QueuedPrompt {
    text: string;
    images: PromptImage[];
    interrupt: boolean;
}

export interface SessionEventParams {
    sessionId: string;
    part: { type: string; data: unknown };
}

export class ChatSession {
    sessionId?: string;
    model?: string;
    provider?: string;
    thinking?: ThinkingLevel;
    defaultModel: string | null = null;
    live?: LiveTurn;
    /** Ordered model list backing the open /model menu (mdl:<idx> taps). */
    modelList?: ModelRow[];
    /** Prompts waiting for the current turn to end (see QueuedPrompt). */
    queue: QueuedPrompt[] = [];
    /** Set while an interrupt-cancel is in flight, so finalizeTurn reports the
     * abort as an interruption instead of an error. */
    private interrupting = false;
    /** Serializes turn-event handling: sends (tool messages, prose, footer)
     * must land in arrival order, so each event handler runs after the last
     * one settles rather than racing on the microtask queue. */
    private eventQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly chat: PairedChat,
        private readonly peer: RpcCaller,
        private readonly log: (line: string) => void,
        /** Default cwd for sessions created from chat (the daemon's cwd). */
        public cwd: string,
    ) {}

    /** The model a prompt sent now would run on. */
    activeModel(): string | null {
        return this.model ?? this.defaultModel;
    }

    selectModel(row: ModelRow): void {
        this.model = row.id;
        this.provider = row.provider;
    }

    isTurnRunning(): boolean {
        return !!this.live && !this.live.done;
    }

    /** Bridge shutdown. Clear the typing interval too — stopping mid-turn would
     * otherwise leave a repeating timer holding the event loop open. */
    stop(): void {
        this.live?.stopTyping();
        if (this.live) this.live.done = true;
    }

    /** /new: let go of the current session. Cancel (not just forget) a turn
     * still running on it, and don't let prompts aimed at it carry over. */
    async startFresh(): Promise<void> {
        await this.abandonTurn();
        this.sessionId = undefined;
        this.queue = [];
    }

    /** Switch the chat to an existing session. Same as /new: don't leave a turn
     * running on the session we're switching away from. */
    async switchTo(sessionId: string): Promise<void> {
        const previous = this.sessionId;
        await this.abandonTurn();
        await this.peer.call("session.open", { sessionId });
        await this.peer.call("session.attach", { sessionId });
        if (previous && previous !== sessionId) {
            await this.peer.call("session.detach", { sessionId: previous }).catch(() => {});
        }
        this.sessionId = sessionId;
        // Prompts queued for the previous session don't carry over.
        this.queue = [];
    }

    /** Explicit /queue: run `text` after the current turn. */
    enqueuePrompt(text: string): void {
        this.queue.push({ text, images: [], interrupt: false });
    }

    async sendPrompt(text: string, images: PromptImage[] = []): Promise<void> {
        // A turn in flight (including one mid-finalization) is interrupted, not
        // refused — see interruptWith.
        if (this.live) {
            await this.interruptWith({ text, images, interrupt: true });
            return;
        }
        const model = this.activeModel();
        if (!model) {
            await this.chat.replySafe("no model configured — pick one with /model first");
            return;
        }
        await this.ensureSession(model);
        // Arm the live turn BEFORE session.send: the server starts streaming as
        // soon as it accepts, and onSessionEvent drops events while `live` is
        // unset — setting it afterwards can lose the turn's first tokens.
        this.live = new LiveTurn(this.chat);
        this.live.startTyping();
        try {
            await this.peer.call("session.send", {
                sessionId: this.sessionId,
                input: text,
                model,
                ...(this.thinking ? { thinking: this.thinking } : {}),
                ...(images.length ? { images } : {}),
            });
        } catch (err) {
            // The turn never started — tear the live state down, or every later
            // message would be refused with "a turn is already running".
            this.live.stopTyping();
            this.live = undefined;
            throw err;
        }
    }

    private async ensureSession(model: string): Promise<void> {
        if (this.sessionId) return;
        const created = await this.peer.call<{ sessionId: string }>("session.create", {
            cwd: this.cwd,
            model,
            ...(this.provider ? { provider: this.provider } : {}),
        });
        this.sessionId = created.sessionId;
        await this.peer.call("session.attach", { sessionId: this.sessionId });
    }

    /**
     * A plain message sent mid-turn INTERRUPTS: Telegram has no Esc key, so the
     * natural way to redirect the agent is to just say the next thing. The
     * running turn is cancelled and this prompt runs as soon as it unwinds.
     * `/queue` is the explicit "wait your turn" path.
     */
    private async interruptWith(prompt: QueuedPrompt): Promise<void> {
        // Insert after any interrupts already waiting (preserving the order the
        // user typed them) but ahead of everything explicitly queued.
        const firstQueued = this.queue.findIndex((q) => !q.interrupt);
        this.queue.splice(firstQueued === -1 ? this.queue.length : firstQueued, 0, prompt);
        if (this.interrupting) return; // a cancel is already unwinding the turn
        this.interrupting = true;
        await this.chat.replySafe("<i>interrupting…</i>", { html: true });
        try {
            await this.peer.call("session.cancel", { sessionId: this.sessionId });
        } catch (err) {
            this.log(`interrupt cancel failed: ${(err as Error).message}`);
        }
    }

    /** Drop the turn in flight because the session it belongs to is going away
     * (/new, session switch). Cancels it server-side — otherwise it keeps
     * running and burning tokens with its output going nowhere — and stops the
     * typing cue, whose interval would otherwise outlive the LiveTurn holding it. */
    private async abandonTurn(): Promise<void> {
        const live = this.live;
        if (!live) return;
        live.stopTyping();
        live.done = true;
        this.live = undefined;
        this.interrupting = false;
        if (this.sessionId) {
            await this.peer.call("session.cancel", { sessionId: this.sessionId }).catch(() => {});
        }
    }

    /** Run the next waiting prompt, if the turn slot is free. */
    async drainQueue(): Promise<void> {
        if (this.live || !this.queue.length) return;
        const next = this.queue.shift()!;
        try {
            await this.sendPrompt(next.text, next.images);
        } catch (err) {
            // Nobody is watching the daemon log, and the send happened without a
            // message of the user's to answer — report it in chat, then carry on
            // with the rest of the queue rather than stranding it.
            await this.chat.replySafe(`queued message failed to start: ${(err as Error).message}`);
            await this.drainQueue();
        }
    }

    /** Run turn-event handlers one at a time, in the order events arrived. */
    private enqueue(fn: () => Promise<void> | void): void {
        this.eventQueue = this.eventQueue
            .then(fn)
            .catch((err) => this.log(`event handler failed: ${(err as Error).message}`));
    }

    /** Route a server turn event to the live turn. Handlers read `this.live`
     * when they run, not when they're queued. */
    onSessionEvent(params: SessionEventParams): void {
        if (params.sessionId !== this.sessionId || !this.live || this.live.done) return;
        const { type, data } = params.part;
        switch (type) {
            case "text-delta": {
                const chunk = String(data);
                this.enqueue(() => this.live?.streamText(chunk));
                break;
            }
            case "tool-call": {
                const d = data as { toolName?: string; input?: unknown; toolCallId?: string };
                this.enqueue(() => this.live?.onToolCall(d.toolCallId, d.toolName, d.input));
                break;
            }
            case "tool-error": {
                const d = data as { toolCallId?: string; toolName?: string; error?: unknown };
                this.enqueue(() => this.live?.onToolError(d.toolCallId, d.toolName, d.error));
                break;
            }
            case "subagent-tool": {
                const d = data as { agent: string; toolName?: string; input?: unknown };
                this.enqueue(() => this.live?.onToolCall(undefined, d.toolName, d.input, d.agent));
                break;
            }
            case "compact-start":
                this.enqueue(async () => {
                    await this.chat.sendHtml("<i>compacting context…</i>");
                    if (this.live) this.live.sentAny = true;
                });
                break;
            case "finish":
                this.enqueue(() => this.finalizeTurn());
                break;
            case "error":
                this.enqueue(() => this.finalizeTurn(String(data)));
                break;
            default:
                break;
        }
    }

    private async finalizeTurn(error?: string): Promise<void> {
        const live = this.live;
        if (!live || live.done) return;
        live.stopTyping();
        // Seal the final prose block BEFORE flipping `done` — sealStream and the
        // streaming edits both guard on `done`, and the last block must land.
        await live.sealStream();
        live.done = true;
        await this.reportTurnEnd(live, error);
        // Only clear if still ours — defensive against any future path that
        // could replace this.live while we awaited above.
        if (this.live === live) this.live = undefined;
        this.interrupting = false;
        // Hand the freed slot to whatever was waiting.
        await this.drainQueue();
    }

    /** The turn's closing messages: an error or "(no output)" note, then the
     * elapsed-time-and-cost footer. */
    private async reportTurnEnd(live: LiveTurn, error?: string): Promise<void> {
        const footer = await this.turnFooter(live);
        if (error && !this.interrupting) {
            await this.chat.sendHtml(`<i>error: ${escapeHtml(truncate(error, 300))}</i>`);
        } else if (!error && !live.sentAny) {
            // A turn that produced neither prose nor tools — acknowledge it.
            await this.chat.sendHtml("<i>(no output)</i>");
        }
        // An interrupt's abort is expected, not an error worth a footer either.
        if (!this.interrupting) await this.chat.sendHtml(`<i>${escapeHtml(footer)}</i>`);
    }

    private async turnFooter(live: LiveTurn): Promise<string> {
        const elapsed = Math.round((Date.now() - live.startedAt) / 1000);
        let footer = `${elapsed}s`;
        try {
            const cost = await this.peer.call<CostBreakdown>("cost.session", { sessionId: this.sessionId });
            if (cost.usd > 0) footer += ` · ${cost.estimated ? "~" : ""}$${cost.usd.toFixed(4)}`;
        } catch {}
        return footer;
    }

    /** After switching to a session, replay its recent transcript to the chat
     * so the resumed conversation has visible context (not just an id). Capped;
     * /export ships the full thing. Best-effort — a render failure is logged,
     * never fatal to the switch. */
    async replayTranscript(sessionId: string): Promise<void> {
        try {
            const h = await this.peer.call<{ name?: string; entries: unknown[] }>("session.history", { sessionId });
            const parts = sessionTranscriptMessages(h.entries as never[], { name: h.name });
            for (const part of parts) await this.chat.sendHtml(part);
        } catch (err) {
            this.log(`transcript replay failed: ${(err as Error).message}`);
        }
    }
}
