import { AssistantMessageComponent } from "../../ui/messages";
import { type Foldable, NEVER_FOLDS } from "./foldables";

export interface PiAssistantMessage {
    role: "assistant";
    content: Array<
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
        | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    >;
    api: string;
    provider: string;
    model: string;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    };
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
    timestamp: number;
}

function emptyAssistantMessage(provider: string, model: string): PiAssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: "openai",
        provider,
        model,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

/**
 * The assistant message currently streaming in: text and thinking deltas
 * grow its last block until a tool call or the end of the turn closes it.
 *
 * Every append that starts a new block returns that block's entry, for the
 * transcript to make selectable.
 */
export class LiveAssistant {
    private msg: PiAssistantMessage | null = null;
    private comp: AssistantMessageComponent | null = null;

    isOpen(): boolean {
        return this.comp !== null;
    }

    /** Start a new message; the caller places its component in the tree. */
    open(provider: string, model: string, ts?: number): AssistantMessageComponent {
        this.msg = emptyAssistantMessage(provider, model);
        this.comp = new AssistantMessageComponent(this.msg);
        if (ts !== undefined) this.comp.setCreatedAt(ts);
        return this.comp;
    }

    /** Requires an open message. */
    appendText(text: string): Foldable | null {
        const msg = this.msg!;
        const comp = this.comp!;
        let added: Foldable | null = null;
        const last = msg.content[msg.content.length - 1];
        if (last && last.type === "text") {
            last.text += text;
        } else {
            const entry = { type: "text" as const, text };
            msg.content.push(entry);
            // The stream moved past any thinking — close its wall clock.
            comp.noteThinkingEnd();
            added = {
                kind: "response",
                handle: comp.textHandle(msg.content.length - 1),
                getText: () => entry.text,
                comp,
                contentIndex: msg.content.length - 1,
                foldStep: NEVER_FOLDS,
            };
        }
        comp.updateContent(msg);
        return added;
    }

    /** Requires an open message. */
    appendThinking(text: string, durationMs?: number): Foldable | null {
        const msg = this.msg!;
        const comp = this.comp!;
        let added: Foldable | null = null;
        const last = msg.content[msg.content.length - 1];
        if (last && last.type === "thinking") {
            last.thinking += text;
        } else {
            const entry = { type: "thinking" as const, thinking: text };
            msg.content.push(entry);
            const index = msg.content.length - 1;
            // Replay passes the persisted duration; live streaming starts the
            // wall clock instead.
            if (durationMs !== undefined) comp.setThinkingDuration(index, durationMs);
            else comp.noteThinkingStart(index);
            added = {
                kind: "thinking",
                handle: comp.thinkingHandle(index),
                getText: () => entry.thinking,
                comp,
                contentIndex: index,
                // A thought is never folded into a run of tool calls: it is the
                // model's reasoning, not one of its actions, and it always keeps
                // its own row. It ends any run around it (grok folds finished
                // thoughts into runs; loop deliberately does not).
                foldStep: NEVER_FOLDS,
            };
        }
        comp.updateContent(msg);
        return added;
    }

    /** The turn ended (or was cut short): mark the message done. */
    finish(stopReason: PiAssistantMessage["stopReason"]): void {
        this.close((msg) => {
            msg.stopReason = stopReason;
        });
    }

    /** A tool call closes the message: the call box follows it in the turn. */
    closeWithToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
        this.close((msg) => {
            msg.content.push({ type: "toolCall", id: toolCallId, name: toolName, arguments: args });
        });
    }

    /** Drop the message without drawing it again (the transcript is cleared). */
    reset(): void {
        this.msg = null;
        this.comp = null;
    }

    private close(settle: (msg: PiAssistantMessage) => void): void {
        if (this.msg) {
            settle(this.msg);
            this.comp?.markDone();
            this.comp?.updateContent(this.msg);
        }
        this.reset();
    }
}
