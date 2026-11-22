/**
 * Loop's tools as a script sees them: `tools.<name>(args)`.
 *
 * Each call runs the tool's own `execute` — the hook-wrapped one the turn
 * built — so a call from a script is checked exactly like a direct call:
 * deny rules, permission prompts, plan mode, PreToolUse/PostToolUse hooks and
 * extension middleware all live inside that function. What resolves back into
 * the script is what the model would have read (the tool's `toModelOutput`),
 * not the UI-only extras such as edit's diff.
 */
import { asSchema } from "ai";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import { renderDeclarations } from "@earendil-works/pi-codemode/declarations";
import type { NestedCall } from "../../transcript/code-run";
import { asText } from "./result";

/** The slice of an AI SDK tool a script call needs. */
export interface BridgedTool {
    description?: string;
    inputSchema?: unknown;
    execute?: (input: unknown, options: unknown) => Promise<unknown> | unknown;
    toModelOutput?: (args: { toolCallId: string; input: unknown; output: unknown }) => unknown;
}

/** Told about each call as it starts and ends, so the UI draws it live. */
export interface NestedCallSink {
    started(call: { id: string; toolName: string; input: unknown }): void;
    finished(id: string, output: unknown): void;
    failed(id: string, toolName: string, error: unknown): void;
}

export interface BindOptions {
    parentCallId: string;
    abortSignal?: AbortSignal;
    sink: NestedCallSink;
}

/** One script run's tools plus the record of every call made through them. */
export interface Bridge {
    tools: CodemodeTool[];
    calls: NestedCall[];
}

/** A tool with its schema resolved once, when the turn builds the code tool. */
interface PreparedTool {
    name: string;
    tool: BridgedTool;
    schema: ReturnType<typeof asSchema> | undefined;
    jsonSchema: CodemodeJsonSchema | undefined;
}

/**
 * The turn's tools, ready to hand to scripts: `declarations` is the typed
 * `declare const tools` block for the code tool's description, `bind` makes
 * one run's callable set.
 */
export interface PreparedTools {
    declarations: string;
    bind(opts: BindOptions): Bridge;
}

export async function prepareTools(tools: Record<string, BridgedTool>): Promise<PreparedTools> {
    const prepared = await Promise.all(
        Object.entries(tools)
            .filter(([, t]) => typeof t.execute === "function")
            .map(async ([name, t]): Promise<PreparedTool> => {
                const schema = t.inputSchema === undefined ? undefined : asSchema(t.inputSchema as never);
                const jsonSchema = schema ? ((await schema.jsonSchema) as CodemodeJsonSchema) : undefined;
                return { name, tool: t, schema, jsonSchema };
            }),
    );
    // renderDeclarations reads names, descriptions and schemas only; a run's
    // tools come from bind(), so these never need an execute.
    const declared = prepared.map((p) => declarationOf(p)) as CodemodeTool[];
    return {
        declarations: renderDeclarations({ tools: declared }),
        bind: (opts) => bindRun(prepared, opts),
    };
}

function declarationOf(p: PreparedTool): Omit<CodemodeTool, "execute"> {
    // Every tool resolves to the text the model would have read.
    return {
        name: p.name,
        description: p.tool.description,
        inputSchema: p.jsonSchema,
        outputSchema: { type: "string" },
    };
}

function bindRun(prepared: PreparedTool[], opts: BindOptions): Bridge {
    const calls: NestedCall[] = [];
    let seq = 0;
    const nextId = () => `${opts.parentCallId}.${++seq}`;
    const tools = prepared.map((p) => ({ ...declarationOf(p), execute: callerFor(p, opts, nextId, calls) }));
    return { tools, calls };
}

function callerFor(
    p: PreparedTool,
    opts: BindOptions,
    nextId: () => string,
    calls: NestedCall[],
): CodemodeTool["execute"] {
    return async (args, { signal }) => {
        const input = await validated(p.name, p.schema, args);
        const id = nextId();
        const started = Date.now();
        opts.sink.started({ id, toolName: p.name, input });
        try {
            const output = await p.tool.execute!(input, {
                toolCallId: id,
                messages: [],
                abortSignal: opts.abortSignal ? AbortSignal.any([signal, opts.abortSignal]) : signal,
            });
            calls.push({ id, toolName: p.name, input, output, durationMs: Date.now() - started });
            opts.sink.finished(id, output);
            return modelFacingText(p.tool, id, input, output);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            calls.push({ id, toolName: p.name, input, error: message, durationMs: Date.now() - started });
            opts.sink.failed(id, p.name, err);
            throw new Error(message);
        }
    };
}

/** The AI SDK checks a direct call's input before execute; a script's call gets the same check. */
async function validated(
    name: string,
    schema: ReturnType<typeof asSchema> | undefined,
    args: unknown,
): Promise<unknown> {
    if (!schema?.validate) return args;
    const result = await schema.validate(args);
    if (result.success) return result.value;
    throw new Error(`Invalid input for ${name}: ${result.error.message}`);
}

/** What the model reads from a tool result: its `toModelOutput` text when it has one. */
function modelFacingText(t: BridgedTool, toolCallId: string, input: unknown, output: unknown): string {
    if (t.toModelOutput) {
        const shaped = t.toModelOutput({ toolCallId, input, output }) as { type?: string; value?: unknown };
        if (shaped?.type === "text" && typeof shaped.value === "string") return shaped.value;
        if (shaped?.value !== undefined) return asText(shaped.value);
    }
    return asText(output);
}
