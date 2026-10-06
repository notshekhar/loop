import { NATIVE_AGENT_PART_KEY, stringify, type NativeAgentProviderId } from "./shared";

/**
 * A native agent's tool calls were executed inside the agent, and their
 * results sit in the same assistant message (provider-executed). Any other
 * model reading that history would see tool calls it never made and has no
 * results for in its own protocol — OpenAI-style APIs reject the request
 * outright ("assistant message with tool_calls must be followed by tool
 * messages"). So for model-bound history those parts become plain text: the
 * record of what the agent did survives, the protocol stays valid.
 *
 * Loop's stored transcript is untouched — this only shapes what is sent.
 */
const LABEL: Record<NativeAgentProviderId, string> = { "claude-code": "Claude Code", "cursor-agent": "Cursor" };
const RESULT_LIMIT = 4_000;

type Part = { type?: string; providerOptions?: Record<string, unknown>; [k: string]: unknown };

function nativeProvider(part: Part): NativeAgentProviderId | undefined {
    const tag = part.providerOptions?.[NATIVE_AGENT_PART_KEY] as { provider?: NativeAgentProviderId } | undefined;
    return tag?.provider;
}

function resultText(output: unknown): string {
    const o = output as { type?: string; value?: unknown } | undefined;
    const value = o && typeof o === "object" && "value" in o ? o.value : output;
    const text = stringify(value);
    return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…` : text;
}

/** True when any part in the message came from a native agent's own tool loop. */
export function hasNativeAgentParts(content: unknown): boolean {
    return Array.isArray(content) && content.some((p) => nativeProvider(p as Part) !== undefined);
}

/** Replace native-agent tool-call/result parts with one text record of each. */
export function flattenNativeAgentParts(content: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const raw of content) {
        const part = raw as Part;
        const provider = nativeProvider(part);
        if (!provider) {
            out.push(raw);
            continue;
        }
        if (part.type === "tool-call") {
            out.push({ type: "text", text: `[${LABEL[provider]} ran ${String(part.toolName)}: ${stringify(part.input)}]` });
        } else if (part.type === "tool-result") {
            out.push({ type: "text", text: `[${String(part.toolName)} result]\n${resultText(part.output)}` });
        }
    }
    return out;
}
