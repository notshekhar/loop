import { spawn, type ChildProcess } from "node:child_process";
import { ensureOwnProcessSweep } from "../../tools/utils/own-processes";

/**
 * A JSON-RPC connection to `codex app-server` — one JSON object per line on
 * stdio. It is what Codex's own apps talk to: unlike `codex exec --json` it
 * streams the reply as it is written and sends approval requests the client
 * answers, which is how loop can ask before Codex runs a command.
 *
 * One connection serves one loop turn and is closed after it.
 */
export type RpcParams = Record<string, unknown>;

export interface CodexRpcHandlers {
    /** A notification from the server (`item/agentMessage/delta`, `turn/completed`, …). */
    onNotification(method: string, params: RpcParams): void;
    /** A request from the server (an approval). Resolve with the result to send back. */
    onRequest(method: string, params: RpcParams): Promise<unknown>;
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

/** JSON-RPC "method not found": what a request loop has no answer for gets. */
const METHOD_NOT_FOUND = -32601;
/** How long `close` waits for the server to exit on its own before killing it. */
const CLOSE_GRACE_MS = 2_000;

export class CodexRpc {
    private readonly child: ChildProcess;
    private readonly pending = new Map<number, Pending>();
    private nextId = 0;
    private buffer = "";
    private stderr = "";
    /** Resolves once the server process is really gone. */
    readonly exited: Promise<void>;

    constructor(binary: string, args: readonly string[], opts: { cwd?: string }, private readonly handlers: CodexRpcHandlers) {
        // Codex runs tools of its own; they must not outlive loop.
        ensureOwnProcessSweep();
        this.child = spawn(binary, ["app-server", ...args], { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
        this.child.stderr?.setEncoding("utf8");
        // Keep only the tail — a chatty server must not grow memory unbounded.
        this.child.stderr?.on("data", (d: string) => (this.stderr = (this.stderr + d).slice(-8_000)));
        this.child.stdout?.setEncoding("utf8");
        this.child.stdout?.on("data", (d: string) => this.onData(d));
        this.child.stdin?.on("error", () => {});
        this.exited = new Promise<void>((resolve) => {
            const done = (reason: string) => {
                this.failPending(new Error(this.stderr.trim() || reason));
                resolve();
            };
            this.child.once("exit", (code) => done(`codex app-server exited with code ${code ?? "?"}`));
            this.child.once("error", (err) => done(err.message));
        });
    }

    request<T = RpcParams>(method: string, params: RpcParams): Promise<T> {
        const id = ++this.nextId;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.write({ id, method, params });
        });
    }

    notify(method: string, params?: RpcParams): void {
        this.write(params ? { method, params } : { method });
    }

    /** Close stdin, give the server a moment to exit, then kill it. */
    async close(): Promise<void> {
        this.child.stdin?.end();
        const kill = setTimeout(() => this.child.kill("SIGKILL"), CLOSE_GRACE_MS);
        if (this.child.exitCode === null) this.child.kill("SIGTERM");
        await this.exited;
        clearTimeout(kill);
    }

    private write(message: RpcParams): void {
        try {
            this.child.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch {
            /* the process is gone; `exited` fails what is pending */
        }
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line.startsWith("{")) this.dispatch(line);
        }
    }

    private dispatch(line: string): void {
        let msg: { id?: number; method?: string; params?: RpcParams; result?: unknown; error?: { message?: string } };
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (msg.method && msg.id !== undefined) void this.answer(msg.id, msg.method, msg.params ?? {});
        else if (msg.method) this.handlers.onNotification(msg.method, msg.params ?? {});
        else if (msg.id !== undefined) this.settle(msg.id, msg);
    }

    private settle(id: number, msg: { result?: unknown; error?: { message?: string } }): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (msg.error) pending.reject(new Error(msg.error.message ?? "codex app-server request failed"));
        else pending.resolve(msg.result);
    }

    private async answer(id: number, method: string, params: RpcParams): Promise<void> {
        try {
            this.write({ id, result: await this.handlers.onRequest(method, params) });
        } catch (err) {
            this.write({ id, error: { code: METHOD_NOT_FOUND, message: err instanceof Error ? err.message : String(err) } });
        }
    }

    private failPending(error: Error): void {
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
    }
}
