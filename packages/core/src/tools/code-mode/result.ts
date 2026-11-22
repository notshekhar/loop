/**
 * A finished script, twice over: the text the model reads (the code tool's
 * result), and the run record the transcript keeps so a replay can redraw
 * every call the script made.
 *
 * The record is its own entry because a tool result is saved as what the
 * model read (toModelOutput), and the model must not re-read every call's
 * output on each later turn — that is the context Code Mode exists to save.
 */
import type { CodemodeResult } from "@earendil-works/pi-codemode";
import { truncateHead } from "../utils/truncate";
import { CODE_RUN_KIND, type CodeRunPayload, type NestedCall } from "../../transcript/code-run";

/** The code tool's return value. The model reads `text`. */
export interface CodeToolOutput {
    ok: boolean;
    text: string;
    callCount: number;
}

/**
 * A saved call's output is capped: a script can make hundreds of calls and the
 * transcript is loaded on every resume. The live rows got the whole output; a
 * replayed row of a giant result shows its start.
 */
const MAX_SAVED_OUTPUT_CHARS = 32_000;

export function toCodeToolOutput(result: CodemodeResult, callCount: number): CodeToolOutput {
    return { ok: result.ok, text: modelText(result, callCount), callCount };
}

export function toCodeRunPayload(toolCallId: string, code: string, calls: NestedCall[]): CodeRunPayload {
    return { kind: CODE_RUN_KIND, toolCallId, code, calls: calls.map(capSavedOutput) };
}

function modelText(result: CodemodeResult, callCount: number): string {
    const parts = [header(result, callCount)];
    const printed = result.output
        .map((item) => (item.type === "text" ? item.text : `[image ${item.mimeType} omitted]`))
        .join("\n");
    if (printed) parts.push(printed);
    if (result.ok && result.value !== undefined) parts.push(`Returned:\n${asText(result.value)}`);
    if (!result.ok) parts.push(`Script error: ${result.error.message}`);
    const text = parts.join("\n\n");
    const cut = truncateHead(text);
    if (!cut.truncated) return text;
    // truncateHead keeps whole lines only, so one long line (a big returned
    // JSON value) would come back empty; cut that one by characters instead.
    const kept = cut.firstLineExceedsLimit ? text.slice(0, cut.maxBytes) : cut.content;
    return `${kept}\n\n[output truncated — return less, or filter it inside the script]`;
}

function header(result: CodemodeResult, callCount: number): string {
    const calls = `${callCount} tool call${callCount === 1 ? "" : "s"}`;
    if (result.ok) return `Script completed (${calls}).`;
    return `Script failed (${result.error.kind}) after ${calls}.`;
}

/** A value as the text a model reads: strings as they are, anything else as indented JSON. */
export function asText(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

function capSavedOutput(call: NestedCall): NestedCall {
    if (call.output === undefined) return call;
    const text = typeof call.output === "string" ? call.output : JSON.stringify(call.output);
    if ((text?.length ?? 0) <= MAX_SAVED_OUTPUT_CHARS) return call;
    return { ...call, output: `${text!.slice(0, MAX_SAVED_OUTPUT_CHARS)}\n[… cut when saved]` };
}
