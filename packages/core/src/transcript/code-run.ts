/**
 * A Code Mode run as the transcript saves it: a custom session entry holding
 * the script and every call it made, so a replay can redraw those calls as the
 * rows they were live. Lives in transcript/ (no runtime imports) because the
 * clients that rebuild a chat from saved entries read it too.
 */

export const CODE_RUN_KIND = "code-run";

/** One call a script made. */
export interface NestedCall {
    /** `<code call id>.<n>` — unique in the transcript, so rows never collide. */
    id: string;
    toolName: string;
    input: unknown;
    output?: unknown;
    error?: string;
    durationMs: number;
}

export interface CodeRunPayload {
    kind: typeof CODE_RUN_KIND;
    /** The code tool call this run belongs to. */
    toolCallId: string;
    code: string;
    calls: NestedCall[];
}

export function isCodeRunPayload(payload: unknown): payload is CodeRunPayload {
    const p = payload as CodeRunPayload | null;
    return !!p && typeof p === "object" && p.kind === CODE_RUN_KIND && Array.isArray(p.calls);
}
