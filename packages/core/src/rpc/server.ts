import type { Server } from "node:net";
import { SessionManager, type Session } from "../sessions";
import { setAskUserBridge } from "../tools/ask-bridge";
import { killAllBashChildren } from "../tools/utils/shell-registry";
import { CommandRegistry, registerBuiltins } from "../commands";
import { getExtensionHost } from "../extensions";
import { RpcErrorCode, type RpcRequest } from "./protocol";
import { claimTeamRuntime, onTeamChange, releaseTeamRuntime } from "../teams";
import type { StreamPart, Transport } from "./server/active-session";
import { AskRelay } from "./server/asks";
import { ClientRegistry, type SessionStatusNotice } from "./server/clients";
import { broadcast, eventsSinceTurnStart, wirePart } from "./server/event-stream";
import { buildHandlerTable } from "./server/handler-table";
import { claimSocketPaths, serveSocket, serveStdio } from "./server/hosting";
import type { HandlerTable, RpcHost } from "./server/rpc-host";
import { SessionContexts, type LiveSessionProvider } from "./server/session-contexts";
import { TurnRunner } from "./server/turns";

export { plainError } from "./server/event-stream";
export { writeAttachmentPayloads } from "./server/attachments";
export { stopSocketServer } from "./server/hosting";
export type { SessionStatusNotice } from "./server/clients";
export type { LiveSession, LiveSessionProvider } from "./server/session-contexts";

/**
 * The RPC server: owns the clients, the open sessions and the method table,
 * and routes each JSON-RPC line to its handler. The handlers themselves live
 * in rpc/server/, one file per domain.
 */
export class RpcServer {
    private readonly clients = new ClientRegistry();
    private readonly contexts: SessionContexts;
    private readonly turns: TurnRunner;
    private readonly host: RpcHost;
    private readonly handlers: HandlerTable;
    /** Startup work (extensions, command registry) every request waits on —
     * otherwise an early session.send could run a turn before extension
     * tools/providers exist. */
    private ready: Promise<void>;

    private readonly offTeamChange: () => void;

    constructor(
        opts: {
            remote?: boolean;
            /** Sessions a host process runs itself (the TUI under `/rc`). */
            live?: LiveSessionProvider;
            /**
             * Whether this server answers the ask tool. False when it is
             * embedded in a TUI: the bridge is process-global, and taking it
             * would send the TUI's own questions to remote clients.
             */
            askBridge?: boolean;
            /** loop's release, reported by `hello`. */
            version?: string;
        } = {},
    ) {
        const announce = (notice: SessionStatusNotice) => this.clients.announce(notice);
        this.contexts = new SessionContexts(new SessionManager(), opts.live ?? null, announce);
        this.turns = new TurnRunner(this.contexts);
        const asks = new AskRelay(this.contexts);
        this.host = {
            contexts: this.contexts,
            turns: this.turns,
            asks,
            announce,
            commands: new CommandRegistry(),
            remote: opts.remote === true,
            version: opts.version?.trim() || "dev",
        };
        this.handlers = buildHandlerTable(this.host);
        // Registering a bridge is what makes the ask tool exist at all: runTurn
        // only attaches it when one is present, which is why RPC clients never
        // saw a question before.
        if (opts.askBridge !== false) {
            setAskUserBridge({ ask: (questions, askOpts) => asks.ask(questions, askOpts) });
        }
        this.claimTeams();
        // Every client hears when a team moves, the way it hears a session
        // start running — the panels and lists redraw from it.
        this.offTeamChange = onTeamChange((change) => {
            announce({
                sessionId: change.sessionId ?? "",
                change: "team",
                teamId: change.teamId,
                teamChange: change.kind,
            });
        });
        this.ready = this.registerCommands();
    }

    /** Thread teams: this server runs a team's member turns itself — unless
     * it is embedded in a TUI (`live`), whose own sessions they are. */
    private claimTeams(): void {
        if (this.contexts.live) return;
        claimTeamRuntime(this, {
            deliver: (sessionId, input, team) => this.turns.deliverTeamTurn(sessionId, input, team),
            isRunning: (sessionId) => this.isRunning(sessionId),
            cancel: (sessionId) => this.cancelOwnTurn(sessionId),
        });
    }

    private async registerCommands(): Promise<void> {
        await getExtensionHost().init();
        await registerBuiltins(this.host.commands);
        getExtensionHost().applyCommands(this.host.commands);
    }

    attach(transport: Transport): { feed: (chunk: Buffer | string) => void; close: () => void } {
        let buffer = "";
        const feed = (chunk: Buffer | string) => {
            buffer += typeof chunk === "string" ? chunk : chunk.toString();
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line) this.handleLine(line, transport);
            }
        };
        this.clients.add(transport);
        return { feed, close: () => this.disconnect(transport) };
    }

    /** Transport gone (socket/WS closed): stop broadcasting to it everywhere. */
    disconnect(transport: Transport): void {
        this.clients.remove(transport);
        this.contexts.unsubscribeEverywhere(transport);
    }

    /**
     * A turn in a live session (see LiveSession) emitted an event: stamp it
     * into that session's stream as if this server had run the turn.
     */
    publishLive(sessionId: string, part: StreamPart): void {
        const ctx = this.contexts.liveCtx(sessionId);
        if (ctx) broadcast(sessionId, ctx, wirePart(part.type, part.data));
    }

    /**
     * The Session this server holds open for `sessionId`, if any. A TUI
     * opening the same session uses this object rather than loading a second
     * copy: two copies in one process each append to their own branch, so
     * whichever wrote second dropped the other's messages.
     */
    openSession(sessionId: string): Session | undefined {
        return this.contexts.get(sessionId)?.session;
    }

    /** Stop a turn this server is running itself (Esc in the TUI following it). */
    cancelOwnTurn(sessionId: string): void {
        this.turns.cancelOwn(sessionId);
    }

    /** Whether this server is running a turn in `sessionId` itself. */
    isRunning(sessionId: string): boolean {
        return this.contexts.get(sessionId)?.running === true;
    }

    /**
     * The events of a session this server has open, in order — how the TUI
     * that hosts it draws a turn a phone started. `fromTurnStart` first replays
     * what the running turn already streamed (from the event ring), so the
     * reply reads whole however late the TUI opened it. Returns an unsubscribe.
     */
    watch(sessionId: string, listener: (part: StreamPart) => void, opts: { fromTurnStart?: boolean } = {}): () => void {
        const ctx = this.contexts.get(sessionId);
        if (!ctx) return () => {};
        if (opts.fromTurnStart && ctx.running) {
            for (const part of eventsSinceTurnStart(ctx)) listener(part);
        }
        const transport: Transport = {
            send: (msg) => {
                if ("method" in msg && msg.method === "session.event") {
                    listener((msg.params as { part: StreamPart }).part);
                }
            },
        };
        ctx.subscribers.add(transport);
        return () => ctx.subscribers.delete(transport);
    }

    /** A live session's turn started or ended (see publishLive). */
    setLiveRunning(sessionId: string, running: boolean): void {
        const ctx = this.contexts.liveCtx(sessionId);
        if (ctx) this.contexts.setRunning(sessionId, ctx, running);
    }

    /**
     * The process hosting this server is going away.
     *
     * A transport closing is `disconnect`; this is the other end of the
     * lifetime — every live turn is aborted, every subscriber dropped, and
     * everything bash started is killed. That last part is the reason this
     * method exists: background shells are process-lifetime, held in an
     * in-memory registry, so a server that exits without killing them leaves
     * processes running that no future session can find. The CLI has always
     * done this on its way out; nothing else did.
     *
     * Idempotent — a surface may reach it from both a signal and a stream end.
     */
    dispose(): number {
        this.offTeamChange();
        releaseTeamRuntime(this);
        this.contexts.dropAll();
        return killAllBashChildren();
    }

    private async handleLine(line: string, transport: Transport): Promise<void> {
        let req: RpcRequest;
        try {
            req = JSON.parse(line) as RpcRequest;
        } catch {
            transport.send({
                jsonrpc: "2.0",
                id: null,
                error: { code: RpcErrorCode.PARSE_ERROR, message: "Parse error" },
            });
            return;
        }
        try {
            await this.ready;
            const result = await this.dispatch(req, transport);
            if (req.id !== undefined) {
                transport.send({ jsonrpc: "2.0", id: req.id, result });
            }
        } catch (err) {
            if (req.id !== undefined) {
                transport.send({
                    jsonrpc: "2.0",
                    id: req.id,
                    error: { code: RpcErrorCode.INTERNAL_ERROR, message: (err as Error).message },
                });
            }
        }
    }

    /**
     * Run one method in-process, exactly as a client's request would run.
     * For whatever hosts this server and needs core from the side — serve's
     * workspace asking for a commit message, the way the desktop's host asks
     * main. Nobody is subscribed through it, so it is for answers, not events.
     */
    async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        await this.ready;
        return this.dispatch({ jsonrpc: "2.0", id: 0, method, params }, { send() {} });
    }

    private async dispatch(req: RpcRequest, transport: Transport): Promise<unknown> {
        const handler = this.handlers[req.method];
        if (!handler) throw new Error(`Method not found: ${req.method}`);
        return handler((req.params ?? {}) as Record<string, unknown>, transport, req);
    }
}

export function startStdioServer(): void {
    serveStdio(new RpcServer());
}

export function startSocketServer(): { server: Server; socketPath: string; pidPath: string } {
    const { socketPath, pidPath } = claimSocketPaths();
    const server = new RpcServer();
    return { server: serveSocket(server, socketPath, pidPath), socketPath, pidPath };
}
