import type { TeamTurnMeta } from "../teams/runtime";
import type { Entry, ProviderId, StepTiming, SubagentActivityPart, ToolTiming, UsageBlock } from "../types";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Step timing is display metadata: a malformed one is dropped, never
 * repaired (the trace shows "not recorded" rather than a fabricated bar). */
function parseStepTiming(raw: unknown): StepTiming | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const t = raw as Record<string, unknown>;
    if (!isNum(t.startedAt) || !isNum(t.modelEndedAt) || !isNum(t.endedAt)) return undefined;
    const out: StepTiming = { startedAt: t.startedAt, modelEndedAt: t.modelEndedAt, endedAt: t.endedAt };
    if (isNum(t.firstTokenAt)) out.firstTokenAt = t.firstTokenAt;
    if (isNum(t.retryWaitMs)) out.retryWaitMs = t.retryWaitMs;
    if (Array.isArray(t.tools)) {
        const tools: ToolTiming[] = [];
        for (const item of t.tools) {
            if (!item || typeof item !== "object") continue;
            const tool = item as Record<string, unknown>;
            if (typeof tool.toolCallId !== "string" || !isNum(tool.startedAt)) continue;
            const parsed: ToolTiming = {
                toolCallId: tool.toolCallId,
                toolName: typeof tool.toolName === "string" ? tool.toolName : "",
                startedAt: tool.startedAt,
            };
            if (isNum(tool.endedAt)) parsed.endedAt = tool.endedAt;
            if (tool.error === true) parsed.error = true;
            tools.push(parsed);
        }
        if (tools.length > 0) out.tools = tools;
    }
    return out;
}

/** Activity is structured parts; entries written before that were one string. */
function parseActivity(raw: unknown): SubagentActivityPart[] | undefined {
    if (typeof raw === "string") return raw ? [{ type: "text", text: raw }] : undefined;
    if (!Array.isArray(raw)) return undefined;
    const parts = raw.filter(
        (p): p is SubagentActivityPart =>
            !!p &&
            typeof p === "object" &&
            ((p.type === "text" && typeof p.text === "string") ||
                (p.type === "reasoning" && typeof p.text === "string") ||
                (p.type === "tool" && typeof p.name === "string" && typeof p.summary === "string")),
    );
    return parts.length ? parts : undefined;
}

/** Tree fields (id/parentId) pass through so the reference branched sessions keep their shape. */
function treeFields(obj: Record<string, unknown>): { id?: string; parentId?: string | null } {
    const out: { id?: string; parentId?: string | null } = {};
    if (typeof obj.id === "string") out.id = obj.id;
    if (obj.parentId === null || typeof obj.parentId === "string") out.parentId = obj.parentId as string | null;
    return out;
}

/**
 * Adapt a raw JSON line from a legacy or loop session into our Entry shape.
 * Unknown shapes fall back to { type: "custom", payload }.
 */
export function adaptSessionEntry(raw: unknown): Entry | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    const ts = typeof obj.ts === "number" ? obj.ts : typeof obj.timestamp === "number" ? obj.timestamp : Date.now();
    const tree = treeFields(obj);

    switch (obj.type) {
        case "session-info":
            return {
                type: "session-info",
                ts,
                createdAt: typeof obj.createdAt === "number" ? obj.createdAt : ts,
                cwd: String(obj.cwd ?? ""),
                provider: (obj.provider as ProviderId) ?? "xai",
                model: String(obj.model ?? ""),
                parentSession: typeof obj.parentSession === "string" ? obj.parentSession : undefined,
                ...tree,
                // session-info doubles as our SessionInfoData (id = session id),
                // which is also this root entry's tree id.
                id: tree.id ?? String(obj.id ?? ""),
            } as Entry;
        case "message": {
            // the reference nests the message: { type: "message", id, parentId, message: { role, content } }
            const nested = obj.message as Record<string, unknown> | undefined;
            const role = (nested?.role ?? obj.role) as string | undefined;
            const content = nested ? nested.content : obj.content;
            const mappedRole =
                role === "toolResult" || role === "tool" ? "tool" : role === "assistant" ? "assistant" : "user";
            const timing = parseStepTiming(obj.timing);
            return {
                type: "message",
                ts,
                role: mappedRole,
                content,
                usage: obj.usage as UsageBlock | undefined,
                // model: per-message pricing stamp (correct cost re-seeding after
                // a mid-session model switch). interrupted: marks a turn the user
                // cut off, so toModelMessages surfaces the interruption note
                // instead of dropping the turn. Both must survive the reload.
                ...(typeof obj.model === "string" ? { model: obj.model } : {}),
                ...(obj.interrupted === true ? { interrupted: true } : {}),
                // Per-reasoning-part durations — display metadata for
                // "Thought for Xs" on resume (see the Entry type).
                ...(Array.isArray(obj.reasoningMs) && obj.reasoningMs.every((n) => typeof n === "number")
                    ? { reasoningMs: obj.reasoningMs as number[] }
                    : {}),
                // Step wall clock for the trace view — same contract.
                ...(timing ? { timing } : {}),
                // A user message the thread team wrote (a brief, mail): clients
                // draw it as a team card, and it must stay one after a reload.
                ...(mappedRole === "user" && isTeamMeta(obj.team) ? { team: obj.team } : {}),
                ...tree,
            };
        }
        case "subagent":
            return {
                type: "subagent",
                ts,
                agent: String(obj.agent ?? "default"),
                prompt: String(obj.prompt ?? ""),
                result: String(obj.result ?? ""),
                activity: parseActivity(obj.activity),
                usage: obj.usage as UsageBlock | undefined,
                ...(typeof obj.model === "string" ? { model: obj.model } : {}),
                ...(typeof obj.toolCallId === "string" ? { toolCallId: obj.toolCallId } : {}),
                ...(typeof obj.followUpOf === "string" ? { followUpOf: obj.followUpOf } : {}),
                ...(typeof obj.steps === "number" ? { steps: obj.steps } : {}),
                ...(typeof obj.durationMs === "number" ? { durationMs: obj.durationMs } : {}),
                ...tree,
            };
        case "model-change":
            return { type: "model-change", ts, from: String(obj.from ?? ""), to: String(obj.to ?? ""), ...tree };
        case "model_change":
            return { type: "model-change", ts, from: "", to: String(obj.modelId ?? ""), ...tree };
        case "compact":
            return {
                type: "compact",
                ts,
                summary: String(obj.summary ?? ""),
                cutAt: typeof obj.cutAt === "number" ? obj.cutAt : 0,
                tokensBefore: typeof obj.tokensBefore === "number" ? obj.tokensBefore : 0,
                tokensAfter: typeof obj.tokensAfter === "number" ? obj.tokensAfter : 0,
                usage: obj.usage as UsageBlock | undefined,
                ...(typeof obj.model === "string" ? { model: obj.model } : {}),
                // handoff/rollover: a no-summary rollover keeps its whole recovery
                // record here, so dropping them would rebuild the entry as an
                // EMPTY summary — the fresh window would open on "compacted into
                // the following summary:" and nothing. It also has to survive
                // replaceEntries(), which rewrites every row from these objects.
                ...(typeof obj.handoff === "string" ? { handoff: obj.handoff } : {}),
                ...(obj.rollover === true ? { rollover: true as const } : {}),
                ...tree,
            };
        case "branch-summary":
            return {
                type: "branch-summary",
                ts,
                summary: String(obj.summary ?? ""),
                fromId: typeof obj.fromId === "string" ? obj.fromId : undefined,
                usage: obj.usage as UsageBlock | undefined,
                ...(typeof obj.model === "string" ? { model: obj.model } : {}),
                ...tree,
            };
        // the reference branch summaries
        case "branch_summary":
            return {
                type: "branch-summary",
                ts,
                summary: String(obj.summary ?? ""),
                fromId: typeof obj.fromId === "string" ? obj.fromId : undefined,
                ...tree,
            };
        case "custom":
            // Already-adapted entries (e.g. recaps) round-trip through the store;
            // re-wrapping them via the default branch would bury the payload one
            // level deeper and break isRecapPayload() on resume.
            return { type: "custom", ts, payload: obj.payload, ...tree };
        case "label":
            return {
                type: "label",
                ts,
                targetId: String(obj.targetId ?? ""),
                label: typeof obj.label === "string" ? obj.label : undefined,
                ...tree,
            };
        case "session-name":
        // the reference writes display names as session_info entries (distinct from
        // our session-info header, which the reference doesn't use).
        case "session_info":
            return {
                type: "session-name",
                ts,
                name: typeof obj.name === "string" ? obj.name : undefined,
                ...tree,
            };
        default:
            // legacy shapes: user-prompt, assistant-message, tool-call, tool-result, etc.
            if (obj.type === "user-prompt" || obj.role === "user") {
                return { type: "message", ts, role: "user", content: obj.content ?? obj.text ?? "", ...tree };
            }
            if (obj.type === "assistant-message" || obj.role === "assistant") {
                return { type: "message", ts, role: "assistant", content: obj.content ?? obj.text ?? "", ...tree };
            }
            return { type: "custom", ts, payload: obj, ...tree };
    }
}

/** A saved `team` field worth keeping: the shape teams/runtime.ts TeamTurnMeta writes. */
function isTeamMeta(value: unknown): value is TeamTurnMeta {
    const v = value as { kind?: unknown; teamId?: unknown } | null;
    return !!v && typeof v === "object" && (v.kind === "spawn" || v.kind === "mail") && typeof v.teamId === "string";
}
