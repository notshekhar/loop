/**
 * The paired chat as a send surface: every message, edit and callback answer
 * the bridge makes to the one chat it serves, with the HTML→plain fallbacks
 * and "never throw on an error path" rules in one place.
 */
import {
    isNotModifiedError,
    isParseError,
    type BotCommandDef,
    type InlineKeyboard,
    type TgMessage,
    type TgUpdate,
    type TgUser,
} from "../api";
import { htmlToPlain } from "../render";

/** Minimum surface of TelegramApi the bridge uses — tests inject a fake. */
export interface TelegramApiLike {
    getMe(): Promise<TgUser>;
    getUpdates(opts: { offset?: number; timeoutSec?: number }): Promise<TgUpdate[]>;
    sendMessage(opts: { chatId: number; text: string; html?: boolean; keyboard?: InlineKeyboard }): Promise<TgMessage>;
    editMessageText(opts: {
        chatId: number;
        messageId: number;
        text: string;
        html?: boolean;
        keyboard?: InlineKeyboard;
    }): Promise<void>;
    answerCallbackQuery(id: string, text?: string): Promise<void>;
    setMyCommands(commands: BotCommandDef[]): Promise<void>;
    sendChatAction(chatId: number, action?: string): Promise<void>;
    sendDocument(opts: { chatId: number; filename: string; content: string; caption?: string }): Promise<void>;
    getFileBase64(fileId: string): Promise<{ data: string; size: number }>;
}

export interface ReplyOpts {
    html?: boolean;
    keyboard?: InlineKeyboard;
}

export class PairedChat {
    constructor(
        private readonly api: TelegramApiLike,
        private readonly log: (line: string) => void,
        /** Paired chat from the store; undefined until /start <code> claims it. */
        public chatId?: number,
    ) {}

    isPaired(id: number): boolean {
        return this.chatId !== undefined && this.chatId === id;
    }

    reply(text: string, opts: ReplyOpts = {}): Promise<TgMessage> {
        if (this.chatId === undefined) throw new Error("no paired chat");
        return this.api.sendMessage({ chatId: this.chatId, text, html: opts.html, keyboard: opts.keyboard });
    }

    /** Reply that never throws — for error paths and HTML fallbacks. */
    async replySafe(text: string, opts: ReplyOpts = {}): Promise<void> {
        try {
            await this.reply(text, opts);
        } catch (err) {
            if (opts.html && isParseError(err)) {
                try {
                    await this.reply(htmlToPlain(text));
                    return;
                } catch {}
            }
            this.log(`send failed: ${(err as Error).message}`);
        }
    }

    /** Send an HTML message, falling back to plain text if Telegram rejects the
     * markup, and return the sent message (for later edits) or undefined. */
    async sendHtml(text: string): Promise<TgMessage | undefined> {
        try {
            return await this.reply(text, { html: true });
        } catch (err) {
            if (isParseError(err)) {
                try {
                    return await this.reply(htmlToPlain(text));
                } catch {}
            }
            this.log(`send failed: ${(err as Error).message}`);
            return undefined;
        }
    }

    /** Edit a message's HTML in place, logging (as `what`) anything but a
     * harmless "message is not modified". */
    async editHtml(messageId: number, html: string, what: string): Promise<void> {
        try {
            await this.api.editMessageText({ chatId: this.chatId!, messageId, text: html, html: true });
        } catch (err) {
            if (!isNotModifiedError(err)) this.log(`${what} failed: ${(err as Error).message}`);
        }
    }

    /** Replace a streamed message's content with its final HTML, falling back to
     * plain text if Telegram rejects the markup. */
    async finalizeMessage(messageId: number, html: string): Promise<void> {
        try {
            await this.api.editMessageText({ chatId: this.chatId!, messageId, text: html, html: true });
        } catch (err) {
            if (isParseError(err)) {
                await this.api
                    .editMessageText({ chatId: this.chatId!, messageId, text: htmlToPlain(html) })
                    .catch(() => {});
            } else if (!isNotModifiedError(err)) {
                this.log(`finalize edit failed: ${(err as Error).message}`);
            }
        }
    }

    /** Redraw an inline-keyboard menu message; best-effort, never throws. */
    async editMenu(messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
        await this.api.editMessageText({ chatId: this.chatId!, messageId, text, keyboard }).catch(() => {});
    }

    /** Answer a callback query; best-effort — an unanswered one just spins. */
    async answerCallback(id: string, text?: string): Promise<void> {
        await this.api.answerCallbackQuery(id, text).catch(() => {});
    }

    sendDocument(filename: string, content: string, caption: string): Promise<void> {
        return this.api.sendDocument({ chatId: this.chatId!, filename, content, caption });
    }

    /** Show the "typing…" cue; best-effort. */
    sendTyping(): void {
        this.api.sendChatAction(this.chatId!).catch(() => {});
    }

    /** Refuse a chat that isn't the paired one. Human-triggered, so a reply per
     * attempt can't loop; don't leak whether the bridge is paired. */
    async refuse(chatId: number): Promise<void> {
        await this.notify(chatId, "not authorized");
    }

    /** Message any chat (paired or not), swallowing failures. */
    async notify(chatId: number, text: string): Promise<void> {
        await this.api.sendMessage({ chatId, text }).catch(() => {});
    }
}
