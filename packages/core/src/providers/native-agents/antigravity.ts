import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { groupCursorModels, selectCursorVariant, type CursorFamily } from "./cursor";
import { cachedProbe, peekProbe } from "./probe-cache";
import { findExecutable, runCommand, stripAnsi } from "./process";
import { attachedImagesNote, writeTurnImages } from "./images";
import { ANTIGRAVITY_PROVIDER, AntigravityTurnReader } from "./antigravity-events";
import { runJsonLinesTurn } from "./json-lines-turn";
import {
    type Effort,
    generateFromStream,
    type PromptPlan,
    requestedEffort,
    streamNativeTurn,
    type TurnOutcome,
    type NativeAgentTurnContext,
} from "./shared";

/**
 * Google's Antigravity as an ai-sdk provider, driving the user's `agy` CLI in
 * print mode (`-p --output-format stream-json`). The CLI's own sign-in
 * authenticates; loop stores nothing.
 */
export { ANTIGRAVITY_PROVIDER };

export function findAntigravityBinary(): string | undefined {
    return findExecutable(["agy"], "ANTIGRAVITY_BIN");
}

// ---- detection ---------------------------------------------------------------

/**
 * Like Cursor, `agy models` lists every effort as its own id
 * (gemini-3.8-flash-high, -medium, -low), so the same family grouping applies:
 * one model in loop's picker, the variant chosen from the thinking level.
 */
export type AntigravityFamily = CursorFamily;

export interface AntigravityProbe {
    binary: string;
    loggedIn: boolean;
    families: AntigravityFamily[];
}

const PROBE_KEY = ANTIGRAVITY_PROVIDER;

/** `agy models` prints `id<TAB>Display name` per model, after a banner line. */
export function parseAntigravityModels(stdout: string): Array<{ id: string; name: string }> {
    const models: Array<{ id: string; name: string }> = [];
    for (const raw of stripAnsi(stdout).split("\n")) {
        const m = /^([A-Za-z0-9][\w.\-]*)\t+(.+?)\s*$/.exec(raw);
        if (m) models.push({ id: m[1], name: m[2] });
    }
    return models;
}

export async function probeAntigravity(opts: { refresh?: boolean } = {}): Promise<AntigravityProbe | null> {
    const binary = findAntigravityBinary();
    if (!binary) return null;
    return cachedProbe<AntigravityProbe | null>(PROBE_KEY, async () => {
        // No status command: listing the account's models needs the sign-in,
        // so a list is the proof of one.
        const list = await runCommand(binary, ["models"], { timeoutMs: 30_000 });
        const models = list.code === 0 ? parseAntigravityModels(list.stdout) : [];
        if (models.length === 0) return { binary, loggedIn: false, families: [] };
        return { binary, loggedIn: true, families: groupCursorModels(models) };
    }, opts);
}

function familyFor(modelId: string): AntigravityFamily | undefined {
    return peekProbe<AntigravityProbe | null>(PROBE_KEY)?.families.find((f) => f.id === modelId);
}

/** The concrete `--model` value for a loop model id + thinking level. */
export function resolveAntigravityModel(modelId: string, effort: Effort | undefined): string {
    const family = familyFor(modelId);
    return family ? selectCursorVariant(family, effort).id : modelId;
}

// ---- argv --------------------------------------------------------------------

/**
 * The command line for one turn. agy parses flags Go-style, so the prompt
 * rides as `--print=<text>`: a prompt starting with "-" stays a prompt.
 */
export function antigravityArgs(input: {
    model: string;
    prompt: string;
    resumeId?: string;
    ctx?: NativeAgentTurnContext;
}): string[] {
    const args = [`--print=${input.prompt}`, "--output-format", "stream-json", "--model", input.model, "--disable-slash-commands"];
    if (input.resumeId) args.push("--conversation", input.resumeId);
    const { ctx } = input;
    if (!ctx || ctx.planMode) args.push("--mode", "plan");
    // Print mode cannot ask; "auto" lets agy decide what is safe to run.
    else if (ctx.approvals) args.push("--mode", "auto");
    else args.push("--dangerously-skip-permissions");
    return args;
}

// ---- the model ---------------------------------------------------------------

export class AntigravityLanguageModel implements LanguageModelV4 {
    readonly specificationVersion = "v4" as const;
    readonly provider = ANTIGRAVITY_PROVIDER;
    readonly supportedUrls = {};

    constructor(readonly modelId: string) {}

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
        return generateFromStream(await this.doStream(options));
    }

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
        const binary = findAntigravityBinary();
        if (!binary) throw new Error("Antigravity's CLI is not installed (no `agy` on PATH). Install it, then sign in by running `agy`.");
        // No system-prompt flag: loop's prompt leads the first message instead.
        return streamNativeTurn(ANTIGRAVITY_PROVIDER, options, { inlineSystem: true }, (ctx, plan, enqueue) =>
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
        prompt: string,
        enqueue: (part: LanguageModelV4StreamPart) => void,
    ): Promise<TurnOutcome> {
        const variant = resolveAntigravityModel(this.modelId, requestedEffort(options));
        const args = antigravityArgs({ model: variant, prompt, resumeId: plan.resumeId, ctx });

        return runJsonLinesTurn({
            provider: ANTIGRAVITY_PROVIDER,
            label: "Antigravity",
            binary,
            args,
            ctx,
            plan,
            signal: options.abortSignal,
            reader: new AntigravityTurnReader(enqueue, { variant, plan, ctx }),
            enqueue,
        });
    }
}

export function createAntigravityModel(modelId: string): LanguageModelV4 {
    return new AntigravityLanguageModel(modelId);
}
