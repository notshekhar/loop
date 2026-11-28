/**
 * The chat-import extension's readers, each against a fake home holding that
 * agent's real on-disk format — never the user's own chats.
 *
 * What they all owe loop is the same: this folder's chats and no other
 * folder's, only what the person typed as prompts, every tool call answered
 * exactly once (a provider rejects anything else when the chat is
 * continued), and the agent's files left exactly as they were.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../src/types";
import { claudeCodeSource, claudeProjectFolder } from "../src/extensions/builtin/chat-import/claude-code";
import { codexSource } from "../src/extensions/builtin/chat-import/codex";
import { cursorFolderHash, rootMessageIds } from "../src/extensions/builtin/chat-import/cursor-cli";
import { cursorUserDir } from "../src/extensions/builtin/chat-import/cursor-ide";
import { cursorSource } from "../src/extensions/builtin/chat-import/cursor";
import { withForeignSqlite } from "../src/extensions/builtin/chat-import/files";
import { TranscriptBuilder } from "../src/extensions/builtin/chat-import/transcript";
import { userPrompt } from "../src/extensions/builtin/chat-import/user-text";

const CWD = "/work/my.app";
const OTHER = "/work/other";
let home = "";

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "chat-import-home-"));
});
afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

const roots = () => ({ home });
const lines = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

type Part = { type: string; toolCallId?: string; toolName?: string; input?: unknown; text?: string; output?: { type: string; value: string } };
const partsOf = (e: Entry) => (e.type === "message" && Array.isArray(e.content) ? (e.content as Part[]) : []);
const roles = (entries: Entry[]) => entries.map((e) => (e.type === "message" ? e.role : e.type));

/** Every tool call has exactly one result, in the tool message right after its assistant message. */
function expectEveryCallAnswered(entries: Entry[]): void {
    entries.forEach((e, i) => {
        const calls = partsOf(e).filter((p) => p.type === "tool-call");
        if (calls.length === 0) return;
        const next = entries[i + 1];
        expect(next?.type === "message" && next.role).toBe("tool");
        const answered = partsOf(next!).map((p) => p.toolCallId);
        expect(answered.sort()).toEqual(calls.map((c) => c.toolCallId).sort());
    });
}

/** A file's bytes and mtime, to prove a reader never wrote to it. */
const fingerprint = (path: string) => `${statSync(path).mtimeMs}:${readFileSync(path).toString("base64")}`;

describe("transcript rules", () => {
    test("a call that lost its result gets a placeholder, a result for no call is dropped", () => {
        const b = new TranscriptBuilder();
        b.user("go");
        b.toolCall("a", "bash", { command: "ls" });
        b.toolCall("b", "bash", { command: "pwd" });
        b.toolResult("a", "files", false);
        b.toolResult("ghost", "nobody asked", false);
        b.text("done");
        const entries = b.build();
        expect(roles(entries)).toEqual(["user", "assistant", "tool", "assistant"]);
        expectEveryCallAnswered(entries);
        const lost = partsOf(entries[2]).find((p) => p.toolCallId === "b");
        expect(lost?.output?.type).toBe("error-text");
        expect(JSON.stringify(entries)).not.toContain("nobody asked");
    });

    test("streamed text pieces join into one block", () => {
        const b = new TranscriptBuilder();
        b.user("hi");
        b.text("Hel");
        b.text("lo");
        expect(partsOf(b.build()[1])).toEqual([{ type: "text", text: "Hello" }]);
    });
});

describe("what counts as the person's prompt", () => {
    test("Cursor's wrapper is unwrapped, its context dropped", () => {
        expect(userPrompt("<timestamp>Mon</timestamp>\n<user_query>\nfix it\n</user_query>")).toBe("fix it");
    });

    test("a turn made only of tag blocks is context, whatever the tags are called", () => {
        expect(userPrompt("<agent_skills>…</agent_skills>\n<brand_new_tag a=1>x</brand_new_tag>")).toBe("");
        expect(userPrompt("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>")).toBe("");
    });

    test("a reminder beside a real prompt is cut, the prompt kept", () => {
        expect(userPrompt("<system-reminder>be nice</system-reminder>\nwhy is it slow?")).toBe("why is it slow?");
    });

    test("slash-command echoes and AGENTS.md dumps are not prompts", () => {
        expect(userPrompt("<command-name>/clear</command-name>")).toBe("");
        expect(userPrompt("# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>…</INSTRUCTIONS>")).toBe("");
    });

    test("text that merely mentions a tag is still the person's", () => {
        expect(userPrompt("what does <div> do here?")).toBe("what does <div> do here?");
    });
});

describe("Claude Code", () => {
    function writeChat(cwd: string, id: string, records: unknown[]): string {
        const dir = join(home, ".claude", "projects", claudeProjectFolder(cwd));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${id}.jsonl`);
        writeFileSync(path, lines(records));
        return path;
    }

    const rec = (uuid: string, parentUuid: string | null, type: string, content: unknown, extra = {}) => ({
        uuid,
        parentUuid,
        type,
        timestamp: "2026-11-01T10:00:00.000Z",
        message: { role: type, content },
        ...extra,
    });

    const CHAT = [
        rec("u0", null, "user", "<command-name>/clear</command-name>"),
        rec("u1", "u0", "user", "<system-reminder>ctx</system-reminder>\nwhat is in here?"),
        rec("a1", "u1", "assistant", [{ type: "thinking", thinking: "look first" }]),
        rec("a2", "a1", "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
        rec("a3", "a2", "assistant", [
            { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
        ]),
        rec("r1", "a3", "user", [
            { type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts" },
            { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "edited" }], is_error: false },
        ]),
        // A rewound branch: written, then abandoned for u2.
        rec("dead", "r1", "user", "this branch was rewound"),
        rec("u2", "r1", "user", "now explain"),
        rec("a4", "u2", "assistant", [{ type: "text", text: "Two files." }]),
        { type: "ai-title", aiTitle: "Files in the app" },
        rec("side", "a4", "assistant", [{ type: "text", text: "subagent chatter" }], { isSidechain: true }),
    ];

    test("lists this folder's chats only, titled by Claude Code's own title", () => {
        writeChat(CWD, "aaaa-1111", CHAT);
        writeChat(OTHER, "bbbb-2222", CHAT);
        const list = claudeCodeSource(roots()).list(CWD);
        expect(list.map((c) => c.id)).toEqual(["aaaa-1111"]);
        expect(list[0].title).toBe("Files in the app");
    });

    test("imports the live branch as loop's own tools, every call answered", () => {
        writeChat(CWD, "aaaa-1111", CHAT);
        const chat = claudeCodeSource(roots()).load("aaaa", CWD)!; // a prefix is enough
        expect(chat.id).toBe("aaaa-1111");
        expect(roles(chat.entries)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
        expect(chat.entries[0].type === "message" && chat.entries[0].content).toBe("what is in here?");
        const calls = partsOf(chat.entries[1]).filter((p) => p.type === "tool-call");
        expect(calls.map((c) => [c.toolName, c.input])).toEqual([
            ["bash", { command: "ls" }],
            ["edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }],
        ]);
        expect(partsOf(chat.entries[1])[0]).toEqual({ type: "reasoning", text: "look first" });
        expectEveryCallAnswered(chat.entries);
        const text = JSON.stringify(chat.entries);
        expect(text).not.toContain("rewound");
        expect(text).not.toContain("subagent chatter");
        expect(text).not.toContain("system-reminder");
    });

    test("an id from another folder still opens", () => {
        writeChat(OTHER, "cccc-3333", CHAT);
        expect(claudeCodeSource(roots()).load("cccc-3333", CWD)?.id).toBe("cccc-3333");
    });

    test("reading leaves the transcript untouched", () => {
        const path = writeChat(CWD, "aaaa-1111", CHAT);
        const before = fingerprint(path);
        claudeCodeSource(roots()).list(CWD);
        claudeCodeSource(roots()).load("aaaa-1111", CWD);
        expect(fingerprint(path)).toBe(before);
    });
});

describe("Codex", () => {
    function writeRollout(cwd: string, id: string, items: unknown[]): string {
        const dir = join(home, ".codex", "sessions", "2026", "11", "01");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `rollout-2026-11-01T10-00-00-${id}.jsonl`);
        const records = [
            { type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id, cwd } },
            ...items.map((payload) => ({ type: "response_item", timestamp: "2026-11-01T10:00:01Z", payload })),
            { type: "event_msg", payload: { type: "token_count" } },
        ];
        writeFileSync(path, lines(records));
        return path;
    }

    const userMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    const ITEMS = [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "you are codex" }] },
        userMsg("<environment_context>\n  <cwd>/work/my.app</cwd>\n</environment_context>"),
        userMsg("count the files"),
        { type: "reasoning", summary: [{ type: "summary_text", text: "use ls" }], encrypted_content: "zzz" },
        {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "ls | wc -l" }),
            call_id: "c1",
        },
        { type: "function_call_output", call_id: "c1", output: "3" },
        { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch", call_id: "c2" },
        { type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: "Done!" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "There are 3." }] },
    ];

    test("finds chats by the folder in their session_meta, not by date", () => {
        writeRollout(CWD, "019f-aaaa", ITEMS);
        writeRollout(OTHER, "019f-bbbb", ITEMS);
        const list = codexSource(roots()).list(CWD);
        expect(list.map((c) => [c.id, c.title])).toEqual([["019f-aaaa", "count the files"]]);
    });

    test("imports prompts, reasoning summaries and calls; drops injected context", () => {
        writeRollout(CWD, "019f-aaaa", ITEMS);
        const chat = codexSource(roots()).load("019f-aaaa", CWD)!;
        expect(roles(chat.entries)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
        expect(partsOf(chat.entries[1])).toEqual([
            { type: "reasoning", text: "use ls" },
            { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls | wc -l" } },
        ]);
        expect(partsOf(chat.entries[4])[0].output?.value).toBe("Done!");
        expectEveryCallAnswered(chat.entries);
        expect(JSON.stringify(chat.entries)).not.toContain("environment_context");
        expect(JSON.stringify(chat.entries)).not.toContain("you are codex");
    });
});

describe("Cursor", () => {
    /** A protobuf with `ids` as repeated field 1, plus a varint field to skip. */
    function rootBlob(ids: string[]): Buffer {
        const parts: Buffer[] = [Buffer.from([0x50, 0x01])]; // field 10, varint 1 — ignored
        for (const id of ids) {
            const bytes = Buffer.from(id, "hex");
            parts.push(Buffer.from([0x0a, bytes.length]), bytes);
        }
        return Buffer.concat(parts);
    }

    const hexId = (n: number) => n.toString(16).padStart(64, "0");

    function writeCliChat(cwd: string, chatId: string, messages: unknown[]): string {
        const dir = join(home, ".cursor", "chats", cursorFolderHash(cwd), chatId);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "store.db");
        const db = new Database(path);
        db.run("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
        db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
        const ids = messages.map((m, i) => {
            const id = hexId(i + 1);
            db.run("INSERT INTO blobs VALUES (?, ?)", [id, Buffer.from(JSON.stringify(m))]);
            return id;
        });
        const rootId = hexId(999);
        db.run("INSERT INTO blobs VALUES (?, ?)", [rootId, rootBlob(ids)]);
        const meta = { name: "Cursor CLI chat", createdAt: 1, latestRootBlobId: rootId };
        db.run("INSERT INTO meta VALUES ('0', ?)", [Buffer.from(JSON.stringify(meta)).toString("hex")]);
        db.close();
        return path;
    }

    function writeIdeChat(cwd: string, chatId: string): string {
        const dir = join(cursorUserDir(home), "globalStorage");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "state.vscdb");
        const db = new Database(path);
        db.run("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
        const bubbles = [
            { id: "b1", type: 1, text: "rename the button" },
            { id: "b2", type: 2, thinking: { text: "find it" }, text: "" },
            {
                id: "b3",
                type: 2,
                toolFormerData: {
                    toolCallId: "tc1",
                    name: "read_file_v2",
                    params: JSON.stringify({ targetFile: "/work/my.app/button.tsx" }),
                    result: JSON.stringify({ contents: "export const Button" }),
                    status: "completed",
                },
            },
            { id: "b4", type: 2, text: "Renamed." },
        ];
        const composer = {
            composerId: chatId,
            name: "Rename button",
            lastUpdatedAt: 1700000000000,
            workspaceIdentifier: { uri: { fsPath: cwd } },
            fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.id, type: b.type })),
        };
        db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [`composerData:${chatId}`, JSON.stringify(composer)]);
        for (const b of bubbles) db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [`bubbleId:${chatId}:${b.id}`, JSON.stringify(b)]);
        db.close();
        return path;
    }

    const CLI_MESSAGES = [
        { role: "system", content: "You are Cursor" },
        { role: "user", content: "<user_info>\nOS: darwin\n</user_info>" },
        { role: "user", content: [{ type: "text", text: "<timestamp>now</timestamp>\n<user_query>\nwhat is this?\n</user_query>" }] },
        {
            role: "assistant",
            content: [
                { type: "reasoning", text: "look" },
                { type: "tool-call", toolCallId: "k1", toolName: "Glob", args: { glob_pattern: "*.ts", target_directory: "/w" } },
            ],
        },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "k1", toolName: "Glob", result: "a.ts" }] },
        { role: "assistant", content: [{ type: "text", text: "A TypeScript app." }] },
    ];

    test("reads field 1 of the root protobuf, in order, skipping other fields", () => {
        expect(rootMessageIds(rootBlob([hexId(1), hexId(2)]))).toEqual([hexId(1), hexId(2)]);
    });

    test("lists CLI and IDE chats of this folder together, each saying which", () => {
        writeCliChat(CWD, "cli-chat-1", CLI_MESSAGES);
        writeCliChat(OTHER, "cli-chat-2", CLI_MESSAGES);
        writeIdeChat(CWD, "ide-chat-1");
        writeIdeChat(OTHER, "ide-chat-2");
        const list = cursorSource(roots()).list(CWD);
        expect(list.map((c) => [c.id, c.origin]).sort()).toEqual([
            ["cli-chat-1", "CLI"],
            ["ide-chat-1", "IDE"],
        ]);
    });

    test("a CLI chat imports through its root, the query unwrapped", () => {
        writeCliChat(CWD, "cli-chat-1", CLI_MESSAGES);
        const chat = cursorSource(roots()).load("cli-chat-1", CWD)!;
        expect(chat.title).toBe("Cursor CLI chat");
        expect(roles(chat.entries)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(chat.entries[0].type === "message" && chat.entries[0].content).toBe("what is this?");
        expect(partsOf(chat.entries[1])[1]).toEqual({
            type: "tool-call",
            toolCallId: "k1",
            toolName: "find",
            input: { pattern: "*.ts", path: "/w" },
        });
        expectEveryCallAnswered(chat.entries);
    });

    test("an IDE chat imports bubble by bubble", () => {
        writeIdeChat(CWD, "ide-chat-1");
        const chat = cursorSource(roots()).load("ide-chat-1", CWD)!;
        expect(chat.title).toBe("Rename button");
        expect(roles(chat.entries)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(partsOf(chat.entries[1]).map((p) => p.type)).toEqual(["reasoning", "tool-call"]);
        expect(partsOf(chat.entries[1])[1].input).toEqual({ path: "/work/my.app/button.tsx" });
        expect(partsOf(chat.entries[2])[0].output?.value).toBe("export const Button");
    });

    test("reading leaves Cursor's databases untouched", () => {
        const cli = writeCliChat(CWD, "cli-chat-1", CLI_MESSAGES);
        const ide = writeIdeChat(CWD, "ide-chat-1");
        const before = [fingerprint(cli), fingerprint(ide)];
        cursorSource(roots()).list(CWD);
        cursorSource(roots()).load("cli-chat-1", CWD);
        cursorSource(roots()).load("ide-chat-1", CWD);
        expect([fingerprint(cli), fingerprint(ide)]).toEqual(before);
    });
});

describe("other programs' databases", () => {
    test("a WAL database reads with its newest rows, and gains no -shm beside it", () => {
        // How Cursor leaves its stores: the newest writes still in the WAL and
        // no -shm. A read-only open would fail, or create one in Cursor's folder.
        const live = join(home, "live");
        mkdirSync(live);
        const writer = new Database(join(live, "chat.db"));
        writer.run("PRAGMA journal_mode = WAL");
        writer.run("PRAGMA wal_autocheckpoint = 0");
        writer.run("CREATE TABLE t (v TEXT)");
        writer.run("INSERT INTO t VALUES ('in the wal')");
        const left = join(home, "left");
        mkdirSync(left);
        copyFileSync(join(live, "chat.db"), join(left, "chat.db"));
        copyFileSync(join(live, "chat.db-wal"), join(left, "chat.db-wal"));
        writer.close();
        expect(existsSync(join(left, "chat.db-shm"))).toBe(false);

        const path = join(left, "chat.db");
        const before = [fingerprint(path), fingerprint(`${path}-wal`)];
        const rows = withForeignSqlite(path, (db) => db.query<{ v: string }>("SELECT v FROM t").all());
        expect(rows).toEqual([{ v: "in the wal" }]);
        expect([fingerprint(path), fingerprint(`${path}-wal`)]).toEqual(before);
        expect(existsSync(join(left, "chat.db-shm"))).toBe(false);
    });
});
