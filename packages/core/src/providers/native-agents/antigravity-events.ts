import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { JsonLinesReader } from "./json-lines-turn";
import { mapAntigravityTool } from "./tool-map";
import { finishReason, linkNativeSession, makeUsage, PartWriter, stringify, type NativeAgentTurnContext, type PromptPlan } from "./shared";

export const ANTIGRAVITY_PROVIDER = "antigravity" as const;

type Rec = Record<string, unknown>;

/** Turns one `agy -p --output-format stream-json` turn into ai-sdk stream parts. */
export class AntigravityTurnReader implements JsonLinesReader {
    finished = false;
    producedOutput = false;
    private sessionId: string | undefined;
    private readonly w: PartWriter;
    private readonly toolNames = new Map<string, string>();

    constructor(
        private readonly enqueue: (part: LanguageModelV4StreamPart) => void,
        private readonly turn: { variant: string; plan: PromptPlan; ctx: NativeAgentTurnContext | undefined },
    ) {
        this.w = new PartWriter(enqueue, ANTIGRAVITY_PROVIDER);
        this.sessionId = turn.plan.resumeId;
    }

    read(ev: Rec): void {
        if (ev.event === "init") this.onInit(String(ev.conversation_id));
        else if (ev.event === "step_update") this.onStep((ev.step_update ?? {}) as Rec);
        else if (ev.event === "result") this.onResult((ev.result ?? {}) as Rec);
    }

    endAll(): void {
        this.w.endAll();
    }

    private onInit(sessionId: string): void {
        this.sessionId = sessionId;
        linkNativeSession(ANTIGRAVITY_PROVIDER, this.turn.ctx, sessionId, this.turn.plan.seen);
        this.enqueue({ type: "response-metadata", id: sessionId, modelId: this.turn.variant });
    }

    private onStep(step: Rec): void {
        const state = String(step.state ?? "");
        if (step.step_type === "agent_response") {
            if (typeof step.thinking_delta === "string") this.w.reasoning(step.thinking_delta);
            if (typeof step.text_delta === "string") {
                this.w.text(step.text_delta);
                this.producedOutput = true;
            }
            if (state === "DONE" || state === "ERROR") this.w.endAll();
        } else if (step.step_type === "tool") {
            this.onToolStep(step, state);
        }
    }

    private onToolStep(step: Rec, state: string): void {
        const id = `agy-${this.sessionId ?? "turn"}-${String(step.step_index ?? "")}`;
        const info = (step.tool_info ?? {}) as Rec;
        const mapped = mapAntigravityTool(String(step.tool_name ?? info.name ?? "tool"), info.parameters);
        if (!this.toolNames.has(id)) {
            this.toolNames.set(id, mapped.name);
            this.w.toolCall(id, mapped.name, mapped.input);
        }
        if (state === "DONE") this.w.toolResult(id, mapped.name, info.output ?? "", false);
        else if (state === "ERROR") {
            const error = info.error as { message?: unknown } | undefined;
            this.w.toolResult(id, mapped.name, String(error?.message ?? "failed"), true);
        }
        this.producedOutput = true;
    }

    private onResult(result: Rec): void {
        this.w.endAll();
        const ok = result.status === "SUCCESS";
        const denied = Array.isArray(result.denied_actions) ? (result.denied_actions as Array<{ display_name?: string }>) : [];
        if (!ok) this.enqueue({ type: "error", error: new Error(`Antigravity: ${stringify(result.error ?? result.status ?? "the turn failed")}`) });
        else if (denied.length && !this.producedOutput) {
            // Plan mode and print mode cannot approve: say what was refused instead of an empty reply.
            this.w.text(`Antigravity was not allowed to run: ${denied.map((d) => d.display_name ?? "a tool").join(", ")}.`);
            this.w.endText();
        }
        const u = (result.usage ?? {}) as Record<string, number>;
        const cacheRead = u.cache_read_tokens ?? 0;
        this.enqueue({
            type: "finish",
            usage: makeUsage({
                input: Math.max(0, (u.input_tokens ?? 0) - cacheRead),
                cacheRead,
                output: u.output_tokens,
                reasoning: u.thinking_tokens,
            }),
            finishReason: finishReason(ok ? "stop" : "error", String(result.status ?? "")),
            providerMetadata: { [ANTIGRAVITY_PROVIDER]: { sessionId: this.sessionId ?? null, model: this.turn.variant } },
        });
        this.finished = true;
    }
}
