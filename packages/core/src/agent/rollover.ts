/**
 * The recovery record a no-summary rollover carries into a fresh window.
 *
 * Built mechanically from the transcript — no model call, ever. That is the
 * whole cost argument for rolling over instead of summarizing: the boundary is
 * free, deterministic, cannot hallucinate, and works when no summarizer model
 * is reachable.
 *
 * What it keeps is inputs and externalized state, never inferred progress:
 * every user message, the live todo list, the files this window touched, the
 * commands it ran, and the trailing tool batch no model has consumed yet.
 * Assistant prose, reasoning and already-consumed tool results are dropped on
 * purpose — if it mattered it is in a file, in the todos, or in agent memory.
 */
import type { Entry } from "../types";
import { toolOutputText } from "./compact";
import { isTodosPayload, formatTodoList, hasActiveTodos, type TodoItem } from "../tools/todo";

/** Absolute ceiling; the live budget usually cuts well below this. */
export const MAX_HANDOFF_CHARS = 20_000;
/** A window must hold the largest handoff (~5k tokens) plus equal working room. */
export const MIN_USABLE_TOKENS = Math.ceil(MAX_HANDOFF_CHARS / 4) * 2;
/** Per-section ceiling, so one runaway source cannot crowd out the rest. */
const MAX_SECTION_CHARS = 4_000;
/** Headroom for joins and the preamble the caller wraps around this. */
const OVERHEAD_RESERVE = 1_000;

const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "multi_edit", "notebook_edit"]);
const SHELL_TOOLS = new Set(["bash", "shell", "run"]);

interface ToolCallPart {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    args?: unknown;
    output?: unknown;
}

function parts(content: unknown): ToolCallPart[] {
    return Array.isArray(content) ? (content as ToolCallPart[]) : [];
}

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    return parts(content)
        .map((p) => {
            const b = p as { type?: string; text?: string };
            return b.type === "text" ? (b.text ?? "") : "";
        })
        .filter(Boolean)
        .join("\n");
}

/** Middle-out truncation: the head and tail of a record both carry signal. */
function excerpt(text: string, limit: number): string {
    if (limit <= 0) return "";
    if (text.length <= limit) return text;
    const marker = "\n… middle omitted …\n";
    if (limit <= marker.length) return text.slice(0, limit);
    const head = Math.floor((limit - marker.length) / 2);
    return `${text.slice(0, head)}${marker}${text.slice(text.length - (limit - marker.length - head))}`;
}

/**
 * Where the current window starts. Pre-cut entries are still on the branch —
 * compaction never deletes — so scanning from the root would re-collect every
 * historical user message on the second rollover and again on the third, until
 * the handoff outgrows its budget and rollover silently stops happening.
 */
function windowStart(branch: readonly Entry[]): number {
    for (let i = branch.length - 1; i >= 0; i--) {
        if (branch[i].type === "compact") return i + 1;
    }
    return 0;
}

function priorHandoff(branch: readonly Entry[]): string | undefined {
    for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (e.type !== "compact") continue;
        // Never nest a prior recovery record: it would compound every rollover
        // into the next until the whole budget is old handoffs.
        return e.handoff ? "(an earlier rollover record — recover it with history if needed)" : e.summary || undefined;
    }
    return undefined;
}

/**
 * The trailing tool batch no model has seen. A rollover can land immediately
 * after tools finish, so the result that triggered it would otherwise vanish
 * before any model read it — the batch is dropped from context by the cut, and
 * no assistant message ever summarized it.
 */
function unconsumedToolBatch(current: readonly Entry[]): string[] {
    const out: string[] = [];
    let sawAssistantText = false;
    for (let i = current.length - 1; i >= 0; i--) {
        const e = current[i];
        if (e.type !== "message") continue;
        if (e.role === "assistant") {
            // Text after the tool results means a model already consumed them.
            if (textOf(e.content).trim()) sawAssistantText = true;
            break;
        }
        if (e.role !== "tool") continue;
        for (const p of parts(e.content)) {
            if (p.type !== "tool-result") continue;
            out.unshift(`${p.toolName ?? "tool"}: ${excerpt(toolOutputText(p.output), 600)}`);
        }
    }
    return sawAssistantText ? [] : out;
}

function collectToolUse(current: readonly Entry[]): { files: string[]; commands: string[] } {
    const files: string[] = [];
    const commands: string[] = [];
    for (const e of current) {
        if (e.type !== "message" || e.role !== "assistant") continue;
        for (const p of parts(e.content)) {
            if (p.type !== "tool-call") continue;
            const name = p.toolName ?? "";
            const input = (p.input ?? p.args ?? {}) as Record<string, unknown>;
            if (FILE_TOOLS.has(name)) {
                const path = input.file_path ?? input.path ?? input.filePath;
                if (typeof path === "string" && !files.includes(path)) files.push(path);
            } else if (SHELL_TOOLS.has(name)) {
                const cmd = input.command ?? input.cmd;
                if (typeof cmd === "string") commands.push(cmd.split("\n")[0].slice(0, 200));
            }
        }
    }
    return { files, commands };
}

function latestTodosOn(branch: readonly Entry[]): TodoItem[] | null {
    for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (e.type === "custom" && isTodosPayload(e.payload)) return e.payload.items;
    }
    return null;
}

export interface BuildHandoffOptions {
    /** Hard character ceiling for the record, from the live context budget. */
    limit: number;
    /** Path of the session scratchpad, named in the record when notes exist. */
    notesPath?: string;
    /** Whether to carry the command list (settings-gated; output is never kept). */
    carryCommands?: boolean;
}

/**
 * Build the record, or return undefined when nothing useful fits — the caller
 * then leaves the turn to whatever compaction policy was already in place
 * rather than committing a boundary that loses the window for nothing.
 */
export function buildRolloverHandoff(branch: readonly Entry[], opts: BuildHandoffOptions): string | undefined {
    const limit = Math.min(MAX_HANDOFF_CHARS, opts.limit) - OVERHEAD_RESERVE;
    if (limit <= 0) return undefined;

    const current = branch.slice(windowStart(branch));
    const sections: string[] = [];
    let used = 0;
    /** Sections are added strongest-first and simply skipped once full. */
    const push = (header: string, body: string): void => {
        if (!body.trim()) return;
        const block = `${header}\n${excerpt(body.trim(), MAX_SECTION_CHARS)}`;
        if (used + block.length + 2 > limit) return;
        sections.push(block);
        used += block.length + 2;
    };

    // P0 — owner intent. Mid-session corrections ("no, not that library") are
    // the highest-value bytes in the transcript and are never inferable again.
    const userText = current
        .filter((e) => e.type === "message" && e.role === "user")
        .map((e) => textOf((e as Extract<Entry, { type: "message" }>).content).trim())
        .filter(Boolean);
    if (userText.length) {
        push(
            "## What the user asked for (their own words, in order)",
            userText.map((t, i) => `${i + 1}. ${excerpt(t, 1_200)}`).join("\n\n"),
        );
    }

    // P1 — the checklist. Free: it is already a persisted custom entry.
    const todos = latestTodosOn(branch);
    if (todos && hasActiveTodos(todos)) {
        push("## Todo list, as it stands", formatTodoList(todos));
    }

    // P2/P3 — externalized work. Derived from tool calls, so no bookkeeping is
    // needed anywhere else in the turn loop.
    const { files, commands } = collectToolUse(current);
    if (files.length) {
        push(
            "## Files this window touched (re-read before editing; they are on disk)",
            files.map((f) => `- ${f}`).join("\n"),
        );
    }
    if (opts.carryCommands !== false && commands.length) {
        const recent = commands.slice(-25);
        push("## Commands already run (output not kept — re-run if you need it)", recent.map((c) => `- ${c}`).join("\n"));
    }

    // P4 — results that exist only here.
    const batch = unconsumedToolBatch(current);
    if (batch.length) {
        push("## Tool results no model has read yet (they arrived as this window ended)", batch.join("\n\n"));
    }

    if (opts.notesPath) {
        push("## Notes", `Durable state for this session is at ${opts.notesPath} — read it before continuing.`);
    }

    // P5 — clearly labelled, never nested.
    const prior = priorHandoff(branch);
    if (prior) push("## From an earlier boundary — POSSIBLY STALE", excerpt(prior, 1_000));

    if (!sections.length) return undefined;
    return sections.join("\n\n");
}
