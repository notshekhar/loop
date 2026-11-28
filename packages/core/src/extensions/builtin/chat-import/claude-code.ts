/**
 * Claude Code chats: `~/.claude/projects/<folder>/<session id>.jsonl`, where
 * `<folder>` is the working directory with every non-alphanumeric character
 * turned into `-`.
 *
 * Each line is one record. The conversation is the `user` / `assistant`
 * records; one assistant message is split across several records (one per
 * content block), and the rest — attachments, file snapshots, titles, hooks —
 * is bookkeeping. Records form a tree through `parentUuid` (a rewind starts a
 * branch), so the chat is the path from the newest record back to the root;
 * across a compaction the link is `logicalParentUuid` instead.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readJsonl, readJsonlHead } from "./files";
import { type ChatSource, type ChatSummary, type ImportedChat, matchId, type SourceRoots, titleFrom } from "./source";
import { outputText, translateToolCall } from "./tool-calls";
import { parseTimestamp, TranscriptBuilder } from "./transcript";
import { claudeCalls, type ImportedCall } from "./usage";
import { userPrompt } from "./user-text";

interface ClaudeBlock {
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
}

interface ClaudeRecord {
    type?: string;
    uuid?: string;
    parentUuid?: string | null;
    logicalParentUuid?: string | null;
    isSidechain?: boolean;
    isMeta?: boolean;
    isCompactSummary?: boolean;
    timestamp?: string;
    aiTitle?: string;
    message?: { role?: string; content?: string | ClaudeBlock[] };
}

/** `/Users/me/my.app` → `-Users-me-my-app`, Claude Code's folder name for a working directory. */
export function claudeProjectFolder(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeCodeSource(roots: SourceRoots): ChatSource {
    const projects = join(roots.home, ".claude", "projects");
    const dirOf = (cwd: string) => join(projects, claudeProjectFolder(cwd));
    return {
        id: "claude-code",
        label: "Claude Code",
        pricing: { agent: "claude-code", vendor: "anthropic" },
        list: (cwd) => listIn(dirOf(cwd)),
        load(id, cwd) {
            const path = findChat(dirOf(cwd), id) ?? findAnywhere(projects, id);
            return path ? readChat(path) : undefined;
        },
    };
}

function chatFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(dir, f));
}

function listIn(dir: string): ChatSummary[] {
    return chatFiles(dir)
        .flatMap((path) => {
            const summary = summarize(path);
            return summary ? [summary] : [];
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A picker row from the head of the file; undefined for a file with no prompt in it (a bare /clear). */
function summarize(path: string): ChatSummary | undefined {
    const records = readJsonlHead(path) as ClaudeRecord[];
    const prompt = records.map(promptOf).find(Boolean);
    if (!prompt) return undefined;
    const title = records.findLast((r) => r.type === "ai-title" && r.aiTitle)?.aiTitle;
    return { id: basename(path, ".jsonl"), title: titleFrom(title ?? prompt), updatedAt: statSync(path).mtimeMs };
}

function findChat(dir: string, id: string): string | undefined {
    const files = chatFiles(dir).map((path) => ({ id: basename(path, ".jsonl"), path }));
    return matchId(files, id)?.path;
}

function findAnywhere(projects: string, id: string): string | undefined {
    if (!existsSync(projects)) return undefined;
    for (const folder of readdirSync(projects)) {
        const path = join(projects, folder, `${id}.jsonl`);
        if (existsSync(path)) return path;
    }
    return undefined;
}

function readChat(path: string): ImportedChat {
    const records = readJsonl(path) as ClaudeRecord[];
    const builder = new TranscriptBuilder();
    for (const record of mainBranch(records)) addRecord(builder, record);
    const title = records.findLast((r) => r.type === "ai-title" && r.aiTitle)?.aiTitle;
    return {
        id: basename(path, ".jsonl"),
        title: titleFrom(title ?? records.map(promptOf).find(Boolean)),
        entries: builder.build(),
        calls: [...claudeCalls(records), ...subagentCalls(path)],
    };
}

/** Subagents (Task) keep their own transcripts beside the chat — their calls were paid for too. */
function subagentCalls(chatPath: string): ImportedCall[] {
    const dir = join(dirname(chatPath), basename(chatPath, ".jsonl"), "subagents");
    return chatFiles(dir).flatMap((path) => claudeCalls(readJsonl(path)));
}

const isConversation = (r: ClaudeRecord) =>
    (r.type === "user" || r.type === "assistant") && !r.isSidechain && !r.isMeta && !r.isCompactSummary;

/** The path from the newest conversation record back to the root, oldest first. */
function mainBranch(records: readonly ClaudeRecord[]): ClaudeRecord[] {
    const byId = new Map(records.filter((r) => r.uuid).map((r) => [r.uuid!, r]));
    const leaf = records.findLast((r) => isConversation(r) && r.uuid);
    const path: ClaudeRecord[] = [];
    const seen = new Set<string>();
    for (let at = leaf; at?.uuid && !seen.has(at.uuid); ) {
        seen.add(at.uuid);
        path.push(at);
        const parent = at.parentUuid ?? at.logicalParentUuid;
        at = parent ? byId.get(parent) : undefined;
    }
    return path.reverse().filter(isConversation);
}

function promptOf(record: ClaudeRecord): string {
    if (record.type !== "user" || !isConversation(record)) return "";
    const content = record.message?.content;
    if (typeof content === "string") return userPrompt(content);
    return userPrompt((content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n"));
}

function addRecord(builder: TranscriptBuilder, record: ClaudeRecord): void {
    const ts = parseTimestamp(record.timestamp);
    const content = record.message?.content;
    if (record.type === "user") {
        if (typeof content === "string") return builder.user(userPrompt(content), ts);
        addUserBlocks(builder, content ?? [], ts);
        return;
    }
    for (const block of typeof content === "string" ? [{ type: "text", text: content }] : (content ?? [])) {
        addAssistantBlock(builder, block, ts);
    }
}

/** A user record: the results it carries back, then whatever the person wrote as one prompt. */
function addUserBlocks(builder: TranscriptBuilder, blocks: readonly ClaudeBlock[], ts?: number): void {
    const written: string[] = [];
    for (const block of blocks) {
        if (block.type === "tool_result" && block.tool_use_id) {
            builder.toolResult(block.tool_use_id, outputText(block.content), block.is_error === true, ts);
        } else if (block.type === "text") {
            written.push(userPrompt(block.text ?? ""));
        } else if (block.type === "image") {
            written.push("[image]");
        }
    }
    builder.user(written.filter(Boolean).join("\n\n"), ts);
}

function addAssistantBlock(builder: TranscriptBuilder, block: ClaudeBlock, ts?: number): void {
    if (block.type === "text") builder.text(block.text ?? "", ts);
    else if (block.type === "thinking") builder.reasoning(block.thinking ?? "", ts);
    else if (block.type === "tool_use" && block.id && block.name) {
        const call = translateToolCall(block.name, block.input);
        builder.toolCall(block.id, call.toolName, call.input, ts);
    }
}
