/**
 * A session's saved branch as a transcript (types.ts) — the same rules the
 * terminal replays it with (cli/src/interactive/replay.ts), and the same
 * blocks reduce.ts builds while the turn streams.
 *
 * Kept free of runtime imports, like the rest of transcript/, so a client can
 * run it too; the entry shapes are read structurally.
 */
import type {
    SubagentRun,
    SubagentStep,
    TextPart,
    ToolPart,
    Transcript,
    TranscriptMessage,
    TranscriptPart,
    TranscriptTodo,
} from "./types";
import { isToolPart } from "./types";

/** The parts of a saved entry this reads (packages/core/src/types.ts Entry). */
interface EntryLike {
    readonly id?: string;
    readonly type: string;
    readonly ts?: number;
    readonly role?: string;
    readonly content?: unknown;
    readonly interrupted?: boolean;
    readonly reasoningMs?: readonly number[];
    // compact
    readonly summary?: string;
    readonly cutAt?: number;
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly handoff?: string;
    // subagent
    readonly agent?: string;
    readonly toolCallId?: string;
    readonly activity?: readonly { type: string; text?: string; name?: string; summary?: string }[];
    readonly steps?: number;
    readonly durationMs?: number;
    readonly usage?: { usd?: number };
    // custom
    readonly payload?: unknown;
}

interface ContentPart {
    readonly type?: string;
    readonly text?: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly image?: unknown;
    readonly mediaType?: string;
}

/** A saved tool result's output, as the live `tool-result` carries it. */
function unwrapOutput(output: unknown): { value: unknown; error?: string } {
    if (output && typeof output === "object" && "type" in output) {
        const typed = output as { type: string; value?: unknown };
        if (typed.type === "error-text" || typed.type === "error-json") {
            return { value: typed.value, error: typeof typed.value === "string" ? typed.value : JSON.stringify(typed.value) };
        }
        if (typed.type === "text" || typed.type === "json" || typed.type === "content") return { value: typed.value };
    }
    return { value: output };
}

function userParts(content: unknown): TranscriptPart[] {
    if (typeof content === "string") return content ? [{ type: "text", text: content, state: "done" }] : [];
    if (!Array.isArray(content)) return [];
    const parts: TranscriptPart[] = [];
    for (const part of content as ContentPart[]) {
        if (part.type === "text" && part.text) {
            const last = parts[parts.length - 1];
            if (last?.type === "text") parts[parts.length - 1] = { ...last, text: last.text + part.text };
            else parts.push({ type: "text", text: part.text, state: "done" });
        } else if ((part.type === "image" || part.type === "file") && typeof part.image === "string") {
            parts.push({ type: "file", url: part.image, mediaType: part.mediaType ?? "image/*" });
        }
    }
    return parts;
}

function subagentRun(entry: EntryLike): SubagentRun {
    const steps: SubagentStep[] = [];
    for (const step of entry.activity ?? []) {
        if (step.type === "text" && step.text) steps.push({ type: "text", text: step.text });
        else if (step.type === "reasoning" && step.text) steps.push({ type: "reasoning", text: step.text });
        else if (step.type === "tool") steps.push({ type: "tool", name: step.name ?? "tool", input: step.summary });
    }
    return {
        agent: entry.agent ?? "agent",
        steps,
        ...(entry.steps !== undefined ? { stepCount: entry.steps } : {}),
        ...(entry.usage?.usd !== undefined ? { usd: entry.usage.usd } : {}),
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
        finished: true,
    };
}

function isRecap(payload: unknown): payload is { kind: "recap"; text: string } {
    const p = payload as { kind?: unknown; text?: unknown } | null;
    return !!p && typeof p === "object" && p.kind === "recap" && typeof p.text === "string";
}

/**
 * The branch (root → leaf, as `session.history` returns it) as a transcript.
 * `running` is the host's own word on whether a turn is still going.
 */
export function fromEntries(
    entries: readonly EntryLike[],
    opts: { running?: boolean; todos?: readonly TranscriptTodo[] } = {},
): Transcript {
    const messages: TranscriptMessage[] = [];
    let reply: TranscriptMessage | null = null;

    let latestCompact: EntryLike | undefined;
    for (const entry of entries) if (entry.type === "compact") latestCompact = entry;
    const cutAt = latestCompact?.cutAt ?? 0;
    let boundaryDrawn = cutAt === 0;
    let messageIndex = 0;

    // Subagent runs are saved when they finish — before the step's assistant
    // message that holds their `task` call. Held until that message is in.
    const pendingRuns: EntryLike[] = [];
    const attachRuns = () => {
        if (pendingRuns.length === 0) return;
        const target = currentReply(reply?.metadata.createdAt ?? 0);
        for (const run of pendingRuns) {
            const index = run.toolCallId ? findTool(target.parts, run.toolCallId) : -1;
            if (index >= 0) {
                target.parts[index] = { ...(target.parts[index] as ToolPart), subagent: subagentRun(run) };
            } else {
                // An older session that never linked the run to its call.
                target.parts.push({
                    type: "tool-task",
                    toolCallId: run.toolCallId ?? `task-${run.ts ?? 0}`,
                    toolName: "task",
                    state: "output-available",
                    input: { agent: run.agent },
                    output: run.summary,
                    subagent: subagentRun(run),
                });
            }
        }
        pendingRuns.length = 0;
    };

    const currentReply = (at: number): TranscriptMessage => {
        if (reply) return reply;
        const last = messages[messages.length - 1];
        const id = last?.role === "user" ? `${last.id}:reply` : `reply-${at}`;
        reply = { id, role: "assistant", parts: [], metadata: { createdAt: at } };
        messages.push(reply);
        return reply;
    };

    const drawBoundary = () => {
        if (boundaryDrawn) return;
        boundaryDrawn = true;
        attachRuns();
        if (!latestCompact) return;
        reply = null;
        messages.push({
            id: `${latestCompact.id ?? "compact"}:boundary`,
            role: "system",
            parts: [
                {
                    type: "data-compaction",
                    data: {
                        running: false,
                        ...(latestCompact.summary ? { summary: latestCompact.summary } : {}),
                        ...(latestCompact.tokensBefore !== undefined ? { tokensBefore: latestCompact.tokensBefore } : {}),
                        ...(latestCompact.tokensAfter !== undefined ? { tokensAfter: latestCompact.tokensAfter } : {}),
                        ...(latestCompact.handoff ? { handoff: latestCompact.handoff } : {}),
                    },
                },
            ],
            metadata: { createdAt: latestCompact.ts ?? 0 },
        });
    };

    for (const [position, entry] of entries.entries()) {
        const at = entry.ts ?? 0;
        if (entry.type === "message") {
            if (messageIndex++ >= cutAt) drawBoundary();
            if (entry.role === "user") {
                attachRuns();
                reply = null;
                messages.push({
                    id: entry.id ?? `entry-${position}`,
                    role: "user",
                    parts: userParts(entry.content),
                    metadata: { createdAt: at },
                });
            } else if (entry.role === "assistant") {
                const target = currentReply(at);
                if (entry.interrupted) target.metadata = { ...target.metadata, interrupted: true };
                const durations = [...(entry.reasoningMs ?? [])];
                const parts = Array.isArray(entry.content)
                    ? (entry.content as ContentPart[])
                    : [{ type: "text", text: String(entry.content ?? "") }];
                for (const part of parts) {
                    if (part.type === "text" && part.text) {
                        const last = target.parts[target.parts.length - 1];
                        if (last?.type === "text") {
                            target.parts[target.parts.length - 1] = { ...last, text: last.text + part.text } as TextPart;
                        } else {
                            target.parts.push({ type: "text", text: part.text, state: "done" });
                        }
                    } else if (part.type === "reasoning" && part.text) {
                        const durationMs = durations.shift();
                        target.parts.push({
                            type: "reasoning",
                            text: part.text,
                            state: "done",
                            ...(durationMs !== undefined ? { durationMs } : {}),
                        });
                    } else if (part.type === "tool-call" && part.toolCallId) {
                        if (findTool(target.parts, part.toolCallId) >= 0) continue;
                        const toolName = part.toolName ?? "tool";
                        target.parts.push({
                            type: `tool-${toolName}`,
                            toolCallId: part.toolCallId,
                            toolName,
                            state: "input-available",
                            input: part.input ?? {},
                        });
                    }
                }
                attachRuns();
            } else if (entry.role === "tool" && Array.isArray(entry.content)) {
                const target = currentReply(at);
                for (const part of entry.content as ContentPart[]) {
                    if (part.type !== "tool-result" || !part.toolCallId) continue;
                    const index = findTool(target.parts, part.toolCallId);
                    if (index < 0) continue;
                    const { value, error } = unwrapOutput(part.output);
                    const tool = { ...(target.parts[index] as ToolPart) };
                    if (error !== undefined) {
                        tool.state = "output-error";
                        tool.errorText = error;
                    } else {
                        tool.state = "output-available";
                        tool.output = value;
                    }
                    target.parts[index] = tool;
                }
            }
        } else if (entry.type === "subagent") {
            pendingRuns.push(entry);
        } else if (entry.type === "branch-summary" && entry.summary) {
            attachRuns();
            reply = null;
            messages.push({
                id: entry.id ?? `entry-${position}`,
                role: "system",
                parts: [{ type: "data-branch-summary", data: { summary: entry.summary } }],
                metadata: { createdAt: at },
            });
        } else if (entry.type === "custom" && isRecap(entry.payload)) {
            const text = entry.payload.text.trim();
            if (text) currentReply(at).parts.push({ type: "data-recap", data: { text } });
        }
    }
    drawBoundary();
    attachRuns();

    // Whatever was cut off with no result when its turn ended stays marked as
    // such, as live settling would have marked it — unless the turn is still
    // running, in which case those calls are simply still going.
    if (!opts.running) {
        for (const message of messages) {
            if (message.role !== "assistant") continue;
            for (let i = 0; i < message.parts.length; i++) {
                const part = message.parts[i]!;
                if (isToolPart(part) && (part.state === "input-streaming" || part.state === "input-available")) {
                    message.parts[i] = {
                        ...part,
                        state: "output-error",
                        errorText: message.metadata.interrupted ? "Interrupted" : "No result",
                    };
                }
            }
        }
    }

    return { messages, running: opts.running === true, todos: [...(opts.todos ?? [])] };
}

function findTool(parts: readonly TranscriptPart[], toolCallId: string): number {
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]!;
        if (isToolPart(part) && part.toolCallId === toolCallId) return i;
    }
    return -1;
}
