/**
 * A `/btw` question's tag as the transcript carries it. Shared by history.ts
 * (saved entries) and reduce.ts (the live stream), and runtime-import-free
 * like the rest of transcript/.
 */
import type { TranscriptBtw } from "./types";

/** The `btw` field of a saved entry or a `user-message` event — undefined when unusable. */
export function btwOf(meta: unknown): TranscriptBtw | undefined {
    if (typeof meta !== "object" || meta === null) return undefined;
    const { parentId, parentTitle } = meta as Record<string, unknown>;
    if (typeof parentId !== "string" || typeof parentTitle !== "string") return undefined;
    return { parentId, parentTitle };
}
