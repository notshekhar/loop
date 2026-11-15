/** Inline-keyboard taps (callback queries) from the menus the commands draw. */
import { THINKING_LEVELS, type ThinkingLevel } from "../../agent/thinking";
import type { InlineKeyboard, TgCallbackQuery } from "../api";
import { extensionsKeyboard, modelKeyboard, settingsKeyboard } from "../menus";
import type { BridgeContext } from "./context";
import { authorizedModels, sessionsPage } from "./queries";

/** The tapped menu: answer the tap, and redraw the message it came from. */
interface Tap {
    value: string;
    ack(text?: string): Promise<void>;
    edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
}

type CallbackHandler = (ctx: BridgeContext, tap: Tap) => Promise<void>;

/** Route a callback query by its `prefix:value` data. */
export async function handleCallback(ctx: BridgeContext, cb: TgCallbackQuery): Promise<void> {
    const chat = cb.message?.chat.id ?? cb.from.id;
    if (!ctx.chat.isPaired(chat)) {
        await ctx.chat.answerCallback(cb.id, "not authorized");
        return;
    }
    const data = cb.data ?? "";
    const sep = data.indexOf(":");
    const prefix = sep < 0 ? data : data.slice(0, sep);
    const msg = cb.message;
    const tap: Tap = {
        value: sep < 0 ? "" : data.slice(sep + 1),
        ack: (text) => ctx.chat.answerCallback(cb.id, text),
        edit: async (text, keyboard) => {
            if (msg) await ctx.chat.editMenu(msg.message_id, text, keyboard);
        },
    };
    const handler = CALLBACKS[prefix] as CallbackHandler | undefined;
    if (handler) await handler(ctx, tap);
    else await tap.ack();
}

async function toggleSetting({ peer }: BridgeContext, tap: Tap): Promise<void> {
    const rows = await peer.call<{ key: string; label: string; value: boolean }[]>("settings.list");
    const row = rows.find((r) => r.key === tap.value);
    if (!row) {
        await tap.ack("unknown setting");
        return;
    }
    await peer.call("settings.set", { key: row.key, value: !row.value });
    row.value = !row.value;
    await tap.edit("settings — tap to toggle", settingsKeyboard(rows));
    await tap.ack(`${row.label}: ${row.value ? "on" : "off"}`);
}

async function pickProvider({ peer, session }: BridgeContext, tap: Tap): Promise<void> {
    const models = await authorizedModels(peer, tap.value);
    if (!models.length) {
        // Logged out (or the provider lost availability) between
        // opening the menu and tapping it.
        await tap.ack("no models available for that provider");
        return;
    }
    session.modelList = models;
    await tap.edit(`${tap.value} — pick a model`, modelKeyboard(models, session.model));
    await tap.ack();
}

async function pickModel({ session }: BridgeContext, tap: Tap): Promise<void> {
    const hit = session.modelList?.[Number(tap.value)];
    if (!hit) {
        await tap.ack("menu expired — /model again");
        return;
    }
    session.selectModel(hit);
    await tap.edit(`model set: ${hit.id}`);
    await tap.ack("model set");
}

async function turnSessionsPage({ peer }: BridgeContext, tap: Tap): Promise<void> {
    const page = await sessionsPage(peer, Number(tap.value) || 0);
    if (!page) {
        await tap.ack("no sessions");
        return;
    }
    await tap.edit(page.title, page.keyboard);
    await tap.ack();
}

// The page indicator between the arrows. Telegram requires every
// button to carry callback data, and an unanswered query spins on
// the client, so it needs a handler even though it does nothing.
async function nothing(_ctx: BridgeContext, tap: Tap): Promise<void> {
    await tap.ack();
}

async function switchSession({ session }: BridgeContext, tap: Tap): Promise<void> {
    await session.switchTo(tap.value);
    await tap.edit(`session: ${tap.value}`);
    await tap.ack("session switched");
    await session.replayTranscript(tap.value);
}

async function pickThinking({ session }: BridgeContext, tap: Tap): Promise<void> {
    if (!THINKING_LEVELS.includes(tap.value as ThinkingLevel)) {
        await tap.ack("unknown level");
        return;
    }
    session.thinking = tap.value as ThinkingLevel;
    await tap.edit(`thinking: ${tap.value}`);
    await tap.ack(`thinking: ${tap.value}`);
}

async function toggleExtension({ peer }: BridgeContext, tap: Tap): Promise<void> {
    const rows = await peer.call<{ name: string; enabled: boolean }[]>("extension.list");
    const row = rows.find((r) => r.name === tap.value);
    if (!row) {
        await tap.ack("unknown extension");
        return;
    }
    await peer.call("extension.setEnabled", { name: row.name, value: !row.enabled });
    row.enabled = !row.enabled;
    await tap.edit("extensions — tap to toggle", extensionsKeyboard(rows));
    await tap.ack(`${row.name}: ${row.enabled ? "on" : "off"}`);
}

const CALLBACKS: Record<string, CallbackHandler> = {
    set: toggleSetting,
    prov: pickProvider,
    mdl: pickModel,
    sesp: turnSessionsPage,
    nop: nothing,
    ses: switchSession,
    thk: pickThinking,
    ext: toggleExtension,
};
