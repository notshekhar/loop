/**
 * Building the transcript (types.ts) from a session's saved entries and from
 * its live events — one set of rules for both, so a reply reads the same
 * while it streams and after it is saved.
 *
 * The rules are the terminal's (chat-history.ts): text accumulates into the
 * open text block; a tool call, a thought or anything else closes it and
 * starts the next block below; the turn is everything from a prompt until the
 * next one. Nothing is ever ordered by timestamp.
 *
 * Every function returns a new transcript and leaves the input untouched. A
 * message that did not change is the same object afterwards, so a renderer
 * can memoize per message and redraw only the one that is streaming.
 */
import type {
    CompactionPart,
    PartState,
    ReasoningPart,
    SubagentRun,
    TextPart,
    ToolPart,
    Transcript,
    TranscriptEvent,
    TranscriptMessage,
    TranscriptPart,
    TranscriptTodo,
} from "./types";
import { isToolPart } from "./types";
import { teamPartOf } from "./team";

/** A subagent's log keeps its newest steps; the row says how many it dropped. */
export const MAX_SUBAGENT_STEPS = 60;

export function emptyTranscript(): Transcript {
    return { messages: [], running: false, todos: [] };
}

// ─── editing ──────────────────────────────────────────────────────────────────

/**
 * A copy of `transcript` with its current assistant message replaced by what
 * `edit` makes of a private copy of it. The current message is the assistant
 * reply after the last prompt, created when there is none yet.
 */
function editReply(
    transcript: Transcript,
    at: number,
    edit: (parts: TranscriptPart[], message: TranscriptMessage) => void,
): Transcript {
    const messages = transcript.messages.slice();
    let index = messages.length - 1;
    const last = messages[index];
    if (last === undefined || last.role !== "assistant") {
        // A reply belongs to the prompt before it; without one (a turn begun
        // where this client could not see its prompt) it stands alone.
        const id = last?.role === "user" ? `${last.id}:reply` : `reply-${at}`;
        messages.push({ id, role: "assistant", parts: [], metadata: { createdAt: at } });
        index = messages.length - 1;
    }
    const current = messages[index]!;
    const parts = current.parts.slice();
    const message: TranscriptMessage = { ...current, parts, metadata: { ...current.metadata } };
    edit(parts, message);
    messages[index] = message;
    return { ...transcript, messages };
}

/** Replace `parts[index]` with an edited copy. */
function editPart<P extends TranscriptPart>(parts: TranscriptPart[], index: number, edit: (part: P) => void): void {
    const copy = { ...(parts[index] as P) };
    edit(copy);
    parts[index] = copy;
}

/** Close an open text or reasoning block: something else is starting below it. */
function closeOpenBlock(parts: TranscriptPart[], at: number): void {
    const index = parts.length - 1;
    const last = parts[index];
    if (last?.type === "text" && last.state === "streaming") {
        editPart<TextPart>(parts, index, (part) => {
            part.state = "done";
        });
    } else if (last?.type === "reasoning" && last.state === "streaming") {
        editPart<ReasoningPart>(parts, index, (part) => {
            part.state = "done";
            if (part.durationMs === undefined && part.startedAt !== undefined) {
                part.durationMs = Math.max(0, at - part.startedAt);
            }
        });
    }
}

function appendText(parts: TranscriptPart[], text: string, state: PartState): void {
    if (text === "") return;
    const index = parts.length - 1;
    const last = parts[index];
    // Text runs on into the block above it; only another kind of block ends it.
    if (last?.type === "text") {
        editPart<TextPart>(parts, index, (part) => {
            part.text += text;
            part.state = state;
        });
        return;
    }
    parts.push({ type: "text", text, state });
}

function toolIndex(parts: readonly TranscriptPart[], toolCallId: string): number {
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]!;
        if (isToolPart(part) && part.toolCallId === toolCallId) return i;
    }
    return -1;
}

/** The tool part for `toolCallId`, created (input still to come) if it is new. */
function ensureTool(parts: TranscriptPart[], toolCallId: string, toolName: string, at: number): number {
    const found = toolIndex(parts, toolCallId);
    if (found >= 0) return found;
    closeOpenBlock(parts, at);
    parts.push({ type: `tool-${toolName}`, toolCallId, toolName, state: "input-streaming" });
    return parts.length - 1;
}

/**
 * The failure a tool's RESULT reports, when it reports one: MCP-style tools
 * return `{ content, isError: true }` rather than throwing, and that is still
 * a failed call the row should draw red.
 */
export function resultFailure(output: unknown): string | undefined {
    if (!output || typeof output !== "object" || (output as { isError?: unknown }).isError !== true) return undefined;
    const content = (output as { content?: unknown }).content;
    if (Array.isArray(content)) {
        const text = content
            .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
            .join("")
            .trim();
        if (text) return text;
    }
    return "Failed";
}

function errorText(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/** Everything still open is finished: the turn is over, however it ended. */
function settle(parts: TranscriptPart[], at: number, interrupted: boolean): void {
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if ((part.type === "text" || part.type === "reasoning") && part.state === "streaming") {
            editPart<TextPart | ReasoningPart>(parts, i, (copy) => {
                copy.state = "done";
                if (copy.type === "reasoning" && copy.durationMs === undefined && copy.startedAt !== undefined) {
                    copy.durationMs = Math.max(0, at - copy.startedAt);
                }
            });
        } else if (isToolPart(part) && (part.state === "input-streaming" || part.state === "input-available")) {
            // A call with no result when its turn ends never got one: it was
            // cut off, the way the terminal marks it — not left spinning.
            editPart<ToolPart>(parts, i, (copy) => {
                copy.state = "output-error";
                copy.errorText = INTERRUPTED;
            });
        } else if (part.type === "data-compaction" && part.data.running) {
            editPart<CompactionPart>(parts, i, (copy) => {
                // Still running when its turn ended: it never finished.
                copy.data = { ...copy.data, running: false, aborted: true };
            });
        }
    }
}

/** What a call cut off by the end of its turn says instead of a result. */
export const INTERRUPTED = "Interrupted";

function pushStep(run: SubagentRun, step: SubagentRun["steps"][number]): void {
    run.steps.push(step);
    while (run.steps.length > MAX_SUBAGENT_STEPS) {
        run.steps.shift();
        run.dropped = (run.dropped ?? 0) + 1;
    }
}

function withSubagent(part: ToolPart, agent: string, edit: (run: SubagentRun) => void): void {
    const run: SubagentRun = part.subagent
        ? { ...part.subagent, steps: part.subagent.steps.slice() }
        : { agent, steps: [], finished: false };
    edit(run);
    part.subagent = run;
}

// ─── live ─────────────────────────────────────────────────────────────────────

/**
 * Apply one live event. `at` is when it was observed (epoch ms) — used only
 * for durations, never for order.
 */
/** Events that are a reply being written, as opposed to what trails one. */
const REPLY_CONTENT = new Set([
    "text-delta",
    "reasoning-start",
    "reasoning-delta",
    "tool-input-start",
    "tool-call",
    "hook-message",
    "compact-start",
]);

export function applyEvent(transcript: Transcript, event: TranscriptEvent, at: number = Date.now()): Transcript {
    // A reply arriving with no turn running is a NEW turn whose prompt this
    // stream never carried (a host older than `user-message`). Running it into
    // the last reply would weld two answers into one paragraph.
    if (REPLY_CONTENT.has(event.type) && !transcript.running) {
        const messages = transcript.messages.slice();
        if (messages[messages.length - 1]?.role === "assistant") {
            messages.push({ id: `reply-${at}`, role: "assistant", parts: [], metadata: { createdAt: at } });
        }
        transcript = { ...transcript, messages, running: true };
    }
    const data = event.data as Record<string, unknown> | string | undefined;
    const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    switch (event.type) {
        case "user-message": {
            // The prompt that opens a turn, sent by the host as the turn starts
            // so the live transcript never has to borrow it from history.
            const id = String(record.id ?? `user-${at}`);
            if (transcript.messages.some((message) => message.id === id)) return transcript;
            const createdAt = typeof record.ts === "number" ? record.ts : at;
            const text = String(record.text ?? "");
            // A turn the thread team opened draws as a team card.
            const team = teamPartOf(record.team as Parameters<typeof teamPartOf>[0], text);
            return {
                ...transcript,
                running: true,
                messages: [
                    ...transcript.messages,
                    {
                        id,
                        role: "user",
                        parts: team ? [team] : text ? [{ type: "text", text, state: "done" }] : [],
                        metadata: { createdAt },
                    },
                ],
            };
        }
        case "team-message": {
            // Mail reaching the model between two steps of this reply.
            const team = teamPartOf(record.team as Parameters<typeof teamPartOf>[0], "");
            if (!team) return transcript;
            return editReply(transcript, at, (parts) => {
                closeOpenBlock(parts, at);
                parts.push({ ...team, data: { ...team.data, midTurn: true } });
            });
        }
        case "attached-images": {
            const urls = Array.isArray(data) ? data.filter((url): url is string => typeof url === "string") : [];
            if (urls.length === 0) return transcript;
            const messages = transcript.messages.slice();
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i]!.role !== "user") continue;
                messages[i] = {
                    ...messages[i]!,
                    parts: [...messages[i]!.parts, ...urls.map((url) => ({ type: "file" as const, url, mediaType: "image/*" }))],
                };
                break;
            }
            return { ...transcript, messages };
        }
        case "session-running": {
            const running = record.running === true;
            if (running) return transcript.running ? transcript : { ...transcript, running: true };
            if (!transcript.running && !hasOpenParts(transcript)) return transcript;
            const next = { ...transcript, running: false };
            return lastIsReply(next) ? editReply(next, at, (parts) => settle(parts, at, true)) : next;
        }
        case "text-delta": {
            const text = typeof data === "string" ? data : "";
            if (text === "") return transcript;
            return editReply(transcript, at, (parts) => {
                const last = parts[parts.length - 1];
                if (last?.type === "reasoning" && last.state === "streaming") closeOpenBlock(parts, at);
                appendText(parts, text, "streaming");
            });
        }
        case "reasoning-start":
            return editReply(transcript, at, (parts) => {
                closeOpenBlock(parts, at);
                parts.push({ type: "reasoning", text: "", state: "streaming", startedAt: at });
            });
        case "reasoning-delta": {
            const text = typeof data === "string" ? data : "";
            if (text === "") return transcript;
            return editReply(transcript, at, (parts) => {
                const index = parts.length - 1;
                const last = parts[index];
                if (last?.type === "reasoning" && last.state === "streaming") {
                    editPart<ReasoningPart>(parts, index, (part) => {
                        part.text += text;
                    });
                } else {
                    closeOpenBlock(parts, at);
                    parts.push({ type: "reasoning", text, state: "streaming", startedAt: at });
                }
            });
        }
        case "reasoning-end":
            return editReply(transcript, at, (parts) => {
                const last = parts[parts.length - 1];
                if (last?.type === "reasoning") closeOpenBlock(parts, at);
            });
        case "tool-input-start": {
            const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
            if (!toolCallId) return transcript;
            return editReply(transcript, at, (parts) => {
                ensureTool(parts, toolCallId, String(record.toolName ?? "tool"), at);
            });
        }
        case "tool-input-delta": {
            const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
            const delta = typeof record.delta === "string" ? record.delta : "";
            if (!toolCallId || !delta) return transcript;
            return editReply(transcript, at, (parts) => {
                const index = toolIndex(parts, toolCallId);
                if (index < 0) return;
                editPart<ToolPart>(parts, index, (part) => {
                    part.inputText = (part.inputText ?? "") + delta;
                });
            });
        }
        case "tool-call":
        case "tool-input-updated": {
            const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
            if (!toolCallId) return transcript;
            const rewrite = event.type === "tool-input-updated";
            return editReply(transcript, at, (parts) => {
                const index = ensureTool(parts, toolCallId, String(record.toolName ?? "tool"), at);
                editPart<ToolPart>(parts, index, (part) => {
                    if (rewrite || !part.inputRewritten) part.input = record.input ?? part.input ?? {};
                    if (rewrite) part.inputRewritten = true;
                    // The streamed input stays on screen until the result
                    // replaces it — a long `write` keeps showing its content.
                    if (part.state === "input-streaming") part.state = "input-available";
                });
            });
        }
        case "tool-result":
        case "tool-error": {
            const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
            if (!toolCallId) return transcript;
            const failure = event.type === "tool-result" ? resultFailure(record.output) : undefined;
            return editReply(transcript, at, (parts) => {
                const index = ensureTool(parts, toolCallId, String(record.toolName ?? "tool"), at);
                editPart<ToolPart>(parts, index, (part) => {
                    delete part.inputText;
                    if (event.type === "tool-error") {
                        part.state = "output-error";
                        part.errorText = errorText(record.error);
                    } else if (failure !== undefined) {
                        part.state = "output-error";
                        part.errorText = failure;
                    } else {
                        part.state = "output-available";
                        part.output = record.output;
                    }
                    if (part.subagent && !part.subagent.finished) {
                        const { current: _current, ...rest } = part.subagent;
                        part.subagent = { ...rest, finished: true };
                    }
                });
            });
        }
        case "subagent-delta":
        case "subagent-tool":
        case "subagent-step-usage":
        case "subagent-finish": {
            const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
            if (!toolCallId) return transcript;
            const agent = String(record.agent ?? "agent");
            return editReply(transcript, at, (parts) => {
                const index = ensureTool(parts, toolCallId, "task", at);
                editPart<ToolPart>(parts, index, (part) =>
                    withSubagent(part, agent, (run) => {
                        if (event.type === "subagent-delta") {
                            const text = String(record.text ?? "");
                            const last = run.steps[run.steps.length - 1];
                            if (last?.type === "text") run.steps[run.steps.length - 1] = { ...last, text: last.text + text };
                            else if (text) pushStep(run, { type: "text", text });
                        } else if (event.type === "subagent-tool") {
                            const name = String(record.toolName ?? "tool");
                            pushStep(run, { type: "tool", name, input: record.input });
                            run.current = name;
                        } else if (event.type === "subagent-step-usage") {
                            if (typeof record.steps === "number") run.stepCount = record.steps;
                            if (typeof record.usd === "number") run.usd = record.usd;
                        } else {
                            // The run is done; its call's result follows.
                            run.current = "finishing";
                        }
                    }),
                );
            });
        }
        case "hook-message": {
            const text = typeof data === "string" ? data : "";
            if (!text.trim()) return transcript;
            return editReply(transcript, at, (parts) => {
                closeOpenBlock(parts, at);
                parts.push({ type: "data-hook", data: { text } });
            });
        }
        case "compact-start":
            return editReply(transcript, at, (parts) => {
                closeOpenBlock(parts, at);
                parts.push({
                    type: "data-compaction",
                    data: { running: true, ...(typeof record.reason === "string" ? { reason: record.reason } : {}) },
                });
            });
        case "compact-end":
            return editReply(transcript, at, (parts) => {
                let index = -1;
                for (let i = parts.length - 1; i >= 0; i--) {
                    const part = parts[i]!;
                    if (part.type === "data-compaction" && part.data.running) {
                        index = i;
                        break;
                    }
                }
                if (index < 0) {
                    parts.push({ type: "data-compaction", data: { running: true } });
                    index = parts.length - 1;
                }
                editPart<CompactionPart>(parts, index, (part) => {
                    part.data = {
                        ...part.data,
                        running: false,
                        ...(typeof record.summary === "string" && record.summary ? { summary: record.summary } : {}),
                        ...(typeof record.tokensBefore === "number" ? { tokensBefore: record.tokensBefore } : {}),
                        ...(typeof record.tokensAfter === "number" ? { tokensAfter: record.tokensAfter } : {}),
                        ...(typeof record.handoff === "string" ? { handoff: record.handoff } : {}),
                        ...(typeof record.error === "string" ? { error: record.error } : {}),
                        ...(record.aborted === true ? { aborted: true } : {}),
                    };
                });
            });
        case "stream-retry":
            return editReply(transcript, at, (parts) => {
                closeOpenBlock(parts, at);
                parts.push({
                    type: "data-retry",
                    data: {
                        attempt: Number(record.attempt ?? 0),
                        max: Number(record.max ?? 0),
                        reason: String(record.reason ?? ""),
                    },
                });
            });
        case "data-recap": {
            const text = typeof record.text === "string" ? record.text.trim() : "";
            if (!text) return transcript;
            return editReply(transcript, at, (parts) => {
                closeOpenBlock(parts, at);
                parts.push({ type: "data-recap", data: { text } });
            });
        }
        case "todo-update": {
            const items = Array.isArray(record.items) ? (record.items as TranscriptTodo[]) : [];
            return { ...transcript, todos: items };
        }
        case "error":
            return editReply(transcript, at, (parts) => {
                closeOpenBlock(parts, at);
                parts.push({ type: "data-error", data: { message: errorText(data) } });
            });
        case "finish":
            return editReply(transcript, at, (parts) => settle(parts, at, false));
        default:
            // Usage, terminal sequences, list news: nothing a reply shows.
            return transcript;
    }
}

function lastIsReply(transcript: Transcript): boolean {
    return transcript.messages[transcript.messages.length - 1]?.role === "assistant";
}

function hasOpenParts(transcript: Transcript): boolean {
    const last = transcript.messages[transcript.messages.length - 1];
    if (!last || last.role !== "assistant") return false;
    return last.parts.some(
        (part) =>
            ((part.type === "text" || part.type === "reasoning") && part.state === "streaming") ||
            (isToolPart(part) && (part.state === "input-streaming" || part.state === "input-available")),
    );
}

/** Apply events in order. */
export function applyEvents(transcript: Transcript, events: readonly TranscriptEvent[], at?: number): Transcript {
    let next = transcript;
    for (const event of events) next = applyEvent(next, event, at);
    return next;
}
