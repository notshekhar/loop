import type { ModelMessage } from "ai";
import type { Session } from "../../sessions";
import { toModelMessages } from "../model-messages";
import type { TurnAttachments } from "./opening";

type UserPart = { type: "text"; text: string } | { type: "file"; data: Buffer; mediaType: string };

/**
 * The model-bound message array: the session's transcript plus the two
 * decorations that never belong in it (image parts, hook context).
 *
 * A function rather than a value because a resumed stream has to rebuild it —
 * the completed steps of the failed attempt are in the session by then, and
 * the decorations must land on the same last user message they did the first
 * time, or the prompt-cache prefix moves.
 *
 * `injected` is hook + extension context, computed once up front so a resume
 * reuses it rather than re-running middleware mid-turn.
 */
export function createMessageBuilder(
    session: Session,
    attachments: TurnAttachments,
    injected: string,
): () => ModelMessage[] {
    return () => {
        const messages = toModelMessages(session);
        const last = lastUserIndex(messages);
        if (last < 0) return messages;
        if (attachments.images.length > 0) messages[last] = withImages(attachments);
        if (injected) messages[last] = withHookContext(messages[last], injected);
        return messages;
    };
}

function lastUserIndex(messages: ModelMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
    return -1;
}

/**
 * The last user message as a multipart array so vision models see the image.
 * AI SDK v6+ attachment shape: a `file` part with the bytes as `data` and an
 * IANA `mediaType` (the older `image` part is deprecated).
 */
function withImages({ images, textWithoutPaths }: TurnAttachments): ModelMessage {
    const parts: UserPart[] = [];
    if (textWithoutPaths) parts.push({ type: "text", text: textWithoutPaths });
    for (const img of images) parts.push({ type: "file", data: img.data, mediaType: img.mediaType });
    return { role: "user", content: parts as never };
}

/**
 * Hook-injected context rides only the model-bound copy, never the
 * transcript, and always the LAST user message even when it is already a
 * parts array — an earlier message would rewrite history and bust the
 * prompt-cache prefix.
 */
function withHookContext(message: ModelMessage, injected: string): ModelMessage {
    const block = `<hook-context>\n${injected}\n</hook-context>`;
    if (typeof message.content === "string") return { role: "user", content: `${message.content}\n\n${block}` };
    if (Array.isArray(message.content)) {
        return { role: "user", content: [...message.content, { type: "text", text: block }] as never };
    }
    return message;
}
