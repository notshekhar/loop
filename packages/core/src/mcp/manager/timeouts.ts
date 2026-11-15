/** Every timing knob of the MCP manager, and the one timer helper they share. */
import { brandEnv } from "../../brand";

/**
 * Hard ceiling on a single server's connect (spawn + handshake + tools/list). A
 * stdio child that wedges on startup, or an HTTP server that accepts the socket
 * but never replies, would otherwise leave `connectServer` pending forever —
 * the status stays "connecting" and, in print mode (which awaits init), the
 * whole run hangs. Racing against a timeout turns that into a normal `error`
 * status the user can see and retry. Overridable via LOOP_MCP_CONNECT_TIMEOUT_MS.
 */
export const CONNECT_TIMEOUT_MS = Number(brandEnv("MCP_CONNECT_TIMEOUT_MS")) || 30_000;

/**
 * How often a connected server is probed, and how long a probe may take.
 *
 * A dead stdio child announces itself: the transport closes and we hear about
 * it. A remote server does not — an HTTP connection can be silently gone for an
 * hour while loop still advertises its tools and every call the model makes
 * fails. The probe is a `tools/list`, which is the one request every MCP server
 * implements, and it doubles as a refresh for servers that change their tools
 * without sending list_changed. Set LOOP_MCP_HEALTH_INTERVAL_MS=0 to turn it off.
 */
function envMs(suffix: string, fallback: number): number {
    const raw = brandEnv(suffix);
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read when the timer is armed, not at import, so it is settable per process. */
export const healthIntervalMs = () => envMs("MCP_HEALTH_INTERVAL_MS", 60_000);

/**
 * Ceiling on one probe.
 *
 * Without it the probe inherits the failure it is meant to detect: a server
 * that accepts the connection and never answers leaves `listTools()` pending
 * forever, so the one request whose job is to notice a wedged server is itself
 * wedged, and every later probe stacks another pending promise behind it.
 */
export const probeTimeoutMs = () => envMs("MCP_PROBE_TIMEOUT_MS", 10_000);

/**
 * Reconnect backoff after a server drops. Doubling from 1s, capped, and given
 * up on after a handful of tries — a server that is gone for good must not have
 * loop respawning its process every second for the rest of the session.
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * A rejecting timer plus a `clear()` so a fast connect doesn't leave the
 * 30s timer pinning the event loop open (which would hang a CLI exit or a test
 * run). Caller clears it in a `finally`.
 */
export function rejectAfter(ms: number, message: string): { promise: Promise<never>; clear: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return { promise, clear: () => clearTimeout(timer) };
}
