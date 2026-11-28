import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { cachedProbe, peekProbe } from "./probe-cache";
import { findExecutable, runCommand, stripAnsi } from "./process";
import { attachedImagesNote, writeTurnImages } from "./images";
import { CURSOR_PROVIDER, CursorTurnReader } from "./cursor-events";
import { runJsonLinesTurn } from "./json-lines-turn";
import {
    type Effort,
    EFFORT_ORDER,
    generateFromStream,
    nearestEffort,
    type PromptPlan,
    requestedEffort,
    streamNativeTurn,
    type TurnOutcome,
    type NativeAgentTurnContext,
} from "./shared";

/**
 * Cursor as an ai-sdk provider, driving the user's `cursor-agent` CLI in
 * headless mode (`-p --output-format stream-json`). The CLI's own login (or
 * CURSOR_API_KEY) authenticates; loop stores nothing.
 */
export { CURSOR_PROVIDER };

export function findCursorBinary(): string | undefined {
    return findExecutable(["cursor-agent"], "CURSOR_AGENT_BIN");
}

// ---- model families ----------------------------------------------------------

/**
 * Cursor lists every effort/thinking/speed combination as its own model id
 * (claude-opus-4-8-thinking-high-fast, gpt-5.5-extra-high, …). Loop has one
 * thinking-level control, so variants are grouped into families — one model
 * in loop's picker — and the variant is chosen per call from the level.
 */
export interface CursorVariant {
    id: string;
    name: string;
    /** Effort token in the id; "default" when the id carries none. */
    effort: Effort | "default";
    thinking: boolean;
}

export interface CursorFamily {
    /** loop model id (after "cursor-agent/"): base id, plus "-fast" for fast variants. */
    id: string;
    name: string;
    variants: CursorVariant[];
    /** More than one reasoning setting to choose between. */
    reasoning: boolean;
}

const EFFORT_TOKENS: Record<string, Effort> = {
    none: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
};

export function parseCursorVariant(id: string, name: string): { familyId: string; variant: CursorVariant } {
    const t = id.split("-");
    let fast = false;
    let thinking = false;
    let effort: Effort | "default" = "default";
    if (t.length > 1 && t.at(-1) === "fast") {
        fast = true;
        t.pop();
    }
    if (t.length > 1 && t.at(-1) === "thinking") {
        thinking = true;
        t.pop();
    }
    if (t.length > 2 && t.at(-2) === "extra" && t.at(-1) === "high") {
        effort = "xhigh";
        t.splice(-2);
    } else if (t.length > 1 && EFFORT_TOKENS[t.at(-1)!]) {
        effort = EFFORT_TOKENS[t.pop()!];
    }
    if (t.length > 1 && t.at(-1) === "thinking") {
        thinking = true;
        t.pop();
    }
    const base = t.join("-");
    return { familyId: fast ? `${base}-fast` : base, variant: { id, name, effort, thinking } };
}

const EFFORT_WORDS = /\b(none|minimal|low|medium|high|extra high|xhigh|max|thinking)\b/gi;

export function groupCursorModels(models: Array<{ id: string; name: string }>): CursorFamily[] {
    const families = new Map<string, CursorVariant[]>();
    for (const m of models) {
        const { familyId, variant } = parseCursorVariant(m.id, m.name);
        const list = families.get(familyId) ?? [];
        list.push(variant);
        families.set(familyId, list);
    }
    return [...families.entries()].map(([id, variants]) => {
        const representative = variants.find((v) => v.effort === "default") ?? variants[0];
        // "Gemini 3.8 Flash (High)" leaves "()" behind once the effort is gone.
        const name =
            representative.name.replace(EFFORT_WORDS, "").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim() || id;
        const settings = new Set(variants.map((v) => `${v.effort}/${v.thinking}`));
        return { id, name, variants, reasoning: settings.size > 1 || variants.some((v) => v.thinking) };
    });
}

const rankOf = (v: CursorVariant): Effort => (v.effort === "default" ? "medium" : v.effort);

/**
 * Pick the variant for loop's thinking level: thinking variants when thinking
 * is on (non-thinking when off), then the nearest effort. With no level
 * requested, the family's plain default (or its middle) is used.
 */
export function selectCursorVariant(family: CursorFamily, effort: Effort | undefined): CursorVariant {
    const { variants } = family;
    if (variants.length === 1) return variants[0];
    if (effort === undefined) {
        return (
            variants.find((v) => v.effort === "default" && !v.thinking) ??
            pickNearest(variants.filter((v) => v.thinking).length ? variants.filter((v) => v.thinking) : variants, "medium")
        );
    }
    const wantThinking = effort !== "none";
    const hasThinkingSplit = variants.some((v) => v.thinking) && variants.some((v) => !v.thinking);
    const pool = hasThinkingSplit ? variants.filter((v) => v.thinking === wantThinking) : variants;
    return pickNearest(pool.length ? pool : variants, effort);
}

function pickNearest(pool: CursorVariant[], target: Effort): CursorVariant {
    const chosen = nearestEffort(target, [...new Set(pool.map(rankOf))]);
    const matches = pool.filter((v) => rankOf(v) === chosen);
    // Prefer an explicit effort over the unnamed default at the same rank.
    return matches.find((v) => v.effort !== "default") ?? matches[0] ?? pool[0];
}

// ---- detection ---------------------------------------------------------------

export interface CursorProbe {
    binary: string;
    loggedIn: boolean;
    account?: string;
    families: CursorFamily[];
}

const PROBE_KEY = CURSOR_PROVIDER;

export async function probeCursor(opts: { refresh?: boolean } = {}): Promise<CursorProbe | null> {
    const binary = findCursorBinary();
    if (!binary) return null;
    return cachedProbe<CursorProbe | null>(PROBE_KEY, async () => {
        const status = await runCommand(binary, ["status"], { timeoutMs: 15_000 });
        const statusText = stripAnsi(status.stdout + status.stderr);
        const login = /logged in as\s+(\S+)/i.exec(statusText);
        const loggedIn = Boolean(login) || Boolean(process.env.CURSOR_API_KEY);
        if (!loggedIn) return { binary, loggedIn: false, families: [] };
        const list = await runCommand(binary, ["--list-models"], { timeoutMs: 30_000 });
        const models: Array<{ id: string; name: string }> = [];
        for (const raw of stripAnsi(list.stdout).split("\n")) {
            const m = /^\s*([A-Za-z0-9][\w.\-\[\]=,]*)\s+-\s+(.+?)\s*$/.exec(raw);
            if (!m) continue;
            // Zero-width characters ride along in some display names.
            const name = m[2].replace(/\((current|default)[^)]*\)/gi, "").replace(/[​-‍﻿]/g, "").trim();
            models.push({ id: m[1], name });
        }
        return { binary, loggedIn: true, account: login?.[1], families: groupCursorModels(models) };
    }, opts);
}

function familyFor(modelId: string): CursorFamily | undefined {
    return peekProbe<CursorProbe | null>(PROBE_KEY)?.families.find((f) => f.id === modelId);
}

/** The concrete `--model` value for a loop model id + thinking level. */
export function resolveCursorModel(modelId: string, effort: Effort | undefined): string {
    const family = familyFor(modelId);
    return family ? selectCursorVariant(family, effort).id : modelId;
}

// ---- the model ---------------------------------------------------------------

export class CursorLanguageModel implements LanguageModelV4 {
    readonly specificationVersion = "v4" as const;
    readonly provider = CURSOR_PROVIDER;
    readonly supportedUrls = {};

    constructor(readonly modelId: string) {}

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
        return generateFromStream(await this.doStream(options));
    }

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
        const binary = findCursorBinary();
        if (!binary) throw new Error("Cursor's CLI is not installed (no `cursor-agent` on PATH). Install it, then run `cursor-agent login`.");
        // No system-prompt flag: loop's prompt leads the first message instead.
        return streamNativeTurn(CURSOR_PROVIDER, options, { inlineSystem: true }, (ctx, plan, enqueue) =>
            this.runTurn(binary, options, ctx, plan, enqueue),
        );
    }

    private async runTurn(
        binary: string,
        options: LanguageModelV4CallOptions,
        ctx: NativeAgentTurnContext | undefined,
        plan: PromptPlan,
        enqueue: (part: LanguageModelV4StreamPart) => void,
    ): Promise<TurnOutcome> {
        const images = writeTurnImages(plan.images);
        try {
            return await this.runProcess(binary, options, ctx, plan, `${plan.text}${attachedImagesNote(images.paths)}`, enqueue);
        } finally {
            images.dispose();
        }
    }

    private async runProcess(
        binary: string,
        options: LanguageModelV4CallOptions,
        ctx: NativeAgentTurnContext | undefined,
        plan: PromptPlan,
        stdin: string,
        enqueue: (part: LanguageModelV4StreamPart) => void,
    ): Promise<TurnOutcome> {
        const variant = resolveCursorModel(this.modelId, requestedEffort(options));
        const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust", "--model", variant];
        if (plan.resumeId) args.push("--resume", plan.resumeId);
        if (!ctx) args.push("--mode", "ask");
        else if (ctx.planMode) args.push("--mode", "plan");
        else if (ctx.approvals) args.push("--auto-review");
        else args.push("--force");
        if (ctx) args.push("--workspace", ctx.cwd);

        return runJsonLinesTurn({
            provider: CURSOR_PROVIDER,
            label: "Cursor",
            binary,
            args,
            stdin,
            ctx,
            plan,
            signal: options.abortSignal,
            reader: new CursorTurnReader(enqueue, { variant, plan, ctx }),
            enqueue,
        });
    }
}

export function createCursorModel(modelId: string): LanguageModelV4 {
    return new CursorLanguageModel(modelId);
}

/** For the catalog: the efforts a family can express, strongest last. */
export function familyEfforts(family: CursorFamily): Effort[] {
    return EFFORT_ORDER.filter((e) => family.variants.some((v) => rankOf(v) === e));
}
