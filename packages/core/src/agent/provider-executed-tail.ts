/**
 * The unfinished step of a turn whose tools the PROVIDER runs — Claude Code
 * and Cursor, where the whole agent loop happens inside one model call.
 *
 * loop persists tool calls only with a finished step, which is right when each
 * tool round is its own step: an interrupted step's calls may have no result
 * yet, and an orphaned tool_use breaks the next request. A native agent has
 * one step for the entire turn, though, so Esc halfway through threw away
 * every tool that had already run and kept only the trailing text.
 *
 * This records that step in stream order, in the same shape a finished
 * native step is persisted (one assistant message: reasoning, text, tool-call,
 * tool-result, …). On interrupt it hands back the calls that completed and
 * drops any still in flight, so nothing orphaned is ever written.
 */

type TailPart =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: unknown;
          providerExecuted: true;
          providerOptions?: unknown;
      }
    | {
          type: "tool-result";
          toolCallId: string;
          toolName: string;
          output: { type: "text" | "json" | "error-text"; value: unknown };
          providerOptions?: unknown;
      };

interface StreamToolPart {
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    providerExecuted?: boolean;
    providerMetadata?: unknown;
}

export class ProviderExecutedTail {
    private parts: TailPart[] = [];
    /** Provider-executed calls seen this step; only their results are kept. */
    private readonly calls = new Set<string>();
    private readonly answered = new Set<string>();

    text(delta: string): void {
        this.append("text", delta);
    }

    reasoning(delta: string): void {
        this.append("reasoning", delta);
    }

    toolCall(part: StreamToolPart): void {
        if (part.providerExecuted !== true || !part.toolCallId) return;
        this.calls.add(part.toolCallId);
        this.parts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName ?? "tool",
            input: part.input ?? {},
            providerExecuted: true,
            ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
        });
    }

    toolResult(part: StreamToolPart): void {
        const output = part.output;
        this.result(part, typeof output === "string" ? { type: "text", value: output } : { type: "json", value: output ?? null });
    }

    toolError(part: StreamToolPart): void {
        const error = part.error;
        this.result(part, { type: "error-text", value: error instanceof Error ? error.message : String(error) });
    }

    /** A step finished: it persisted itself, so the tail starts over. */
    reset(): void {
        this.parts = [];
        this.calls.clear();
        this.answered.clear();
    }

    /**
     * The interrupted step's content, or undefined when no provider-executed
     * tool completed in it — the caller then keeps its text-only behaviour.
     */
    content(): TailPart[] | undefined {
        if (this.answered.size === 0) return undefined;
        return this.parts.filter((part) => {
            if (part.type === "tool-call") return this.answered.has(part.toolCallId);
            if (part.type === "text" || part.type === "reasoning") return part.text.trim() !== "";
            return true;
        });
    }

    private result(part: StreamToolPart, output: Extract<TailPart, { type: "tool-result" }>["output"]): void {
        if (!part.toolCallId || !this.calls.has(part.toolCallId)) return;
        this.answered.add(part.toolCallId);
        this.parts.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName ?? "tool",
            output,
            ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
        });
    }

    private append(type: "text" | "reasoning", delta: string): void {
        const last = this.parts[this.parts.length - 1];
        if (last?.type === type) last.text += delta;
        else this.parts.push({ type, text: delta });
    }
}
