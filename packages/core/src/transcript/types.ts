/**
 * loop's transcript: the conversation as every client draws it.
 *
 * The shape is the AI SDK's `UIMessage` — a turn is a user message and one
 * assistant message whose `parts` are in the order they happened (text,
 * reasoning, a tool call with its result, more text…), the same sequence the
 * terminal prints. A client renders it by walking the parts; it never sorts,
 * merges or regroups anything, which is what kept going wrong when the apps
 * rebuilt a turn from separate message/activity lists by timestamp.
 *
 * Kept free of runtime imports so the desktop and phone bundles can use it
 * as-is (packages/core/src/transcript/index.ts).
 */

/** What a part is doing right now; `done` once its turn closes it. */
export type PartState = "streaming" | "done";

export interface TextPart {
    readonly type: "text";
    text: string;
    state: PartState;
}

export interface ReasoningPart {
    readonly type: "reasoning";
    text: string;
    state: PartState;
    /** How long the model thought, when known ("Thought for 3s"). */
    durationMs?: number;
    /** Epoch ms the block began — live only, for a running timer. */
    startedAt?: number;
}

/** A tool call's life, in the AI SDK's own words. */
export type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";

/** One step of a subagent's run, in stream order. */
export type SubagentStep =
    | { readonly type: "text"; text: string }
    | { readonly type: "reasoning"; text: string }
    | { readonly type: "tool"; name: string; input?: unknown };

/** The run a `task` call started, drawn inside its tool part. */
export interface SubagentRun {
    agent: string;
    steps: SubagentStep[];
    /** Completed model steps and their billed USD, when reported. */
    stepCount?: number;
    usd?: number;
    durationMs?: number;
    /** What it is doing right now — the tool it is in, or "finishing". Live only. */
    current?: string;
    /** Steps dropped from the front once the log reached its cap. */
    dropped?: number;
    finished: boolean;
}

export interface ToolPart {
    /** `tool-<name>`, as the AI SDK names typed tool parts. */
    readonly type: `tool-${string}`;
    readonly toolCallId: string;
    readonly toolName: string;
    state: ToolState;
    input?: unknown;
    /** The raw JSON of an input still streaming (a long `write`), live only. */
    inputText?: string;
    /** A hook rewrote the input (`tool-input-updated`): that is what runs, and
     * the model's original `tool-call`, which arrives after it, does not win. */
    inputRewritten?: boolean;
    output?: unknown;
    errorText?: string;
    subagent?: SubagentRun;
}

export interface FilePart {
    readonly type: "file";
    readonly url: string;
    readonly mediaType: string;
}

/** loop's own blocks, as AI SDK `data-*` parts. */
export interface CompactionPart {
    readonly type: "data-compaction";
    data: {
        running: boolean;
        reason?: string;
        summary?: string;
        tokensBefore?: number;
        tokensAfter?: number;
        handoff?: string;
        error?: string;
        aborted?: boolean;
    };
}
export interface RecapPart {
    readonly type: "data-recap";
    data: { text: string };
}
export interface HookPart {
    readonly type: "data-hook";
    data: { text: string };
}
export interface RetryPart {
    readonly type: "data-retry";
    data: { attempt: number; max: number; reason: string };
}
export interface ErrorPart {
    readonly type: "data-error";
    data: { message: string };
}
export interface BranchSummaryPart {
    readonly type: "data-branch-summary";
    data: { summary: string };
}

export type TranscriptPart =
    | TextPart
    | ReasoningPart
    | ToolPart
    | FilePart
    | CompactionPart
    | RecapPart
    | HookPart
    | RetryPart
    | ErrorPart
    | BranchSummaryPart;

export interface TranscriptMessage {
    readonly id: string;
    /** `system` carries markers that stand between turns: where a compaction
     * cut the model's memory, a branch summary. */
    readonly role: "user" | "assistant" | "system";
    parts: TranscriptPart[];
    metadata: {
        /** Epoch ms the message began. */
        createdAt: number;
        /** The user stopped the turn before it finished. */
        interrupted?: boolean;
    };
}

/** A checklist item, as the todo tool keeps it. */
export interface TranscriptTodo {
    readonly content: string;
    readonly status: string;
    readonly activeForm?: string;
}

/** A session's transcript at one point in its event stream. */
export interface Transcript {
    messages: TranscriptMessage[];
    /** A turn is running on the host. */
    running: boolean;
    /** The checklist as it stands — current state, not history. */
    todos: TranscriptTodo[];
}

/** One live event as the host sends it (`session.event`'s `part`). */
export interface TranscriptEvent {
    readonly type: string;
    readonly data?: unknown;
}

export function isToolPart(part: TranscriptPart): part is ToolPart {
    return part.type.startsWith("tool-");
}
