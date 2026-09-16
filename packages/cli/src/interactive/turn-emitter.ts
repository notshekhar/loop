import type { TUI } from "@notshekhar/loop-tui";
import { asTurnEmitter, type TodoItem, type UsageBlock } from "@notshekhar/loop-core";
import type { ChatHistory } from "./components/chat-history";
import type { TodoPanel } from "./components/todo-panel";
import type { AppState } from "./state";
import type { SubagentStream } from "./subagent-stream";
import { formatError } from "./format-error";
import { noteTurnError } from "./sound-reporter";
import { parsePartialEditInput, parsePartialToolInput } from "./ui/streaming-input";
import { isPlanSurface } from "./ui/verb-group";

type TurnEmitter = ReturnType<typeof asTurnEmitter>;

function pickContextUsage(event: { usage?: UsageBlock; lastStepUsage?: UsageBlock }): UsageBlock | undefined {
    return event.lastStepUsage ?? event.usage;
}

export interface TurnEmitterDeps {
    history: ChatHistory;
    tui: TUI;
    state: AppState;
    /** Provider parsed once from the turn's model id (model can't change mid-turn). */
    turnProvider: string;
    subagentStream: SubagentStream;
    todoPanel: TodoPanel;
    showWorking: (message?: string) => void;
    refreshStatusLine: (usage?: UsageBlock) => void;
}

/**
 * Wire every turn event to the chat UI: assistant/reasoning deltas, tool
 * lifecycle, subagent streaming, live cost/context, hooks, compaction, finish.
 * Pulled out of the turn runner so its control flow (guards, queue, drain,
 * runTurn try/finally) reads on its own. Behavior is unchanged from the inline
 * wiring it replaces.
 */
export function wireTurnEmitter(emitter: TurnEmitter, deps: TurnEmitterDeps): void {
    const { history, tui, state, turnProvider, subagentStream, todoPanel, showWorking, refreshStatusLine } = deps;

    emitter.on("text-delta", (t: string) => {
        history.appendAssistantDelta(t, turnProvider, state.modelId);
        tui.requestRender();
    });
    emitter.on("reasoning-delta", (t: string) => {
        history.appendAssistantThinking(t, turnProvider, state.modelId);
        tui.requestRender();
    });
    // Raw JSON input text of still-streaming write/edit calls, keyed by
    // toolCallId — re-parsed so the box shows path + content live. The tool
    // name picks the parser (edit's input is nested). Parsing + re-render are
    // coalesced behind a ~50ms timer (same pattern as subagent-stream):
    // per-token re-rendering starved the TUI of frames — in expanded mode the
    // grey box never painted at all until the input finished streaming.
    const writeInputBuffers = new Map<string, { tool: string; buf: string; dirty: boolean }>();
    let inputFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushInputStreams = () => {
        inputFlushTimer = null;
        for (const [id, entry] of writeInputBuffers) {
            if (!entry.dirty) continue;
            entry.dirty = false;
            const fields = entry.tool === "edit" ? parsePartialEditInput(entry.buf) : parsePartialToolInput(entry.buf);
            history.updateToolInputStream(id, fields);
        }
        tui.requestRender();
    };

    // The call has begun streaming its input: show the pending box immediately so
    // a large-input tool (e.g. write's file content) doesn't pop in only once
    // complete. The full `tool-call` below fills in the args on the same box.
    emitter.on("tool-input-start", (part: { toolName?: string; toolCallId?: string }) => {
        if (!part.toolCallId) return;
        const name = part.toolName;
        if (name !== undefined && (name === "write" || name === "edit" || isPlanSurface(name))) {
            writeInputBuffers.set(part.toolCallId, { tool: name, buf: "", dirty: false });
        }
        history.addToolCall(part.toolName ?? "tool", part.toolCallId, {});
        showWorking(`Running ${part.toolName}…`);
        tui.requestRender();
    });
    // Live write/edit rendering: grow the buffered input; the flush timer
    // re-extracts its string fields so the pending box fills with the content
    // as it streams — at ~20fps, not per token.
    emitter.on("tool-input-delta", (part: { toolCallId?: string; delta: string }) => {
        const entry = writeInputBuffers.get(part.toolCallId ?? "");
        if (entry === undefined || !part.delta) return;
        entry.buf += part.delta;
        entry.dirty = true;
        if (!inputFlushTimer) inputFlushTimer = setTimeout(flushInputStreams, 50);
    });
    emitter.on("tool-call", (part: { toolName?: string; input?: unknown; toolCallId?: string }) => {
        const id = part.toolCallId ?? `${part.toolName}-${Date.now()}`;
        writeInputBuffers.delete(id);
        history.addToolCall(part.toolName ?? "tool", id, (part.input ?? {}) as Record<string, unknown>);
        showWorking(`Running ${part.toolName}…`);
        tui.requestRender();
    });
    emitter.on("tool-result", (part: { output?: unknown; toolCallId?: string }) => {
        const id = part.toolCallId ?? "";
        subagentStream.clear(id);
        // Task tools output { history, report } — stringifyResult shows the full
        // uncapped history (the live buffer is tail-capped). Normal tools show
        // their output as-is.
        history.addToolResult(id, part.output);
        showWorking("Generating");
        tui.requestRender();
    });
    // Tool failed: resolve its box in red with the error text (instead of
    // leaving it spinning), then keep working — the model already received
    // the error and may try something else.
    emitter.on("tool-error", (e: { toolCallId?: string; error: unknown }) => {
        const id = e.toolCallId ?? "";
        writeInputBuffers.delete(id);
        subagentStream.clear(id);
        history.addToolResult(id, formatError(e.error), true);
        showWorking("Generating");
        tui.requestRender();
    });
    emitter.on("subagent-tool", (e: { toolCallId: string; agent: string; toolName?: string; input?: unknown }) => {
        subagentStream.onTool(e.toolCallId, e.toolName, e.input);
        showWorking(`Subagent ${e.agent} · ${e.toolName}…`);
    });
    emitter.on("subagent-delta", (e: { toolCallId: string; agent: string; text: string }) => {
        subagentStream.onDelta(e.toolCallId, e.text);
    });
    emitter.on("subagent-finish", (_e: { toolCallId: string }) => {
        // Buffer intentionally kept — tool-result composes it into the final
        // display, then clears it.
        refreshStatusLine();
        showWorking("Generating");
        tui.requestRender();
    });
    // Live cost: status line updates after every step (main and subagent), not just
    // at turn end. Step usage also carries the current context size.
    emitter.on("step-usage", (e: { usage?: UsageBlock }) => {
        refreshStatusLine(e.usage);
    });
    emitter.on("subagent-step-usage", (e: { toolCallId: string; steps?: number; usd?: number }) => {
        // Cost only — a subagent's context is not the main context. The
        // step/cost ticker lands in the task box title.
        subagentStream.onStepUsage(e.toolCallId, e.steps, e.usd);
        refreshStatusLine();
    });
    emitter.on("hook-message", (m: string) => {
        history.addHook(m);
        tui.requestRender();
    });
    // The provider dropped the stream between steps and the turn is reopening
    // it. Said out loud because a recovered turn emits no error at all — the
    // alternative is the agent appearing to stall for the backoff.
    emitter.on("stream-retry", (e: { attempt: number; max: number; reason: string }) => {
        history.addSystem(`stream failed (${e.reason}) — retrying ${e.attempt}/${e.max}`);
        showWorking("Retrying");
        tui.requestRender();
    });
    // OSC sequences from hooks (Warp-style notifications): invisible control
    // sequences, safe to write directly without tearing the renderer.
    emitter.on("hook-terminal-sequence", (s: string) => {
        process.stdout.write(s);
    });
    emitter.on("compact-start", () => {
        showWorking("Compacting");
        tui.requestRender();
    });
    emitter.on(
        "compact-end",
        (r: { summary: string; tokensBefore: number; tokensAfter?: number; aborted?: boolean }) => {
            if (r.aborted) history.addSystem("compact aborted");
            else if (r.summary) history.addCompactionSummary(r.summary, r.tokensBefore);
            if (typeof r.tokensAfter === "number") state.latestContextTokens = r.tokensAfter;
            refreshStatusLine();
            tui.requestRender();
        },
    );
    // Pinned checklist mirrors every todo-tool write live.
    emitter.on("todo-update", (e: { items: TodoItem[] }) => {
        todoPanel.setItems(e.items);
        tui.requestRender();
    });
    // Panel retire happens in the turn-runner's finally, not only here: finish
    // now also fires on interrupt (for RPC/web clients), and fires once per
    // stop-hook continuation. finishAssistant is idempotent either way.
    emitter.on("finish", (event: { usage?: UsageBlock; lastStepUsage?: UsageBlock }) => {
        history.finishAssistant();
        refreshStatusLine(pickContextUsage(event));
        tui.requestRender();
    });
    emitter.on("error", (err: unknown) => {
        history.addError(formatError(err));
        // The turn may still reach `Stop` after a stream error, so the outcome
        // is remembered rather than chimed here — see sound-reporter.ts.
        noteTurnError();
        tui.requestRender();
    });
    // Recap generation is detached from the turn — this may fire after busy is
    // already false, and renders wherever the chat currently ends.
    emitter.on("data-recap", (e: { text: string }) => {
        history.addRecap(e.text);
        refreshStatusLine();
        tui.requestRender();
    });
}
