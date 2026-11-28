/** The chat picker a bare `/claude-import` (etc.) opens: this folder's chats, newest first. */
import type { UiSelectItem } from "../../api";
import type { ChatSummary } from "./source";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function ago(ms: number, now = Date.now()): string {
    const elapsed = Math.max(0, now - ms);
    if (elapsed < MINUTE) return "just now";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
    if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
    return new Date(ms).toISOString().slice(0, 10);
}

/** A picker row's chat: `imported` when it is already a loop session. */
export type PickerChat = ChatSummary & { imported?: boolean };

/**
 * One row per chat: its title, then when, which variant, whether it is
 * already imported, and enough of the id to tell two apart (after any
 * `source:` prefix the all-agents picker puts on it).
 */
export function chatPickerItems(chats: readonly PickerChat[], now = Date.now()): UiSelectItem[] {
    return chats.map((chat) => ({
        value: chat.id,
        label: chat.title,
        description: [ago(chat.updatedAt, now), chat.origin, chat.imported ? "imported" : "", shortId(chat.id)]
            .filter(Boolean)
            .join(" · "),
    }));
}

function shortId(id: string): string {
    return id.slice(id.indexOf(":") + 1, id.indexOf(":") + 9);
}
