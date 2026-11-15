/**
 * Getting a dropped server back: a periodic health probe that notices a dead
 * connection the transport never reported, and a backoff that reconnects a
 * server which was working a moment ago.
 */
import type { McpServerConfig } from "../config";
import type { ServerState, ServerTable } from "./state";
import {
    healthIntervalMs,
    MAX_RECONNECT_ATTEMPTS,
    probeTimeoutMs,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
    rejectAfter,
} from "./timeouts";

/** What the reconnect backoff needs from the manager. */
export interface ReconnectHost {
    table: ServerTable;
    connect(name: string, cfg: McpServerConfig): Promise<void>;
}

export class ReconnectScheduler {
    /** Pending reconnect timers, and how many attempts each server has spent. */
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private attempts = new Map<string, number>();

    constructor(private readonly host: ReconnectHost) {}

    /**
     * Bring a dropped server back on its own.
     *
     * Before this, a server that died mid-session stayed dead until someone
     * noticed and ran `/mcp reconnect` — and the way people noticed was the
     * model failing to call its tools. Only servers that were WORKING are
     * retried: a config error or a missing login will fail identically forever,
     * and retrying those is just noise with a subprocess attached.
     */
    schedule(name: string): void {
        if (this.timers.has(name)) return;
        const attempt = this.attempts.get(name) ?? 0;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        this.attempts.set(name, attempt + 1);
        const timer = setTimeout(() => {
            this.timers.delete(name);
            const server = this.host.table.servers.get(name);
            // Anything that changed the server's state in the meantime — a
            // manual reconnect, a disable, a delete — wins over this.
            if (!server || server.status !== "error") return;
            void this.host.connect(name, server.config).then(() => {
                if (this.host.table.servers.get(name)?.status === "ready") {
                    this.attempts.delete(name);
                    return;
                }
                this.schedule(name);
            });
        }, delay);
        (timer as { unref?: () => void }).unref?.();
        this.timers.set(name, timer);
    }

    /** A connect succeeded: the next drop starts the backoff from scratch. */
    resetAttempts(name: string): void {
        this.attempts.delete(name);
    }

    /** Stop any pending reconnect for a server the user has taken charge of. */
    cancel(name: string): void {
        const timer = this.timers.get(name);
        if (timer) clearTimeout(timer);
        this.timers.delete(name);
        this.attempts.delete(name);
    }

    cancelAll(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.attempts.clear();
    }
}

/** What the health probe needs from the manager. */
export interface HealthHost {
    table: ServerTable;
    markDisconnected(name: string, generation: number, err: unknown): void;
}

export class HealthMonitor {
    private timer?: ReturnType<typeof setInterval>;

    constructor(private readonly host: HealthHost) {}

    /**
     * Probe connected servers on a timer.
     *
     * `unref` matters as much as the interval does: a repeating timer that
     * keeps the event loop alive turns a finished `loop run` into a process
     * that never exits. The probe is skipped entirely when the interval is 0.
     */
    start(): void {
        const interval = healthIntervalMs();
        if (this.timer || interval <= 0) return;
        this.timer = setInterval(() => void this.checkAll(), interval);
        (this.timer as { unref?: () => void }).unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /**
     * Probe every connected server once.
     *
     * Probes run in parallel and each is bounded: one unresponsive server must
     * not delay the verdict on the others.
     */
    async checkAll(): Promise<void> {
        const timeout = probeTimeoutMs();
        await Promise.all([...this.host.table.servers.values()].map((server) => this.probe(server, timeout)));
    }

    private async probe(server: ServerState, timeout: number): Promise<void> {
        if (server.status !== "ready" || !server.client) return;
        const generation = this.host.table.generationOf(server.name);
        if (generation === undefined) return;
        const listing = server.client.listTools();
        const deadline = rejectAfter(timeout, `health probe timed out after ${timeout}ms`);
        try {
            await Promise.race([listing, deadline.promise]);
        } catch (err) {
            // The connection is gone without the transport ever saying
            // so — how a remote server usually fails. Treated exactly
            // like a dropped one, reconnect and all.
            this.host.markDisconnected(server.name, generation, err);
        } finally {
            deadline.clear();
        }
    }
}
