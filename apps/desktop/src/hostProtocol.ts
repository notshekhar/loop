/**
 * The wire between the main process and the workspace host.
 *
 * Four message kinds, because the traffic genuinely runs both ways. Requests
 * and responses are the obvious pair. Notifications exist because some of what
 * the host produces is not an answer to anything — a PTY's output, a
 * pre-commit hook's log — and arrive whenever they arrive. Callbacks exist
 * because the host occasionally needs something only main has: writing a
 * commit message means asking loop's core for one, and core lives in main.
 *
 * Deliberately structural rather than a class hierarchy: this crosses a
 * process boundary as plain JSON, so anything that cannot survive
 * `structuredClone` cannot be in it.
 */

/** main → host: run this and reply. */
export interface HostRequest {
  readonly kind: "request";
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

/** host → main: the answer, with failure as a value rather than a throw. */
export interface HostResponse {
  readonly kind: "response";
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/**
 * host → main: something that happened, addressed to a renderer channel.
 *
 * The channel is carried rather than inferred so main stays a pipe — it
 * forwards whatever arrives without needing a case per event type, which is
 * what keeps a new host capability from costing a change in main.
 */
export interface HostNotification {
  readonly kind: "notify";
  readonly channel: string;
  readonly payload: unknown;
}

/** host → main: the host needs something from main (core, above all). */
export interface HostCallback {
  readonly kind: "callback";
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

/** main → host: the callback's answer. */
export interface HostCallbackResponse {
  readonly kind: "callbackResponse";
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/**
 * main → host: here is a pipe straight to the renderer.
 *
 * Carries no data of its own — the payload is the transferred MessagePort
 * beside it. Terminal output is the highest-volume thing the host produces and
 * the only thing whose every byte was crossing main purely to be handed on; a
 * direct port takes main out of that path entirely. Everything else stays on
 * the notification road, where main's involvement costs nothing.
 *
 * Re-sent whenever either end is replaced — a renderer reload invalidates the
 * far side, a host restart invalidates the near one.
 */
export interface HostPortAssignment {
  readonly kind: "port";
}

export type ToHost = HostRequest | HostCallbackResponse | HostPortAssignment;
export type FromHost = HostResponse | HostNotification | HostCallback;

/** The channel main uses to hand the renderer its end of that pipe. */
export const TERMINAL_PORT_CHANNEL = "loop:terminalPort";

// The channel and callback names are shared with every other host of the
// workspace handlers (loop serve), so they live with the handlers in core.
export { HOST_CALLBACKS, HOST_CHANNELS } from "@notshekhar/loop-core/workspace";
