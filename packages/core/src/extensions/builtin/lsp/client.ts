/**
 * A single language-server process driven over stdio with LSP's JSON-RPC framing
 * (`Content-Length: N\r\n\r\n<json>`). LSP is push-based (the server emits
 * `publishDiagnostics` whenever it finishes analyzing a document); we correlate
 * responses by id and buffer the latest diagnostics per URI so callers can await
 * fresh results after an edit.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ensureOwnProcessSweep } from "../../../tools/utils/own-processes";
import { readFile } from "node:fs/promises";
import { type Diagnostic, type JsonRpcMessage, type PublishDiagnosticsParams, pathToUri } from "./protocol";

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}

/** Two servers (or push + pull) can report the same problem; show it once. */
function dedupeDiagnostics(list: Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();
    const out: Diagnostic[] = [];
    for (const d of list) {
        const key = `${d.severity ?? 1}|${d.range.start.line}|${d.range.start.character}|${d.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(d);
    }
    return out;
}

interface DiagnosticsWaiter {
    resolve: () => void;
}

export interface LspServerSpec {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    languageId: (absPath: string) => string;
}

export class LspClient {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly diagnostics = new Map<string, Diagnostic[]>();
    private readonly waiters = new Map<string, DiagnosticsWaiter[]>();
    private readonly openDocs = new Map<string, number>();
    private initialized = false;
    private crashed = false;
    /** `capabilities` from the initialize result — decides what we may ask for. */
    private capabilities: Record<string, unknown> = {};

    constructor(
        private readonly spec: LspServerSpec,
        private readonly rootPath: string,
    ) {}

    get isAlive(): boolean {
        return this.proc !== null && !this.crashed;
    }

    async start(): Promise<void> {
        if (this.proc) return;
        // Several servers run their real work in a child of their own (tsserver
        // under typescript-language-server); kill() only reaches the parent.
        ensureOwnProcessSweep();
        const proc = spawn(this.spec.command, this.spec.args, {
            cwd: this.rootPath,
            stdio: ["pipe", "pipe", "pipe"],
            env: this.spec.env ? { ...process.env, ...this.spec.env } : process.env,
        });
        this.proc = proc;
        proc.on("error", () => {
            this.crashed = true;
        });
        proc.on("exit", () => {
            this.crashed = true;
            this.proc = null;
            for (const [, p] of this.pending) p.reject(new Error("language server exited"));
            this.pending.clear();
        });
        proc.stderr.on("data", () => {});
        proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));

        // Declare the navigation features the `lsp` tool exposes, not just
        // document sync — a server only answers what the client asked for.
        const result = (await this.request("initialize", {
            processId: process.pid,
            rootUri: pathToUri(this.rootPath),
            workspaceFolders: [{ uri: pathToUri(this.rootPath), name: this.spec.name }],
            capabilities: {
                textDocument: {
                    synchronization: { didSave: true, dynamicRegistration: false },
                    publishDiagnostics: { relatedInformation: false },
                    definition: { linkSupport: true },
                    implementation: { linkSupport: true },
                    references: {},
                    hover: { contentFormat: ["plaintext", "markdown"] },
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    callHierarchy: {},
                },
                workspace: { symbol: {}, workspaceFolders: true },
            },
        })) as { capabilities?: Record<string, unknown> };
        this.capabilities = result?.capabilities ?? {};
        this.notify("initialized", {});
        this.initialized = true;
    }

    /** Whether the server advertised a capability, e.g. `hoverProvider`. */
    supports(capability: string): boolean {
        const value = this.capabilities[capability];
        return value !== undefined && value !== false && value !== null;
    }

    /**
     * Make the server aware of a file's current content — required before any
     * position request, since a server only answers about open documents.
     * Reads from disk when no content is supplied.
     */
    async openDocument(absPath: string, content?: string): Promise<void> {
        if (!this.isAlive) return;
        const text = content ?? (await readFile(absPath, "utf8").catch(() => null));
        if (text === null) return;
        this.syncDocument(absPath, text);
    }

    /** didOpen the first time, didChange after — returns the new version. */
    private syncDocument(absPath: string, content: string): number {
        const uri = pathToUri(absPath);
        const existing = this.openDocs.get(uri);
        if (existing === undefined) {
            this.openDocs.set(uri, 1);
            this.notify("textDocument/didOpen", {
                textDocument: { uri, languageId: this.spec.languageId(absPath), version: 1, text: content },
            });
            return 1;
        }
        const version = existing + 1;
        this.openDocs.set(uri, version);
        this.notify("textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text: content }],
        });
        return version;
    }

    /**
     * Issue an arbitrary LSP request. Errors and server crashes resolve to null
     * rather than throwing: one unsupported operation must not take down a tool
     * call that other servers may still answer.
     */
    async send<T>(method: string, params: unknown): Promise<T | null> {
        if (!this.isAlive) return null;
        try {
            return (await this.request(method, params)) as T;
        } catch {
            return null;
        }
    }

    /**
     * Diagnostics for a file, by whichever mechanism the server implements.
     *
     * LSP has two and servers differ: the older PUSH model volunteers
     * `publishDiagnostics` whenever analysis settles, while the PULL model
     * (`diagnosticProvider`, what TypeScript 7 and other modern servers use)
     * answers only when asked. Waiting for a push from a pull-only server just
     * burns the timeout and reports a clean file, so ask when we can, and merge
     * with anything already pushed.
     */
    async diagnose(absPath: string, content: string, timeoutMs: number): Promise<Diagnostic[]> {
        if (!this.isAlive) return [];
        const uri = pathToUri(absPath);
        this.syncDocument(absPath, content);

        if (this.supports("diagnosticProvider")) {
            const report = await this.withTimeout(
                this.send<{ kind?: string; items?: Diagnostic[] }>("textDocument/diagnostic", {
                    textDocument: { uri },
                }),
                timeoutMs,
            );
            return dedupeDiagnostics([...(report?.items ?? []), ...(this.diagnostics.get(uri) ?? [])]);
        }

        await this.waitForDiagnostics(uri, timeoutMs);
        return this.diagnostics.get(uri) ?? [];
    }

    /** Resolve null rather than hang if a server never answers. */
    private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), ms);
            promise
                .then((v) => {
                    clearTimeout(timer);
                    resolve(v);
                })
                .catch(() => {
                    clearTimeout(timer);
                    resolve(null);
                });
        });
    }

    private waitForDiagnostics(uri: string, timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const waiter: DiagnosticsWaiter = {
                resolve: () => {
                    setTimeout(finish, 250);
                },
            };
            const list = this.waiters.get(uri) ?? [];
            list.push(waiter);
            this.waiters.set(uri, list);
            const timer = setTimeout(finish, timeoutMs);
        });
    }

    async shutdown(): Promise<void> {
        if (!this.proc) return;
        try {
            if (this.initialized) {
                await this.request("shutdown", null).catch(() => {});
                this.notify("exit", null);
            }
        } finally {
            this.proc?.kill();
            this.proc = null;
        }
    }

    // --- wire plumbing -----------------------------------------------------

    private request(method: string, params: unknown): Promise<unknown> {
        if (!this.proc) return Promise.reject(new Error("language server not started"));
        const id = this.nextId++;
        const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write(msg);
        });
    }

    private notify(method: string, params: unknown): void {
        if (!this.proc) return;
        this.write({ jsonrpc: "2.0", method, params });
    }

    private write(msg: JsonRpcMessage): void {
        const json = JSON.stringify(msg);
        const payload = Buffer.from(json, "utf-8");
        const header = Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "ascii");
        this.proc?.stdin.write(header);
        this.proc?.stdin.write(payload);
    }

    private onData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;
            const header = this.buffer.subarray(0, headerEnd).toString("ascii");
            const match = /Content-Length:\s*(\d+)/i.exec(header);
            if (!match) {
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }
            const length = Number(match[1]);
            const bodyStart = headerEnd + 4;
            if (this.buffer.byteLength < bodyStart + length) return;
            const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
            this.buffer = this.buffer.subarray(bodyStart + length);
            try {
                this.dispatch(JSON.parse(body) as JsonRpcMessage);
            } catch {
                // ignore unparseable frames
            }
        }
    }

    private dispatch(msg: JsonRpcMessage): void {
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pending.get(msg.id as number);
            if (!pending) return;
            this.pending.delete(msg.id as number);
            if (msg.error) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
            return;
        }
        if (msg.method === "textDocument/publishDiagnostics") {
            const params = msg.params as PublishDiagnosticsParams;
            this.diagnostics.set(params.uri, params.diagnostics ?? []);
            const waiters = this.waiters.get(params.uri);
            if (waiters?.length) {
                this.waiters.delete(params.uri);
                for (const w of waiters) w.resolve();
            }
        }
        if (msg.id !== undefined && msg.method) {
            this.write({ jsonrpc: "2.0", id: msg.id, result: null });
        }
    }
}
