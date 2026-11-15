/**
 * Live rendering of the turn in flight. The bridge streams the turn as it
 * happens: each tool call is its own message, and each block of assistant
 * prose streams token-by-token into its own message (edited live), then seals
 * to formatted markdown. Reads like a chat transcript that types itself out.
 */
import {
    escapeHtml,
    markdownToTelegramChunks,
    streamCut,
    streamPreview,
    STREAM_SOFT_LIMIT,
    toolMessageHtml,
    truncate,
} from "../render";
import type { PairedChat } from "./chat";

/** Telegram clears a chat action after ~5s; refresh it a little sooner. */
const TYPING_REFRESH_MS = 4000;
/** Min gap between live edits of a streaming message — Telegram rate-limits
 * edits to roughly one per second per message; 1.5s keeps comfortable margin. */
const EDIT_INTERVAL_MS = 1500;

/** A block of assistant prose being streamed live: grown by editing the active
 * Telegram message as tokens arrive (like the TUI's live text). When the active
 * message fills up it's sealed and a new one continues the block, so a long
 * answer streams across as many messages as it needs — no truncation. */
interface TextStream {
    /** The message currently growing. */
    messageId: number;
    /** Full text of this block so far (across all its messages). */
    text: string;
    /** Chars of `text` already sealed into earlier, completed messages. */
    committedLen: number;
    /** Last preview pushed to the active message — skip identical edits. */
    sent: string;
    /** Wall-clock of the last edit; throttles edits to EDIT_INTERVAL_MS. */
    lastEditAt: number;
}

export class LiveTurn {
    readonly startedAt = Date.now();
    /** The assistant-text message currently streaming, if any. */
    private stream?: TextStream;
    /** Leading tokens held back until they contain something worth showing —
     * models often emit whitespace first, and a message created from that
     * would render as an empty bubble (then seal to a stray "…"). */
    private pendingHead?: string;
    /** toolCallId → the message showing that call, so a failure can edit it. */
    private toolMsgs = new Map<string, { messageId: number; html: string }>();
    /** Keeps the Telegram "typing…" cue alive while the turn runs. */
    private typingTimer?: ReturnType<typeof setInterval>;
    /** True once any message (tool or text) has been sent this turn. */
    sentAny = false;
    done = false;

    constructor(private readonly chat: PairedChat) {}

    startTyping(): void {
        if (this.chat.chatId === undefined) return;
        this.chat.sendTyping();
        this.typingTimer = setInterval(() => {
            if (this.done) return;
            this.chat.sendTyping();
        }, TYPING_REFRESH_MS);
    }

    stopTyping(): void {
        if (this.typingTimer) {
            clearInterval(this.typingTimer);
            this.typingTimer = undefined;
        }
    }

    /** Grow the current streaming text block by `chunk`, live-editing its
     * Telegram message (throttled). Creates the message on the first token, and
     * rolls to a new message when the active one fills — the whole answer
     * streams, however long, with nothing truncated. */
    async streamText(chunk: string): Promise<void> {
        if (this.done || !chunk) return;
        if (!this.stream) {
            await this.openStream(chunk);
            return;
        }
        this.stream.text += chunk;
        // Active (uncommitted) portion outgrew one message → seal it and open a
        // fresh streaming message for the remainder before it can overflow.
        while (this.stream.text.length - this.stream.committedLen > STREAM_SOFT_LIMIT) {
            if (!(await this.rollStream())) break;
        }
        if (Date.now() - this.stream.lastEditAt >= EDIT_INTERVAL_MS) await this.pushStreamEdit();
    }

    /** Start a text block's first message — held back until there's
     * non-whitespace to show. */
    private async openStream(chunk: string): Promise<void> {
        this.pendingHead = (this.pendingHead ?? "") + chunk;
        if (!this.pendingHead.trim()) return;
        const head = this.pendingHead;
        this.pendingHead = undefined;
        const preview = streamPreview(head);
        const msg = await this.chat.sendHtml(preview);
        if (!msg) return;
        this.stream = {
            messageId: msg.message_id,
            text: head,
            committedLen: 0,
            sent: preview,
            lastEditAt: Date.now(),
        };
        this.sentAny = true;
    }

    /** The uncommitted tail of the streaming block — what the active message shows. */
    private activeStreamText(): string {
        const s = this.stream!;
        return s.text.slice(s.committedLen);
    }

    /** Push the current streaming preview to the active message (skip no-ops). */
    private async pushStreamEdit(): Promise<void> {
        if (!this.stream) return;
        const preview = streamPreview(this.activeStreamText());
        if (preview === this.stream.sent) return;
        this.stream.sent = preview;
        this.stream.lastEditAt = Date.now();
        await this.chat.editHtml(this.stream.messageId, preview, "stream edit");
    }

    /** Seal the active message at a line boundary and continue the block in a
     * new streaming message. Returns false if a new message couldn't be sent
     * (so the caller stops looping). */
    private async rollStream(): Promise<boolean> {
        const stream = this.stream;
        if (!stream) return false;
        const active = this.activeStreamText();
        const head = active.slice(0, streamCut(active));
        // Seal this message with fully-rendered markdown — the same treatment
        // sealStream gives the final block. Passing raw text with html:true
        // would leave it unformatted (or trip Telegram's HTML parser).
        await this.sealMarkdown(stream.messageId, head);
        stream.committedLen += head.length;
        const preview = streamPreview(this.activeStreamText());
        const msg = await this.chat.sendHtml(preview);
        if (!msg) {
            this.stream = undefined;
            return false;
        }
        stream.messageId = msg.message_id;
        stream.sent = preview;
        stream.lastEditAt = Date.now();
        return true;
    }

    /** Finish the current text block: re-render its remaining active text as
     * full markdown into the active message (plus overflow messages), and clear
     * the stream so the next block starts fresh. */
    async sealStream(): Promise<void> {
        if (!this.stream) return;
        const { messageId } = this.stream;
        const active = this.activeStreamText();
        this.stream = undefined;
        await this.sealMarkdown(messageId, active);
    }

    /** Render `text` as markdown into `messageId`, overflowing into new messages. */
    private async sealMarkdown(messageId: number, text: string): Promise<void> {
        const chunks = markdownToTelegramChunks(text.trim() || "…");
        await this.chat.finalizeMessage(messageId, chunks[0]);
        for (let i = 1; i < chunks.length; i++) await this.chat.sendHtml(chunks[i]);
    }

    /** A tool started: seal any streaming prose before it (keeps order), then
     * post the call as its own message. */
    async onToolCall(
        toolCallId: string | undefined,
        toolName: string | undefined,
        input: unknown,
        agent?: string,
    ): Promise<void> {
        if (this.done) return;
        await this.sealStream();
        const html = toolMessageHtml(toolName, input, agent);
        const msg = await this.chat.sendHtml(html);
        this.sentAny = true;
        if (msg && toolCallId) this.toolMsgs.set(toolCallId, { messageId: msg.message_id, html });
    }

    /** A tool failed: mark its message (or post a standalone failure). */
    async onToolError(toolCallId: string | undefined, toolName: string | undefined, error: unknown): Promise<void> {
        if (this.done) return;
        const line = `<i>failed: ${escapeHtml(truncate(String(error ?? ""), 160))}</i>`;
        const entry = toolCallId ? this.toolMsgs.get(toolCallId) : undefined;
        if (entry) {
            await this.chat.editHtml(entry.messageId, `${entry.html}\n${line}`, "tool-error edit");
        } else {
            await this.chat.sendHtml(`${toolMessageHtml(toolName, undefined)}\n${line}`);
            this.sentAny = true;
        }
    }
}
