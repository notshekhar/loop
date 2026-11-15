import type { RpcNotification, RpcRequest, RpcResponse } from "../../rpc/protocol";

/** Structurally satisfied by RpcServer — and by a fake jsonrpc peer in tests. */
export interface RpcAttachable {
    attach(transport: { send(msg: RpcResponse | RpcNotification): void }): {
        feed(chunk: string): void;
        close(): void;
    };
}

/** The one thing the bridge's command, menu and turn code needs from the peer. */
export interface RpcCaller {
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** In-process JSON-RPC peer over RpcServer's line transport. */
export class RpcPeer implements RpcCaller {
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private feed: (chunk: string) => void;
    private closeFn: () => void;
    onNotification: (method: string, params: unknown) => void = () => {};

    constructor(rpc: RpcAttachable) {
        const attached = rpc.attach({ send: (msg) => this.receive(msg) });
        this.feed = attached.feed;
        this.closeFn = attached.close;
    }

    private receive(msg: RpcResponse | RpcNotification): void {
        if ("id" in msg && msg.id !== null && msg.id !== undefined) {
            const res = msg as RpcResponse;
            const pending = this.pending.get(res.id as number);
            if (!pending) return;
            this.pending.delete(res.id as number);
            if (res.error) pending.reject(new Error(res.error.message));
            else pending.resolve(res.result);
        } else if ("method" in msg) {
            this.onNotification(msg.method, msg.params);
        }
    }

    call<T = unknown>(method: string, params?: unknown): Promise<T> {
        const id = this.nextId++;
        const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.feed(JSON.stringify(req) + "\n");
        });
    }

    close(): void {
        this.closeFn();
    }
}
