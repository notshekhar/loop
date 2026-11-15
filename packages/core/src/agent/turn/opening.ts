/**
 * Everything a turn does before it has a model to talk to: pull attachments
 * out of the prompt, let hooks and extensions veto it, save the user's
 * message, and load the project context the prompt is built from.
 */
import { getCatalog, modelInfoIn } from "../../catalog";
import { getSetting } from "../../settings";
import type { Entry } from "../../types";
import { extractImagesFromInput, filterAttachmentsByModalities } from "../images";
import { runHooks, type HookOutcome } from "../hooks";
import { runBeforeTurn } from "../turn-middleware";
import { loadWorkspaceContext } from "../context";
import { loadMemoryContext } from "../memory";
import { loadProjectSkills, type Skill } from "../skills";
import { isTrusted } from "../trust";
import { cancelRecap } from "../recap-schedule";
import { cancelIdleCompact } from "../idle-compact";
import { setActiveBranch } from "../context-policy";
import type { RunTurnOptions } from "./types";

export type TurnImage = ReturnType<typeof extractImagesFromInput>["images"][number];

export interface TurnAttachments {
    images: TurnImage[];
    /** The prompt with attachment paths taken out — the text part next to the images. */
    textWithoutPaths: string;
}

/**
 * Extract attachment paths (images/PDFs) → ai-sdk file parts, keeping only
 * what this model's catalog modalities accept. Rejected paths go back into
 * the text so the reference reaches the model instead of vanishing.
 */
export async function resolveAttachments(opts: RunTurnOptions): Promise<TurnAttachments> {
    const { userInput, cwd, modelId, emitter } = opts;
    const extracted = extractImagesFromInput(userInput, cwd);
    const { allowed: images, rejected } = filterAttachmentsByModalities(
        extracted.images,
        modelInfoIn(await getCatalog(), modelId)?.modalities,
        modelId.split("/")[0],
    );
    let textWithoutPaths = extracted.textWithoutPaths;
    if (rejected.length > 0) {
        // Only paths the cleanup actually removed (sentinel forms keep their
        // token in text).
        const missing = rejected.map((r) => r.path).filter((p) => !textWithoutPaths.includes(p));
        textWithoutPaths = [textWithoutPaths, ...missing].filter(Boolean).join("\n");
    }
    if (images.length > 0) {
        emitter.emit(
            "attached-images",
            images.map((i) => i.path),
        );
    }
    return { images, textWithoutPaths };
}

/** Report a turn that ends before it starts; every early return emits finish. */
export function endTurnEarly(opts: RunTurnOptions, error?: string): void {
    if (error) opts.emitter.emit("error", error);
    opts.emitter.emit("finish", { usage: undefined });
}

/**
 * UserPromptSubmit hooks, then extension onBeforeTurn — either may block the
 * turn. Returns the hook outcome (its additionalContext rides the model-bound
 * messages), or null when the turn was blocked and has already been ended.
 *
 * Hooks are skipped for Stop-hook continuations (hookDepth > 0) — those are
 * synthetic turns, and Claude Code doesn't fire UserPromptSubmit for them.
 */
export async function runPromptGates(opts: RunTurnOptions): Promise<HookOutcome | null> {
    const { session, userInput, cwd } = opts;
    const promptHooks: HookOutcome =
        (opts.hookDepth ?? 0) === 0
            ? await runHooks(
                  "UserPromptSubmit",
                  undefined,
                  { session_id: session.id, transcript_path: session.path, prompt: userInput },
                  cwd,
              )
            : { block: false, messages: [], terminalSequences: [] };
    forwardHookOutput(opts, promptHooks);
    if (promptHooks.block) {
        endTurnEarly(opts, `prompt blocked by hook: ${promptHooks.reason}`);
        return null;
    }
    const allowed = await runBeforeTurn({
        input: userInput,
        cwd,
        sessionId: session.id,
        agent: opts.agent ?? "default",
        modelId: opts.modelId,
    });
    if (!allowed) {
        endTurnEarly(opts, "turn blocked by extension");
        return null;
    }
    return promptHooks;
}

export function forwardHookOutput(opts: RunTurnOptions, outcome: HookOutcome): void {
    for (const m of outcome.messages) opts.emitter.emit("hook-message", m);
    for (const s of outcome.terminalSequences) opts.emitter.emit("hook-terminal-sequence", s);
}

/**
 * Close the previous turn's background windows, then save the prompt.
 *
 * The previous turn's recap and any idle compaction die here — the user has
 * answered, so they summarise something the user has moved past. Deliberately
 * BEFORE the append: it is the append that a late one would sort after.
 */
export async function recordUserMessage(opts: RunTurnOptions): Promise<void> {
    const { session, userInput, emitter } = opts;
    cancelRecap(session.id);
    cancelIdleCompact(session.id);
    // Recovery tools (history) read conversation the model can no longer see,
    // so they need the branch itself, not the model-bound context.
    setActiveBranch(() => session.getBranch());

    const tags = { ...(opts.team ? { team: opts.team } : {}), ...(opts.btw ? { btw: opts.btw } : {}) };
    // Saved verbatim (paths intact for reference in transcripts).
    const userEntry: Entry = { type: "message", ts: Date.now(), role: "user", content: userInput, ...tags };
    await session.append(userEntry);
    // Clients build the turn from the live stream alone (transcript/), so the
    // prompt goes out on it too, under the id it was saved with.
    emitter.emit("user-message", { id: userEntry.id ?? "", text: userInput, ts: userEntry.ts, ...tags });
}

export interface ProjectContext {
    workspaceContext: string;
    memoryContext: string;
    skills: Skill[];
    skillsPrompt: string;
}

export async function loadProjectContext(cwd: string): Promise<ProjectContext> {
    const workspaceContext = getSetting("workspaceContext") !== false ? loadWorkspaceContext(cwd).text : "";
    // Agent memory (default on): policy + MEMORY.md index for this project.
    // Main agent only — subagents don't get the write policy, so fan-out work
    // can't race duplicate memory writes.
    const memoryContext = getSetting("memory") !== false ? loadMemoryContext(cwd).text : "";
    // Project skills inject instructions into the prompt — gate on trust too.
    const skillsEnabled = getSetting("skills") !== false && isTrusted(cwd);
    const skills = skillsEnabled ? await loadProjectSkills(cwd) : { skills: [], promptBlock: "" };
    return { workspaceContext, memoryContext, skills: skills.skills, skillsPrompt: skills.promptBlock };
}
