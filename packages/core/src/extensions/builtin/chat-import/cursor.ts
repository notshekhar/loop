/**
 * Cursor, as one source: the CLI's chats and the IDE's, side by side in one
 * picker (each row says which), because to the user both are "my Cursor chats
 * in this folder".
 */
import { cursorCliSource } from "./cursor-cli";
import { cursorIdeSource } from "./cursor-ide";
import type { ChatSource, SourceRoots } from "./source";

export function cursorSource(roots: SourceRoots): ChatSource {
    const parts = [cursorCliSource(roots), cursorIdeSource(roots)];
    return {
        id: "cursor",
        label: "Cursor",
        // Cursor records no model: its calls are estimated and priced at loop's current one.
        pricing: { agent: "cursor-agent" },
        list: (cwd) => parts.flatMap((p) => p.list(cwd)).sort((a, b) => b.updatedAt - a.updatedAt),
        load(id, cwd) {
            for (const part of parts) {
                const chat = part.load(id, cwd);
                if (chat) return chat;
            }
            return undefined;
        },
    };
}
