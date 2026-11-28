#!/usr/bin/env bun
/**
 * A stand-in for `codex app-server`, speaking the same newline-delimited
 * JSON-RPC (shapes taken from codex-cli 0.153's live output). Every request it
 * receives is appended to $FAKE_CODEX_LOG so a test can assert what loop sent.
 *
 * Behaviour, keyed off the user's text:
 * - always: streams "hel" + "lo" as one agent message, reports token usage;
 * - "run <cmd>": first asks approval for <cmd>, then reports the command as
 *   completed or declined per loop's answer;
 * - "wait": never finishes on its own — only turn/interrupt ends the turn.
 * `thread/resume` fails for any id but "thread-live".
 */
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_CODEX_LOG;
const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method: string, params: Record<string, unknown>) => send({ method, params });
const pendingAnswers = new Map<number, (result: unknown) => void>();
let serverRequestId = 1000;
const THREAD = "thread-new";

function ask(method: string, params: unknown): Promise<unknown> {
    const id = ++serverRequestId;
    send({ id, method, params });
    return new Promise((resolve) => pendingAnswers.set(id, resolve));
}

async function runTurn(threadId: string, turnId: string, text: string): Promise<void> {
    const base = { threadId, turnId };
    const run = /^run (.+)$/m.exec(text);
    if (run) {
        // Real Codex asks about the shell wrapper, not the bare command.
        const answer = (await ask("item/commandExecution/requestApproval", { ...base, itemId: "cmd1", command: `/bin/zsh -lc '${run[1]}'` })) as {
            decision?: string;
        };
        const status = answer.decision === "accept" ? "completed" : "declined";
        notify("item/completed", { ...base, item: { type: "commandExecution", id: "cmd1", command: run[1], status, aggregatedOutput: "", exitCode: status === "completed" ? 0 : null } });
    }
    if (/\bwait\b/.test(text)) return; // only an interrupt ends this turn
    notify("item/started", { ...base, item: { type: "agentMessage", id: "msg1", text: "" } });
    notify("item/agentMessage/delta", { ...base, itemId: "msg1", delta: "hel" });
    notify("item/agentMessage/delta", { ...base, itemId: "msg1", delta: "lo" });
    notify("item/completed", { ...base, item: { type: "agentMessage", id: "msg1", text: "hello" } });
    const call = { totalTokens: 0, inputTokens: 1200, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10 };
    notify("thread/tokenUsage/updated", { ...base, tokenUsage: { last: call, total: { ...call, outputTokens: 530, reasoningOutputTokens: 110 }, modelContextWindow: null } });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null, items: [] } });
}

function handle(msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }): void {
    if (msg.method === undefined && msg.id !== undefined) {
        pendingAnswers.get(msg.id)?.(msg.result);
        return;
    }
    if (log) appendFileSync(log, `${JSON.stringify({ method: msg.method, params: msg.params })}\n`);
    const p = msg.params ?? {};
    switch (msg.method) {
        case "initialize":
            return send({ id: msg.id, result: { userAgent: "fake" } });
        case "thread/start":
            return send({ id: msg.id, result: { thread: { id: THREAD } } });
        case "thread/resume":
            if (p.threadId === "thread-live") return send({ id: msg.id, result: { thread: { id: "thread-live" } } });
            return send({ id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${String(p.threadId)}` } });
        case "turn/start": {
            const text = ((p.input as Array<{ type: string; text?: string }>) ?? []).map((i) => i.text ?? "").join("\n");
            send({ id: msg.id, result: { turn: { id: "turn1", status: "inProgress" } } });
            void runTurn(String(p.threadId), "turn1", text);
            return;
        }
        case "turn/interrupt":
            send({ id: msg.id, result: {} });
            notify("turn/completed", { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted", error: null, items: [] } });
            return;
        default:
            if (msg.id !== undefined) send({ id: msg.id, result: {} });
    }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(JSON.parse(line));
    }
});
process.stdin.on("end", () => process.exit(0));
