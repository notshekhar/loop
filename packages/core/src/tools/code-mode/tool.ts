/**
 * The `code` tool (Code Mode, the opt-in `codeMode` setting): the model writes
 * one JavaScript snippet that calls loop's other tools — several at once, one
 * result feeding the next, filtering big output before it is read — instead of
 * one tool call per step. Only what the script prints or returns reaches the
 * model; every call it makes is still drawn as an ordinary row.
 */
import { tool } from "ai";
import { z } from "zod";
import { prepareTools, type BridgedTool, type NestedCallSink } from "./bridge";
import type { CodeRunPayload } from "../../transcript/code-run";
import { toCodeRunPayload, toCodeToolOutput, type CodeToolOutput } from "./result";
import { runScript, SCRIPT_TIMEOUT_MS } from "./runtime";

export const CODE_TOOL_NAME = "code";

export interface CodeToolContext {
    /** The tools a script may call — already wrapped in the turn's hooks. */
    tools: Record<string, BridgedTool>;
    /** Told about each call a script makes (its id carries the code call's). */
    sink: NestedCallSink;
    /** Saves a run's calls for replay (a custom session entry). */
    recordRun?: (payload: CodeRunPayload) => Promise<void>;
    abortSignal?: AbortSignal;
}

const INTRO = `Run JavaScript that calls your other tools. This is how you use tools: they are not offered directly. The input is raw JavaScript (no code fence), run as the body of an async function in a sandbox — top-level \`await\` and \`return\` work; there is no Node, file system, network or timers beyond the tools below.

- \`await tools.<name>({ ...args })\` resolves to the text that tool returns and rejects with an Error when it fails.
- Run independent calls together with \`Promise.all\` / \`Promise.allSettled\`; feed one result into the next call; filter large output before returning it.
- \`return <value>\` and \`console.log(...)\` are what you read back — return only what you need.
- Each call is checked like a direct call (permissions, prompts, plan mode, hooks). A script stops after ${SCRIPT_TIMEOUT_MS / 60_000} minutes.`;

export async function createCodeTool(ctx: CodeToolContext) {
    const prepared = await prepareTools(ctx.tools);
    const description = `${INTRO}\n\n\`\`\`ts\n${prepared.declarations}\n\`\`\``;
    return tool({
        description,
        inputSchema: z.object({
            code: z.string().describe("Raw JavaScript: the body of an async function."),
        }),
        toModelOutput: ({ output }) => ({ type: "text", value: (output as CodeToolOutput).text }),
        execute: async ({ code }, options): Promise<CodeToolOutput> => {
            const signal = options?.abortSignal ?? ctx.abortSignal;
            const run = prepared.bind({
                parentCallId: options.toolCallId,
                sink: ctx.sink,
                ...(signal ? { abortSignal: signal } : {}),
            });
            const result = await runScript(code, run.tools, signal);
            // Saved even when the script failed: the calls it made before
            // failing happened, and a replay must show them.
            if (run.calls.length > 0) await ctx.recordRun?.(toCodeRunPayload(options.toolCallId, code, run.calls));
            const output = toCodeToolOutput(result, run.calls.length);
            // A failed script is a failed call: every surface draws it red, and
            // the model still reads the partial output inside the error text.
            if (!output.ok) throw new Error(output.text);
            return output;
        },
    });
}
