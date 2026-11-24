/**
 * Chat Import — bring a conversation from Claude Code, Codex or Cursor into
 * loop, and keep going from where it stopped.
 *
 * `/claude-import`, `/codex-import`, `/cursor-import` list that agent's chats
 * from the folder loop is open in; with a session id they open that chat from
 * anywhere. Either way the chat is PREVIEWED first — drawn in the transcript
 * the way loop would have drawn it — and only a "Save" in the menu that
 * follows writes it, as a new loop session in this folder. Discarding leaves
 * nothing behind.
 *
 * Reading never writes: transcripts are read as files, and databases are
 * opened read-only (or copied) — see files.ts.
 */
import type { CommandContext } from "../../../commands/registry";
import type { ExtensionAPI } from "../../api";
import { claudeCodeSource } from "./claude-code";
import { codexSource } from "./codex";
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

export default {
    activate(api: ExtensionAPI) {
        for (const command of COMMANDS) {
            const source = () => command.source(defaultRoots());
            api.commands.register({
                name: command.name,
                description: `Import a ${source().label} chat from this folder (preview, then save or discard): /${command.name} [session id]`,
                handler: (ctx, args) => importChat(api, ctx, source(), args.trim(), command.name),
            });
        }
    },
};

async function importChat(
    api: ExtensionAPI,
    ctx: CommandContext,
    source: ChatSource,
    id: string,
    command: string,
): Promise<void> {
    let chat: ImportedChat | undefined;
    try {
        chat = id ? source.load(id, ctx.cwd) : await pickAndLoad(api, ctx, source, command);
    } catch (err) {
        return ctx.emit("error", `could not read the ${source.label} chat: ${(err as Error).message}`);
    }
    if (!chat) {
        if (id) ctx.emit("error", `no ${source.label} chat with id ${id}`);
        return;
    }
    if (chat.entries.length === 0) {
        return ctx.emit("error", `that ${source.label} chat has no messages loop can import`);
    }
    await ctx.previewImport({ source: source.label, title: chat.title, entries: chat.entries });
}

/** The picker of this folder's chats; undefined when there are none or the user backed out. */
async function pickAndLoad(
    api: ExtensionAPI,
    ctx: CommandContext,
    source: ChatSource,
    command: string,
): Promise<ImportedChat | undefined> {
    const chats = source.list(ctx.cwd);
    if (chats.length === 0) {
        ctx.emit("help", `no ${source.label} chats in ${ctx.cwd} — /${command} <session id> imports one from anywhere`);
        return undefined;
    }
    const picked = await api.ui.search(chatPickerItems(chats), `${source.label} chats in this folder`);
    return picked ? source.load(picked.value, ctx.cwd) : undefined;
}
