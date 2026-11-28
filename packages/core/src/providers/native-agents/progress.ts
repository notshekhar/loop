/**
 * Live progress of work running INSIDE a native agent's turn — a Claude Code
 * subagent (`Task`) working through its own tool calls. The ai-sdk stream has
 * no part for "the provider-executed tool is still busy, here is what it is
 * doing", so the turn hands the provider a sink keyed by the loop session and
 * the provider reports into it. Loop's own subagents report the same two
 * events, so the task box shows a native subagent exactly like one of loop's.
 */
export interface NativeProgressSink {
    /** Prose the subagent wrote. */
    text(toolCallId: string, agent: string, text: string): void;
    /** The subagent started a tool call (already mapped onto loop's tool names). */
    tool(toolCallId: string, agent: string, toolName: string, input: unknown): void;
}

const sinks = new Map<string, NativeProgressSink>();

/** Register the sink for one loop session's running turn; returns its removal. */
export function setNativeProgressSink(loopSessionId: string, sink: NativeProgressSink): () => void {
    sinks.set(loopSessionId, sink);
    return () => {
        if (sinks.get(loopSessionId) === sink) sinks.delete(loopSessionId);
    };
}

export function nativeProgressSink(loopSessionId: string | undefined): NativeProgressSink | undefined {
    return loopSessionId === undefined ? undefined : sinks.get(loopSessionId);
}
