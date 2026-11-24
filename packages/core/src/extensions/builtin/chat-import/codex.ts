/**
 * Codex chats: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
 *
 * The first record is `session_meta`, which carries the chat's id and working
 * directory — the only way to know which folder a chat belongs to, since the
 * files are filed by date. The conversation is the `response_item` records,
 * which are the Responses API's own items: messages, reasoning, function and
 * custom tool calls and their outputs. Everything else (`event_msg`,
 * `turn_context`, token counts) is the UI's bookkeeping.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonl, readJsonlHead } from "./files";
import { type ChatSource, type ChatSummary, type ImportedChat, matchId, type SourceRoots, titleFrom } from "./source";
import { outputText, parseJsonish, translateToolCall } from "./tool-calls";
import { parseTimestamp, TranscriptBuilder } from "./transcript";
import { userPrompt } from "./user-text";

interface CodexItem {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }> | null;
    summary?: Array<{ type?: string; text?: string }>;
    name?: string;
    arguments?: string;
    input?: string;
    call_id?: string;
    output?: unknown;
    action?: { command?: unknown };
    id?: string;
    cwd?: string;
}

interface CodexRecord {
    type?: string;
    timestamp?: string;
    payload?: CodexItem;
}

interface CodexFile {
    id: string;
    path: string;
    cwd: string;
}

export function codexSource(roots: SourceRoots): ChatSource {
    const sessions = join(roots.home, ".codex", "sessions");
    const files = () => rolloutFiles(sessions).flatMap(describe);
    const inFolder = (cwd: string) => files().filter((f) => samePath(f.cwd, cwd));
    return {
        label: "Codex",
        list: (cwd) =>
            inFolder(cwd)
                .flatMap(summarize)
                .sort((a, b) => b.updatedAt - a.updatedAt),
        load(id, cwd) {
            const file = matchId(inFolder(cwd), id) ?? matchId(files(), id);
            return file ? readChat(file) : undefined;
        },
    };
}

function samePath(a: string, b: string): boolean {
    return resolve(a) === resolve(b);
}

/** Every rollout file under the dated folders. */
function rolloutFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".jsonl") && f.split(/[\\/]/).at(-1)!.startsWith("rollout-"))
        .map((f) => join(dir, f));
}

/** A rollout's id and folder, from its `session_meta`; nothing for a file without one. */
function describe(path: string): CodexFile[] {
    const meta = (readJsonlHead(path, 64 * 1024) as CodexRecord[]).find((r) => r.type === "session_meta")?.payload;
    if (!meta?.id || !meta.cwd) return [];
    return [{ id: meta.id, path, cwd: meta.cwd }];
}

function summarize(file: CodexFile): ChatSummary[] {
    const prompt = (readJsonlHead(file.path) as CodexRecord[]).map(promptOf).find(Boolean);
    if (!prompt) return [];
    return [{ id: file.id, title: titleFrom(prompt), updatedAt: statSync(file.path).mtimeMs }];
}

function promptOf(record: CodexRecord): string {
    const item = record.payload;
    if (record.type !== "response_item" || item?.type !== "message" || item.role !== "user") return "";
    return (item.content ?? [])
        .map((part) => userPrompt(part.text ?? ""))
        .filter(Boolean)
        .join("\n\n");
}

function readChat(file: CodexFile): ImportedChat {
    const records = readJsonl(file.path) as CodexRecord[];
    const builder = new TranscriptBuilder();
    for (const record of records) {
        if (record.type === "response_item" && record.payload) {
            addItem(builder, record.payload, record, parseTimestamp(record.timestamp));
        }
    }
    return { id: file.id, title: titleFrom(records.map(promptOf).find(Boolean)), entries: builder.build() };
}

function addItem(builder: TranscriptBuilder, item: CodexItem, record: CodexRecord, ts?: number): void {
    switch (item.type) {
        case "message":
            if (item.role === "user") builder.user(promptOf(record), ts);
            else if (item.role === "assistant") builder.text(textOf(item.content), ts);
            return;
        case "reasoning":
            builder.reasoning(textOf(item.summary) || textOf(item.content), ts);
            return;
        case "function_call":
            return addCall(builder, item.call_id, item.name, parseJsonish(item.arguments), ts);
        case "custom_tool_call":
            return addCall(builder, item.call_id, item.name, { input: item.input }, ts);
        case "local_shell_call":
            return addCall(builder, item.call_id, "shell", { command: item.action?.command }, ts);
        case "function_call_output":
        case "custom_tool_call_output":
        case "local_shell_call_output":
            if (item.call_id) builder.toolResult(item.call_id, resultText(item.output), false, ts);
            return;
    }
}

function addCall(builder: TranscriptBuilder, callId: string | undefined, name: string | undefined, input: unknown, ts?: number) {
    if (!callId || !name) return;
    const call = translateToolCall(name, input);
    builder.toolCall(callId, call.toolName, call.input, ts);
}

function textOf(parts: CodexItem["content"] | CodexItem["summary"]): string {
    return (parts ?? []).map((p) => p.text ?? "").join("");
}

/** Older Codex wrapped a command's output as `{"output": "...", "metadata": {...}}`. */
function resultText(output: unknown): string {
    const parsed = parseJsonish(output);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "output" in parsed) {
        return outputText((parsed as { output: unknown }).output);
    }
    return outputText(parsed);
}
