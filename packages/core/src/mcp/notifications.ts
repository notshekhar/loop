/**
 * Server-to-client notifications.
 *
 * The AI SDK's MCP client has no notification handling at all: its
 * `transport.onmessage` treats a message with a `method` and no `id` — which is
 * precisely a JSON-RPC notification — as an "Unsupported message type" error
 * and routes it to `onUncaughtError`. loop reads that callback as "the
 * connection died", so a server doing something completely ordinary (announcing
 * a changed tool list, emitting a log line, reporting progress) had its
 * connection marked errored and every one of its tools withdrawn mid-session.
 *
 * So notifications are intercepted at the transport, before the SDK sees them.
 * `onmessage` is re-defined as an accessor: the SDK's own assignment is
 * captured as the inner handler and still receives every request/response,
 * while notifications are peeled off and routed here instead.
 */
import { debugLog } from "../debug";

export interface McpNotification {
    method: string;
    params?: Record<string, unknown>;
}

export type McpNotificationHandler = (notification: McpNotification) => void;

/** JSON-RPC: a `method` and no `id`. Responses have an id; requests have both. */
export function isNotificationMessage(message: unknown): message is McpNotification {
    if (typeof message !== "object" || message === null) return false;
    const msg = message as { method?: unknown; id?: unknown };
    return typeof msg.method === "string" && msg.id === undefined;
}

const HOOK = Symbol.for("loop.mcp.notificationHook");

interface Hook {
    handler: McpNotificationHandler;
    /** The SDK's own onmessage — everything that isn't a notification goes here. */
    inner?: (message: unknown) => void;
}

/**
 * Peel notifications off a transport. Safe to call twice on the same object
 * (the second call just re-points the handler), and safe to call either side of
 * client construction: an stdio transport is ours before `createMCPClient` sees
 * it, while an HTTP transport is built inside the SDK and can only be reached
 * afterwards through the client. Hooking early matters — a server that
 * announces itself immediately after `notifications/initialized` can otherwise
 * land a notification in the gap between the handshake finishing and us
 * attaching.
 */
export function interceptNotifications(target: unknown, handler: McpNotificationHandler): boolean {
    if (typeof target !== "object" || target === null) return false;
    const host = target as { [HOOK]?: Hook; onmessage?: (message: unknown) => void };
    const existing = host[HOOK];
    if (existing) {
        existing.handler = handler;
        return true;
    }
    const hook: Hook = { handler, inner: host.onmessage };
    const dispatch = (message: unknown): void => {
        if (isNotificationMessage(message)) {
            try {
                hook.handler(message);
            } catch (err) {
                debugLog("mcp", "notification handler threw:", err);
            }
            return;
        }
        hook.inner?.(message);
    };
    try {
        Object.defineProperty(host, HOOK, { value: hook, configurable: true, enumerable: false });
        Object.defineProperty(host, "onmessage", {
            configurable: true,
            enumerable: true,
            get: () => dispatch,
            set: (fn: ((message: unknown) => void) | undefined) => {
                hook.inner = fn;
            },
        });
        return true;
    } catch {
        // A frozen transport isn't worth failing a connect over; the
        // benign-error guard in the manager still keeps the server alive.
        return false;
    }
}
