/**
 * Detached goal-mode roles — the planner and the adversarial verifier.
 *
 * Each role is a silent side-channel agent loop (same ToolLoopAgent core the
 * task tool uses) with a hard read-only toolset: read/grep/find/ls plus bash
 * in the fail-closed read-only sandbox. No emitter streaming — the host shows
 * a working indicator; the caller consumes only the final text (the planner's
 * plan document, the verifier's JSON verdict). Usage bills into the session's
 * CostTracker under the role's ledger source.
 */
import { isStepCount, ToolLoopAgent } from "ai";
import { getModel, parseModelId } from "../providers";
import { getCatalog, modelInfoIn } from "../catalog";
import { anthropicCachedSystem } from "./model-messages";
import { buildAgentCallConfig } from "./model-call";
import { getSetting } from "../settings";
import { createTools } from "../tools";
import type { UsageBlock } from "../types";
import type { CostTracker } from "./cost";

/** Step caps: the planner reads a little and writes prose; the verifier digs. */
const ROLE_MAX_STEPS: Record<GoalRoleName, number> = { "goal-planner": 15, "goal-verifier": 30 };

export type GoalRoleName = "goal-planner" | "goal-verifier";

export interface GoalRoleOptions {
    role: GoalRoleName;
    system: string;
    prompt: string;
    modelId: string;
    cwd: string;
    sessionId: string;
    tracker?: CostTracker;
    abortSignal?: AbortSignal;
}

export interface GoalRoleResult {
    text: string;
    steps: number;
}

/** Run one goal role to completion and return its final text. Throws on
 * provider errors and aborts — the caller owns fail-open/closed semantics. */
export async function runGoalRole(opts: GoalRoleOptions): Promise<GoalRoleResult> {
    const catalog = await getCatalog();
    const { provider, model } = parseModelId(opts.modelId);
    // Read-only inventory: the same fail-closed guarantee read-only agents
    // get — bash runs sandboxed, and write/edit/sql are simply absent.
    const all = createTools({
        cwd: opts.cwd,
        abortSignal: opts.abortSignal,
        readOnlyFs: true,
        sessionId: opts.sessionId,
    });
    const tools = {
        read: all.read,
        grep: all.grep,
        find: all.find,
        ls: all.ls,
        bash: all.bash,
    } as unknown as ReturnType<typeof createTools>;
    const call = buildAgentCallConfig({
        provider,
        modelShortId: model,
        thinkingLevel: getSetting("thinkingLevel") ?? "off",
        modelInfo: modelInfoIn(catalog, opts.modelId),
    });
    const agent = new ToolLoopAgent({
        model: await getModel(opts.modelId),
        instructions: call.anthropicCaching ? anthropicCachedSystem(opts.system) : opts.system,
        tools,
        stopWhen: isStepCount(ROLE_MAX_STEPS[opts.role]),
        ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
        ...(call.reasoning ? { reasoning: call.reasoning } : {}),
        ...(call.providerOptions ? { providerOptions: call.providerOptions as never } : {}),
        ...(call.prepareStep ? { prepareStep: call.prepareStep } : {}),
    });
    const result = await agent.stream({ prompt: opts.prompt, abortSignal: opts.abortSignal });
    // Only the LAST step's text is the role's final response — earlier text
    // interleaves with tool calls and is working narration.
    let stepText = "";
    let lastText = "";
    let steps = 0;
    for await (const part of result.stream) {
        if (opts.abortSignal?.aborted) throw new Error("goal role aborted");
        switch (part.type) {
            case "text-delta":
                stepText += part.text;
                break;
            case "finish-step": {
                steps++;
                const u = (part as { usage?: UsageBlock }).usage;
                if (u && opts.tracker) {
                    opts.tracker.add(opts.modelId, u, {
                        cwd: opts.cwd,
                        sessionPub: opts.sessionId,
                        source: opts.role,
                    });
                }
                if (stepText.trim()) lastText = stepText;
                stepText = "";
                break;
            }
        }
    }
    if (stepText.trim()) lastText = stepText;
    return { text: lastText.trim(), steps };
}
