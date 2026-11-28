/**
 * Chat Import — bring a conversation from Claude Code, Codex or Cursor into
 * loop, and keep going from where it stopped.
 *
 * `/claude-import`, `/codex-import`, `/cursor-import` list that agent's chats
 * from the folder loop is open in; with a session id they open that chat from
 * anywhere. `/import` lists all three agents' chats in one picker. Either way
 * the chat is PREVIEWED first — drawn in the transcript the way loop would
 * have drawn it, with what it cost — and only a "Save" in the menu that
 * follows writes it, as a new loop session in this folder, with its calls in
 * the cost ledger. Discarding leaves nothing behind. A chat that was already
 * imported opens its session instead of becoming a second copy.
 *
 * Reading never writes: transcripts are read as files, and databases are
 * opened read-only (or copied) — see files.ts.
 */
import type { CommandContext } from "../../../commands/registry";
import { getSetting } from "../../../settings";
import type { ExtensionAPI } from "../../api";
import { claudeCodeSource } from "./claude-code";
import { codexSource } from "./codex";
import { estimateChatCost } from "./cost";
import { cursorSource } from "./cursor";
import { chatPickerItems } from "./picker";
import { type ChatSource, defaultRoots, type ImportedChat, type SourceRoots } from "./source";

interface ImportCommand {
    name: string;
    source: (roots: SourceRoots) => ChatSource;
}

const COMMANDS: ImportCommand[] = [
    { name: "claude-import", source: claudeCodeSource },
    { name: "codex-import", source: codexSource },
    { name: "cursor-import", source: cursorSource },
];

/** Prices a source that names no model (Cursor) when loop has no default either. */
const FALLBACK_MODEL = "anthropic/claude-sonnet-5-5";

const allSources = () => COMMANDS.map((c) => c.source(defaultRoots()));

// Loaded on use: the import records sit beside the cost ledger, which imports
// the catalog, which imports the extension host — which imports this file.
const importRecords = () => import("../../../sessions/chat-imports");

export default {
    activate(api: ExtensionAPI) {
        for (const command of COMMANDS) {
            const source = () => command.source(defaultRoots());
            api.commands.register({
                name: command.name,
                description: `Import a ${source().label} chat from this folder (preview with its cost, then save or discard): /${command.name} [session id]`,
                handler: (ctx, args) => importOne(api, ctx, source(), args.trim(), command.name),
            });
        }
        api.commands.register({
            name: "import",
            description:
                "Import a chat from Claude Code, Codex or Cursor — every agent's chats in this folder in one list",
            handler: (ctx) => importAny(api, ctx),
        });
    },
};

async function importOne(
    api: ExtensionAPI,
    ctx: CommandContext,
    source: ChatSource,
    id: string,
    command: string,
): Promise<void> {
    const chatId = id || (await pickChat(api, ctx, [source], `/${command} <session id> imports one from anywhere`));
    if (chatId) await previewChat(ctx, source, chatId);
}

async function importAny(api: ExtensionAPI, ctx: CommandContext): Promise<void> {
    const sources = allSources();
    const picked = await pickChat(
        api,
        ctx,
        sources,
        "/claude-import, /codex-import or /cursor-import <session id> imports one from anywhere",
    );
    if (!picked) return;
    const [sourceId, chatId] = splitPick(picked);
    const source = sources.find((s) => s.id === sourceId);
    if (source) await previewChat(ctx, source, chatId);
}

/**
 * The picker of this folder's chats from `sources`, newest first; already
 * imported ones are marked. Returns the chat id — `source:id` when the picker
 * spans several sources — or undefined when there are none or the user backed out.
 */
async function pickChat(
    api: ExtensionAPI,
    ctx: CommandContext,
    sources: ChatSource[],
    hint: string,
): Promise<string | undefined> {
    const several = sources.length > 1;
    const { importedChatIds } = await importRecords();
    const rows = sources.flatMap((source) => {
        const imported = importedChatIds(source.id);
        return source.list(ctx.cwd).map((chat) => ({
            ...chat,
            id: several ? `${source.id}:${chat.id}` : chat.id,
            origin: several ? [source.label, chat.origin].filter(Boolean).join(" ") : chat.origin,
            imported: imported.has(chat.id),
        }));
    });
    if (rows.length === 0) {
        const names = sources.map((s) => s.label).join(", ");
        ctx.emit("help", `no ${names} chats in ${ctx.cwd} — ${hint}`);
        return undefined;
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const title = several ? "Chats in this folder" : `${sources[0].label} chats in this folder`;
    const picked = await api.ui.search(chatPickerItems(rows), title);
    return picked?.value;
}

function splitPick(value: string): [string, string] {
    const at = value.indexOf(":");
    return [value.slice(0, at), value.slice(at + 1)];
}

/** Read the chat, price it, and hand it to the host's preview-then-save menu. */
async function previewChat(ctx: CommandContext, source: ChatSource, chatId: string): Promise<void> {
    let chat: ImportedChat | undefined;
    try {
        chat = source.load(chatId, ctx.cwd);
    } catch (err) {
        return ctx.emit("error", `could not read the ${source.label} chat: ${(err as Error).message}`);
    }
    if (!chat) return ctx.emit("error", `no ${source.label} chat with id ${chatId}`);
    if (chat.entries.length === 0)
        return ctx.emit("error", `that ${source.label} chat has no messages loop can import`);
    const cost = await estimateChatCost(chat, source, getSetting("defaultModel") ?? FALLBACK_MODEL);
    const { findChatImport } = await importRecords();
    await ctx.previewImport({
        source: source.label,
        title: chat.title,
        entries: chat.entries,
        origin: { source: source.id, chatId: chat.id },
        cost,
        importedAs: findChatImport(source.id, chat.id),
    });
}
