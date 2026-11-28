import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NativeProgressSink } from "./progress";
import { mapClaudeTool } from "./tool-map";
import { finishReason, linkNativeSession, makeUsage, PartWriter, stringify, type NativeAgentTurnContext, type PromptPlan } from "./shared";

export const CLAUDE_CODE_PROVIDER = "claude-code" as const;

/**
 * How Claude Code was signed in, per its init message. A subscription login
 * ("oauth", or "none" for Bedrock/Vertex where the cloud bills) reports
 * `total_cost_usd` as what the turn WOULD cost at API prices — not money
 * spent — so only a key-based login has its cost passed on as billed.
 */
const UNBILLED_KEY_SOURCES = new Set(["oauth", "none"]);

const MISSING_SESSION = /no conversation found|session.*not found/i;

type Message = SDKMessage & { parent_tool_use_id?: string | null };
type Block = { type: string; [k: string]: unknown };

/**
 * Turns one Claude Code turn's SDK messages into ai-sdk stream parts.
 * `read` returns "missing-session" when the resumed native session is gone
 * and nothing was shown yet — the caller then reruns the turn fresh.
 */
export class ClaudeTurnReader {
    sessionId: string | undefined;
    producedOutput = false;
    finished = false;
    private billed = false;
    private lastCallUsage: Record<string, number> | undefined;
    private readonly w: PartWriter;
    private readonly toolNames = new Map<string, string>();
    /** Task tool-call id → its subagent's name, for the progress box. */
    private readonly subagents = new Map<string, string>();
    private readonly streamedMessages = new Set<string>();
    private readonly blocks = new Map<number, { kind: "text" | "thinking" | "tool"; toolId?: string }>();

    constructor(
        private readonly enqueue: (part: LanguageModelV4StreamPart) => void,
        private readonly turn: {
            modelId: string;
            plan: PromptPlan;
            ctx: NativeAgentTurnContext | undefined;
            progress: NativeProgressSink | undefined;
        },
    ) {
        this.w = new PartWriter(enqueue, CLAUDE_CODE_PROVIDER);
        this.sessionId = turn.plan.resumeId;
    }

    read(m: Message): "missing-session" | undefined {
        if (m.parent_tool_use_id) {
            this.onSubagentMessage(m.parent_tool_use_id, m);
            return undefined;
        }
        switch (m.type) {
            case "system":
                if (m.subtype === "init") this.onInit(m);
                return undefined;
            case "stream_event":
                this.onStreamEvent(m.event as never);
                return undefined;
            case "assistant":
                this.onAssistant(m);
                return undefined;
            case "user":
                this.onUser(m.message.content);
                return undefined;
            case "result":
                return this.onResult(m);
            default:
                return undefined;
        }
    }

    /** A thrown error during the turn: is it the "session gone" case? */
    isMissingSession(text: string): boolean {
        return !this.producedOutput && this.turn.plan.resumeId !== undefined && MISSING_SESSION.test(text);
    }

    /** The turn ended without a result (abort, crash): close what is open. */
    endUnfinished(): void {
        this.w.endAll();
        if (!this.finished) this.enqueue({ type: "finish", usage: makeUsage({}), finishReason: finishReason("other", "aborted") });
    }

    private onInit(m: Extract<SDKMessage, { type: "system"; subtype: "init" }>): void {
        this.sessionId = m.session_id;
        this.billed = !UNBILLED_KEY_SOURCES.has(m.apiKeySource);
        linkNativeSession(CLAUDE_CODE_PROVIDER, this.turn.ctx, m.session_id, this.turn.plan.seen);
        this.enqueue({ type: "response-metadata", id: m.session_id, modelId: m.model });
    }

    private onStreamEvent(ev: {
        type: string;
        index: number;
        message: { id: string };
        content_block: Block & { id: string; name: string };
        delta: { type: string; text?: string; thinking?: string };
    }): void {
        if (ev.type === "message_start") {
            this.streamedMessages.add(ev.message.id);
            this.blocks.clear();
        } else if (ev.type === "content_block_start") {
            const b = ev.content_block;
            if (b.type === "text") this.blocks.set(ev.index, { kind: "text" });
            else if (b.type === "thinking") this.blocks.set(ev.index, { kind: "thinking" });
            else if (isToolUse(b)) {
                const name = mapClaudeTool(b.name, {}).name;
                this.toolNames.set(b.id, name);
                this.blocks.set(ev.index, { kind: "tool", toolId: b.id });
                // Only the start is surfaced early: the streamed input is in
                // Claude's schema, the final tool-call carries it reshaped to loop's.
                this.w.toolInputStart(b.id, name);
            }
        } else if (ev.type === "content_block_delta") {
            this.producedOutput = true;
            if (ev.delta.type === "text_delta") this.w.text(ev.delta.text ?? "");
            else if (ev.delta.type === "thinking_delta") this.w.reasoning(ev.delta.thinking ?? "");
        } else if (ev.type === "content_block_stop") {
            const b = this.blocks.get(ev.index);
            if (b?.kind === "text") this.w.endText();
            else if (b?.kind === "thinking") this.w.endReasoning();
            else if (b?.kind === "tool" && b.toolId) this.enqueue({ type: "tool-input-end", id: b.toolId });
        }
    }

    private onAssistant(m: Extract<SDKMessage, { type: "assistant" }>): void {
        const message = m.message;
        if (message.usage) this.lastCallUsage = message.usage as unknown as Record<string, number>;
        if (m.error) throw new Error(`Claude Code: ${m.error}`);
        const streamed = this.streamedMessages.has(message.id);
        for (const block of message.content as unknown as Block[]) {
            if (block.type === "text" && !streamed) this.w.text(String(block.text));
            else if (block.type === "thinking" && !streamed) this.w.reasoning(String(block.thinking));
            else if (isToolUse(block)) {
                const mapped = mapClaudeTool(block.name, block.input);
                this.toolNames.set(block.id, mapped.name);
                if (mapped.name === "task") this.subagents.set(block.id, subagentName(block.input));
                this.w.toolCall(block.id, mapped.name, mapped.input);
            }
        }
        if (!streamed) this.w.endAll();
        this.producedOutput = true;
    }

    private onUser(content: unknown): void {
        if (!Array.isArray(content)) return;
        for (const block of content as Block[]) {
            if (typeof block !== "object" || block.type !== "tool_result") continue;
            const id = String(block.tool_use_id);
            this.w.toolResult(id, this.toolNames.get(id) ?? "tool", toolResultText(block.content), block.is_error === true);
        }
    }

    /**
     * A subagent's own messages. Its prose and tool calls go to the task box
     * live; its results don't — the parent's Task result tells the outcome.
     */
    private onSubagentMessage(parentId: string, m: Message): void {
        const sink = this.turn.progress;
        if (!sink || m.type !== "assistant") return;
        const agent = this.subagents.get(parentId) ?? "agent";
        for (const block of m.message.content as unknown as Block[]) {
            if (block.type === "text" && String(block.text).trim()) sink.text(parentId, agent, `${String(block.text)}\n`);
            else if (isToolUse(block)) {
                const mapped = mapClaudeTool(block.name, block.input);
                sink.tool(parentId, agent, mapped.name, mapped.input);
            }
        }
    }

    private onResult(m: Extract<SDKMessage, { type: "result" }>): "missing-session" | undefined {
        this.w.endAll();
        if (m.subtype !== "success" || m.is_error) {
            const detail = "errors" in m && m.errors.length ? m.errors.join("\n") : "result" in m ? String(m.result) : m.subtype;
            if (this.isMissingSession(detail)) return "missing-session";
            this.enqueue({ type: "error", error: new Error(`Claude Code: ${detail}`) });
        }
        const u = this.lastCallUsage ?? {};
        this.enqueue({
            type: "finish",
            usage: makeUsage({
                // Context occupancy = the last API call's input, not the turn's sum.
                input: u.input_tokens,
                cacheRead: u.cache_read_input_tokens,
                cacheWrite: u.cache_creation_input_tokens,
                output: m.usage.output_tokens,
            }),
            finishReason: finishReason(m.is_error ? "error" : "stop", m.stop_reason ?? m.subtype),
            providerMetadata: {
                [CLAUDE_CODE_PROVIDER]: {
                    sessionId: this.sessionId ?? null,
                    numTurns: m.num_turns,
                    // Read by loop's cost tracking — see UNBILLED_KEY_SOURCES.
                    ...(this.billed ? { billedUsd: m.total_cost_usd } : {}),
                },
            },
        });
        this.finished = true;
        return undefined;
    }
}

function isToolUse(b: Block): b is Block & { id: string; name: string; input: unknown } {
    return b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use";
}

function subagentName(input: unknown): string {
    const i = (input ?? {}) as { subagent_type?: unknown; description?: unknown };
    return typeof i.subagent_type === "string" && i.subagent_type ? i.subagent_type : "agent";
}

function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : `[${(c as { type?: string }).type ?? "content"}]`))
            .join("\n");
    }
    return stringify(content);
}
