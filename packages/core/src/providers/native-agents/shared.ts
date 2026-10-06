import type {
    JSONValue,
    LanguageModelV4CallOptions,
    LanguageModelV4Content,
    LanguageModelV4FilePart,
    LanguageModelV4FinishReason,
    LanguageModelV4GenerateResult,
    LanguageModelV4Message,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
    LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../brand";

/**
 * Native-agent providers: Claude Code and Cursor run their OWN agent loop
 * (tools, approvals, context management) behind an ai-sdk LanguageModel. One
 * `doStream` call is one full native turn; every tool call inside it is
 * reported provider-executed, so loop's tool loop records and renders it but
 * never runs it, and the step ends with finishReason "stop".
 */
export type NativeAgentProviderId = "claude-code" | "cursor-agent";
export const NATIVE_AGENT_PROVIDERS: readonly NativeAgentProviderId[] = ["claude-code", "cursor-agent"];

export function isNativeAgentProvider(provider: string): provider is NativeAgentProviderId {
    return (NATIVE_AGENT_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Per-turn context loop hands the provider through providerOptions[provider]
 * (see runTurn). Its absence marks a utility call — a session title, recap,
 * compaction summary — which runs tool-less and leaves no native session.
 */
export interface NativeAgentTurnContext {
    loopSessionId: string;
    cwd: string;
    planMode: boolean;
    /** The user opted into per-tool approval prompts (bashApprove). */
    approvals: boolean;
}

export function readTurnContext(
    options: LanguageModelV4CallOptions,
    provider: NativeAgentProviderId,
): NativeAgentTurnContext | undefined {
    const raw = options.providerOptions?.[provider] as Partial<NativeAgentTurnContext> | undefined;
    if (!raw || typeof raw.loopSessionId !== "string" || typeof raw.cwd !== "string") return undefined;
    return {
        loopSessionId: raw.loopSessionId,
        cwd: raw.cwd,
        planMode: raw.planMode === true,
        approvals: raw.approvals === true,
    };
}

// ---- session links -----------------------------------------------------------

/**
 * Loop's transcript is the record; the native agent's own session is its
 * working memory. A link remembers which native session continues a loop
 * session, and how many (non-system) prompt messages that native session has
 * already seen — so the next turn sends only what is new.
 */
interface SessionLink {
    nativeId: string;
    /** Non-system prompt messages the native session had seen when it last ran. */
    seen: number;
    model: string;
    updatedAt: number;
}

const LINKS_FILE = () => join(getConfigDir(), "native-agent-sessions.json");
let linksCache: Record<string, SessionLink> | undefined;

function readLinks(): Record<string, SessionLink> {
    if (linksCache) return linksCache;
    try {
        linksCache = JSON.parse(readFileSync(LINKS_FILE(), "utf8")) as Record<string, SessionLink>;
    } catch {
        linksCache = {};
    }
    return linksCache;
}

const linkKey = (provider: NativeAgentProviderId, loopSessionId: string) => `${provider}:${loopSessionId}`;

export function getSessionLink(provider: NativeAgentProviderId, loopSessionId: string): SessionLink | undefined {
    return readLinks()[linkKey(provider, loopSessionId)];
}

export function setSessionLink(provider: NativeAgentProviderId, loopSessionId: string, link: SessionLink): void {
    const links = readLinks();
    links[linkKey(provider, loopSessionId)] = link;
    // Bound the file: keep the 500 most recently used links.
    const entries = Object.entries(links).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    linksCache = Object.fromEntries(entries.slice(0, 500));
    try {
        const dir = getConfigDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = `${LINKS_FILE()}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(linksCache, null, 2), { mode: 0o600 });
        renameSync(tmp, LINKS_FILE());
    } catch {
        /* a lost link only costs a re-seed next turn */
    }
}

// ---- prompt planning ---------------------------------------------------------

export interface PromptPlan {
    /** Native session to resume, when its memory already covers the history. */
    resumeId?: string;
    /** The user message(s) to send this turn — with history seeded in when not resuming. */
    text: string;
    /** Images attached to the new user message(s). */
    images: Array<{ mediaType: string; base64: string }>;
    /** Non-system messages in this prompt — the link's `seen` after this turn. */
    seen: number;
}

/**
 * Decide what the native agent must be told this turn.
 *
 * Resume when the messages since the native session last ran are exactly its
 * own reply (assistant/tool) followed by the new user message(s). Anything
 * else — another model answered in between, loop compacted or edited the
 * history, the link is missing — starts a fresh native session seeded with
 * loop's transcript, so the agent never loses context loop still shows.
 */
export function planPrompt(prompt: LanguageModelV4Message[], link: SessionLink | undefined, model: string): PromptPlan {
    const msgs = prompt.filter((m) => m.role !== "system");
    let firstNew = msgs.length;
    while (firstNew > 0 && msgs[firstNew - 1].role === "user") firstNew--;
    const newUsers = msgs.slice(firstNew);
    const { text, images } = renderUserMessages(newUsers);

    const resumable =
        link !== undefined &&
        link.model === model &&
        link.seen <= firstNew &&
        msgs.slice(link.seen, firstNew).every((m) => m.role === "assistant" || m.role === "tool");
    if (resumable) return { resumeId: link.nativeId, text, images, seen: msgs.length };

    const history = msgs.slice(0, firstNew);
    if (history.length === 0) return { text, images, seen: msgs.length };
    return {
        text:
            "You are continuing a conversation that started before this session. " +
            "The transcript so far is below; treat it as your own prior context.\n\n" +
            `<conversation-so-far>\n${renderTranscript(history)}\n</conversation-so-far>\n\n${text}`,
        images,
        seen: msgs.length,
    };
}

const SEED_LIMIT = 200_000;

function renderTranscript(messages: LanguageModelV4Message[]): string {
    const lines: string[] = [];
    for (const m of messages) {
        if (m.role === "system") continue;
        if (m.role === "user") {
            lines.push(`[user]\n${renderUserMessages([m]).text}`);
            continue;
        }
        for (const part of m.content) {
            switch (part.type) {
                case "text":
                    if (part.text.trim()) lines.push(`[assistant]\n${part.text}`);
                    break;
                case "tool-call":
                    lines.push(`[tool call: ${part.toolName}] ${clip(stringify(part.input), 2_000)}`);
                    break;
                case "tool-result":
                    lines.push(`[tool result: ${part.toolName}] ${clip(stringify(toolOutputValue(part.output)), 4_000)}`);
                    break;
                default:
                    break;
            }
        }
    }
    const out = lines.join("\n\n");
    // Keep the most recent context when the history is huge.
    return out.length > SEED_LIMIT ? `[…earlier history omitted…]\n${out.slice(-SEED_LIMIT)}` : out;
}

function renderUserMessages(messages: LanguageModelV4Message[]): Pick<PromptPlan, "text" | "images"> {
    const texts: string[] = [];
    const images: PromptPlan["images"] = [];
    for (const m of messages) {
        if (m.role !== "user") continue;
        for (const part of m.content) {
            if (part.type === "text") texts.push(part.text);
            else if (part.type === "file") {
                const image = imageOf(part);
                if (image) images.push(image);
                else texts.push(`[attached file: ${part.filename ?? part.mediaType}]`);
            }
        }
    }
    return { text: texts.join("\n\n"), images };
}

function imageOf(part: LanguageModelV4FilePart): { mediaType: string; base64: string } | undefined {
    if (!part.mediaType.startsWith("image/")) return undefined;
    const data = part.data;
    if (data.type === "data") {
        const base64 = typeof data.data === "string" ? data.data : Buffer.from(data.data).toString("base64");
        return { mediaType: part.mediaType, base64 };
    }
    return undefined;
}

function toolOutputValue(output: { type: string; value?: unknown; reason?: string }): unknown {
    if (output.type === "execution-denied") return `denied${output.reason ? `: ${output.reason}` : ""}`;
    return output.value;
}

export function stringify(value: unknown): string {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function clip(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---- stream plumbing ---------------------------------------------------------

/**
 * Opens/closes text and reasoning blocks so emitted parts always satisfy the
 * ai-sdk block protocol (start → deltas → end), whatever order the native
 * agent's events arrive in.
 */
/**
 * Provider-metadata key stamped on every tool call/result a native agent
 * reports. Loop persists part metadata verbatim, so history can tell these
 * calls (already executed inside the agent) from ones loop must answer —
 * see flattenNativeAgentParts.
 */
export const NATIVE_AGENT_PART_KEY = "nativeAgent";

export class PartWriter {
    private textId: string | undefined;
    private reasoningId: string | undefined;
    private wroteText = false;
    private readonly startedTools = new Set<string>();
    private seq = 0;
    constructor(
        private readonly enqueue: (part: LanguageModelV4StreamPart) => void,
        private readonly provider: NativeAgentProviderId,
    ) {}

    private get marker() {
        return { [NATIVE_AGENT_PART_KEY]: { provider: this.provider } };
    }

    text(delta: string): void {
        if (!delta) return;
        this.endReasoning();
        if (!this.textId) {
            this.textId = `t${this.seq++}`;
            this.enqueue({ type: "text-start", id: this.textId });
            // Loop joins a step's text blocks back to back; an agent's prose
            // on either side of a tool call would otherwise run together.
            if (this.wroteText && !/^\s/.test(delta)) delta = `\n\n${delta}`;
            this.wroteText = true;
        }
        this.enqueue({ type: "text-delta", id: this.textId, delta });
    }

    reasoning(delta: string): void {
        if (!delta) return;
        this.endText();
        if (!this.reasoningId) {
            this.reasoningId = `r${this.seq++}`;
            this.enqueue({ type: "reasoning-start", id: this.reasoningId });
        }
        this.enqueue({ type: "reasoning-delta", id: this.reasoningId, delta });
    }

    endText(): void {
        if (!this.textId) return;
        this.enqueue({ type: "text-end", id: this.textId });
        this.textId = undefined;
    }

    endReasoning(): void {
        if (!this.reasoningId) return;
        this.enqueue({ type: "reasoning-end", id: this.reasoningId });
        this.reasoningId = undefined;
    }

    endAll(): void {
        this.endText();
        this.endReasoning();
    }

    /** The tool's input started streaming (Claude announces calls early). */
    toolInputStart(id: string, toolName: string): void {
        this.endAll();
        this.startedTools.add(id);
        this.enqueue({ type: "tool-input-start", id, toolName, providerExecuted: true, dynamic: true });
    }

    toolCall(id: string, toolName: string, input: unknown): void {
        this.endAll();
        // Every surface opens a tool's row — and closes the text run before
        // it — on tool-input-start. A call announced only by tool-call would
        // leave that run open, and the agent's next sentence would stream
        // into the paragraph ABOVE the tool until the turn is persisted.
        if (!this.startedTools.has(id)) {
            this.startedTools.add(id);
            this.enqueue({ type: "tool-input-start", id, toolName, providerExecuted: true, dynamic: true });
            this.enqueue({ type: "tool-input-end", id });
        }
        this.enqueue({
            type: "tool-call",
            toolCallId: id,
            toolName,
            input: stringify(input ?? {}),
            providerExecuted: true,
            dynamic: true,
            providerMetadata: this.marker,
        });
    }

    toolResult(id: string, toolName: string, result: unknown, isError: boolean): void {
        this.enqueue({
            type: "tool-result",
            toolCallId: id,
            toolName,
            result: (result ?? "") as NonNullable<JSONValue>,
            ...(isError ? { isError: true } : {}),
            dynamic: true,
            providerMetadata: this.marker,
        });
    }
}

export function makeUsage(u: {
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
    output?: number;
    reasoning?: number;
}): LanguageModelV4Usage {
    const noCache = u.input ?? 0;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    return {
        inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
        outputTokens: { total: u.output, text: undefined, reasoning: u.reasoning },
    };
}

export const EMPTY_USAGE = makeUsage({});

export function finishReason(unified: LanguageModelV4FinishReason["unified"], raw?: string): LanguageModelV4FinishReason {
    return { unified, raw };
}

/**
 * Build a stream result from an async producer. The producer pushes parts;
 * a thrown error becomes an `error` part followed by a finish, so a crashed
 * agent ends the turn cleanly instead of hanging the consumer.
 */
export function streamFrom(
    produce: (enqueue: (part: LanguageModelV4StreamPart) => void) => Promise<void>,
): LanguageModelV4StreamResult {
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
            const enqueue = (part: LanguageModelV4StreamPart) => {
                try {
                    controller.enqueue(part);
                } catch {
                    /* consumer went away */
                }
            };
            enqueue({ type: "stream-start", warnings: [] });
            try {
                await produce(enqueue);
            } catch (error) {
                enqueue({ type: "error", error });
                enqueue({ type: "finish", usage: EMPTY_USAGE, finishReason: finishReason("error") });
            }
            try {
                controller.close();
            } catch {
                /* already closed */
            }
        },
    });
    return { stream };
}

/** doGenerate for agents that only stream: drain the stream into content. */
export async function generateFromStream(result: LanguageModelV4StreamResult): Promise<LanguageModelV4GenerateResult> {
    const content: LanguageModelV4Content[] = [];
    let usage = EMPTY_USAGE;
    let reason = finishReason("other");
    let providerMetadata: LanguageModelV4GenerateResult["providerMetadata"];
    const texts = new Map<string, string>();
    const reasonings = new Map<string, string>();
    const reader = result.stream.getReader();
    for (;;) {
        const { value: part, done } = await reader.read();
        if (done) break;
        switch (part.type) {
            case "text-start":
                texts.set(part.id, "");
                break;
            case "text-delta":
                texts.set(part.id, (texts.get(part.id) ?? "") + part.delta);
                break;
            case "text-end":
                content.push({ type: "text", text: texts.get(part.id) ?? "" });
                break;
            case "reasoning-start":
                reasonings.set(part.id, "");
                break;
            case "reasoning-delta":
                reasonings.set(part.id, (reasonings.get(part.id) ?? "") + part.delta);
                break;
            case "reasoning-end":
                content.push({ type: "reasoning", text: reasonings.get(part.id) ?? "" });
                break;
            case "tool-call":
            case "tool-result":
                content.push(part);
                break;
            case "error":
                throw part.error;
            case "finish":
                usage = part.usage;
                reason = part.finishReason;
                providerMetadata = part.providerMetadata;
                break;
            default:
                break;
        }
    }
    return { content, usage, finishReason: reason, warnings: [], ...(providerMetadata ? { providerMetadata } : {}) };
}

/**
 * Map loop's thinking level (ai-sdk's portable `reasoning` option) onto an
 * ordered list of the levels a model actually offers: an exact match wins,
 * otherwise the nearest level, preferring the stronger one on a tie.
 */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_ORDER)[number];

export function nearestEffort<T extends Effort>(target: Effort, available: readonly T[]): T | undefined {
    if (available.length === 0) return undefined;
    const rank = (e: Effort) => EFFORT_ORDER.indexOf(e);
    let best: T | undefined;
    let bestDist = Infinity;
    for (const e of available) {
        const dist = Math.abs(rank(e) - rank(target));
        if (dist < bestDist || (dist === bestDist && best !== undefined && rank(e) > rank(best))) {
            best = e;
            bestDist = dist;
        }
    }
    return best;
}

/** loop's requested level, or undefined when it expressed no preference. */
export function requestedEffort(options: LanguageModelV4CallOptions): Effort | undefined {
    const r = options.reasoning;
    if (!r || r === "provider-default") return undefined;
    return r;
}

// ---- one process per session ----------------------------------------------

/**
 * Both CLIs hand a prompt for a session that is still live in another process
 * to THAT process: Claude Code continues the running session and answers there,
 * so a turn started while the previous turn's process is still shutting down
 * (a queued message, Esc-then-send) comes back empty while its answer lands in
 * the turn before it. Each new turn therefore waits for the previous process of
 * the same loop session to have actually exited.
 */
const liveTurns = new Map<string, Promise<void>>();

/** Resolves once no earlier process for `key` is still running. */
export async function waitForPreviousTurn(key: string | undefined): Promise<void> {
    if (!key) return;
    await liveTurns.get(key)?.catch(() => {});
}

/** Register a turn's process; `exited` resolves when it is gone for good. */
export function trackTurnProcess(key: string | undefined, exited: Promise<void>): void {
    if (!key) return;
    const tracked = exited.catch(() => {});
    liveTurns.set(key, tracked);
    void tracked.then(() => {
        if (liveTurns.get(key) === tracked) liveTurns.delete(key);
    });
}
