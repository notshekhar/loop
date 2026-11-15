/**
 * The Telegram bridge: a full remote client for the agent, speaking the same
 * JSON-RPC surface as the web UI — attached in-process to an RpcServer, so
 * sessions, turn events, replay, settings and cost all come from the one
 * implementation.
 *
 * Transport is getUpdates long polling (no webhook, works behind NAT), and
 * Telegram allows exactly one poller per token, which doubles as a single-
 * bridge lock. Security model: the bridge answers ONE paired chat, claimed
 * with the one-time /start <code> from setup — everyone else is refused.
 * Possession of the paired chat is full control of this machine.
 *
 * The pieces live in ./bridge/: the RPC peer, the paired-chat send surface,
 * pairing, slash commands, menu callbacks, and the session + live-turn state.
 */
import { type TgMessage, type TgUpdate, type TgUser, TelegramApiError } from "./api";
import { handleCallback } from "./bridge/callbacks";
import { PairedChat, type TelegramApiLike } from "./bridge/chat";
import { BOT_COMMANDS, dispatchCommand } from "./bridge/commands";
import type { BridgeContext } from "./bridge/context";
import { Pairing } from "./bridge/pairing";
import { RpcPeer, type RpcAttachable } from "./bridge/rpc-peer";
import { ChatSession, type PromptImage, type SessionEventParams } from "./bridge/session";

export { BOT_COMMANDS } from "./bridge/commands";
export type { TelegramApiLike } from "./bridge/chat";
export type { RpcAttachable } from "./bridge/rpc-peer";

/** getUpdates long-poll window, in seconds. */
const POLL_TIMEOUT_SEC = 50;
/** Back-off after a 409: another poller holds the token, and it won't let go soon. */
const CONFLICT_RETRY_MS = 10_000;
/** Back-off after any other poll failure (network blip, Telegram 5xx). */
const POLL_ERROR_RETRY_MS = 3000;

export interface TelegramBridgeOpts {
    api: TelegramApiLike;
    rpc: RpcAttachable;
    /** Paired chat from the store; undefined until /start <code> claims it. */
    chatId?: number;
    pairCode?: string;
    /** Default cwd for sessions created from chat (the daemon's cwd). */
    cwd?: string;
    onPaired?: (chatId: number) => void;
    log?: (line: string) => void;
}

export class TelegramBridge {
    private readonly api: TelegramApiLike;
    private readonly peer: RpcPeer;
    private readonly log: (line: string) => void;
    private readonly chat: PairedChat;
    private readonly pairing: Pairing;
    private readonly session: ChatSession;
    private readonly ctx: BridgeContext;

    private stopped = false;
    private offset: number | undefined;

    constructor(opts: TelegramBridgeOpts) {
        this.api = opts.api;
        this.log = opts.log ?? (() => {});
        this.peer = new RpcPeer(opts.rpc);
        this.chat = new PairedChat(this.api, this.log, opts.chatId);
        this.pairing = new Pairing(this.chat, opts.pairCode, opts.onPaired, this.log);
        this.session = new ChatSession(this.chat, this.peer, this.log, opts.cwd ?? process.cwd());
        this.ctx = { chat: this.chat, peer: this.peer, session: this.session };
        this.peer.onNotification = (method, params) => {
            if (method === "session.event") this.session.onSessionEvent(params as SessionEventParams);
        };
    }

    /** Validate the token, register the command menu, and read server
     * defaults — everything that must succeed before we commit to polling.
     * Throws on a bad token so the caller can report it synchronously. */
    async startAndValidate(): Promise<TgUser> {
        const me = await this.api.getMe();
        await this.api.setMyCommands(BOT_COMMANDS);
        const info = await this.peer.call<{ defaults?: { model?: string | null } }>("server.info");
        this.session.defaultModel = info.defaults?.model ?? null;
        return me;
    }

    /** Poll until stop(). Call after startAndValidate() has succeeded. */
    pollForever(): Promise<void> {
        return this.pollLoop();
    }

    /** Validate then poll — the all-in-one path for tests and simple callers. */
    async run(): Promise<TgUser> {
        const me = await this.startAndValidate();
        await this.pollLoop();
        return me;
    }

    stop(): void {
        this.stopped = true;
        this.session.stop();
        this.peer.close();
    }

    private async pollLoop(): Promise<void> {
        while (!this.stopped) {
            try {
                const updates = await this.api.getUpdates({ offset: this.offset, timeoutSec: POLL_TIMEOUT_SEC });
                for (const update of updates) {
                    this.offset = update.update_id + 1;
                    await this.handleUpdate(update);
                }
            } catch (err) {
                if (this.stopped) return;
                if (err instanceof TelegramApiError && err.code === 409) {
                    this.log("another poller is consuming this bot (409) — only one bridge can run per token");
                    await sleep(CONFLICT_RETRY_MS);
                } else {
                    this.log(`poll error: ${(err as Error).message}`);
                    await sleep(POLL_ERROR_RETRY_MS);
                }
            }
        }
    }

    /** Public for tests: one update through the full router. */
    async handleUpdate(update: TgUpdate): Promise<void> {
        try {
            if (update.message) await this.handleMessage(update.message);
            else if (update.callback_query) await handleCallback(this.ctx, update.callback_query);
        } catch (err) {
            this.log(`update failed: ${(err as Error).message}`);
            if (this.chat.chatId) {
                await this.chat.replySafe(`error: ${(err as Error).message}`);
            }
        }
    }

    private async handleMessage(msg: TgMessage): Promise<void> {
        const from = msg.chat.id;
        const raw = (msg.text ?? msg.caption ?? "").trim();

        if (raw.startsWith("/start")) {
            await this.pairing.handleStart(from, raw);
            return;
        }
        if (!this.chat.isPaired(from)) {
            await this.chat.refuse(from);
            return;
        }
        if (raw.startsWith("/")) {
            await dispatchCommand(this.ctx, raw);
            return;
        }

        // Plain text (and/or photos): a prompt to the active session.
        const images = await this.collectImages(msg);
        if (!raw && images.length === 0) return;
        await this.session.sendPrompt(raw, images);
    }

    private async collectImages(msg: TgMessage): Promise<PromptImage[]> {
        // Telegram sends multiple sizes per photo, smallest first — take the
        // largest. Photos are always jpeg.
        const best = msg.photo?.at(-1);
        if (!best) return [];
        const { data } = await this.api.getFileBase64(best.file_id);
        return [{ data, mediaType: "image/jpeg" }];
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
