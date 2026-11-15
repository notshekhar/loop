/**
 * Claiming the bridge: the first chat to send /start <code> with the one-time
 * code from setup becomes the paired chat; every other chat is refused.
 */
import { PRODUCT_NAME } from "../../brand";
import type { PairedChat } from "./chat";

const NOT_READY_TEXT =
    `this bot isn't ready to pair. In ${PRODUCT_NAME} on your computer, run ` +
    `/gateways → Telegram to generate a pairing link, then tap it here.`;

const MISSING_CODE_TEXT =
    "to connect, open the pairing link from your computer — in " +
    `${PRODUCT_NAME}: /gateways → Telegram → “show pairing link” — and tap it. ` +
    "Pressing START here by hand won't work: the link carries a one-time code that this message is missing.";

const PAIRED_TEXT =
    "connected. send a message to talk to the agent — it runs with full shell access on the host machine.\n" +
    "/help lists commands, /new starts a fresh session, /cancel stops a running turn";

export class Pairing {
    constructor(
        private readonly chat: PairedChat,
        private pairCode: string | undefined,
        private readonly onPaired: ((chatId: number) => void) | undefined,
        private readonly log: (line: string) => void,
    ) {}

    async handleStart(from: number, raw: string): Promise<void> {
        if (this.chat.isPaired(from)) {
            await this.chat.replySafe("already connected — send a message to talk to the agent, /help for commands");
            return;
        }
        if (this.chat.chatId !== undefined) {
            await this.chat.refuse(from);
            return;
        }
        const code = raw.split(/\s+/)[1] ?? "";
        if (!this.pairCode) {
            // Bridge is polling but there's no unclaimed code — setup isn't
            // finished, or a previous pairing already burned it.
            await this.chat.notify(from, NOT_READY_TEXT);
            return;
        }
        if (code !== this.pairCode) {
            // Almost always a bare /start: Telegram's START button (and typing
            // /start by hand) sends no code. The code only rides the deep link,
            // which the operator opens from the TUI — never echo it here, or
            // anyone who messages the bot could pair.
            await this.chat.notify(from, MISSING_CODE_TEXT);
            return;
        }
        await this.claim(from);
    }

    private async claim(from: number): Promise<void> {
        this.chat.chatId = from;
        this.pairCode = undefined;
        this.onPaired?.(from);
        this.log(`paired with chat ${from}`);
        await this.chat.replySafe(PAIRED_TEXT);
    }
}
