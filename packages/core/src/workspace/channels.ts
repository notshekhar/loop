/**
 * Names shared by the workspace handlers and whoever hosts them — the
 * desktop's utility process, or `loop serve` over its WebSocket.
 */

/** Renderer channels the host emits on. Named here so both halves agree. */
export const HOST_CHANNELS = {
    terminal: "loop:terminal",
    gitAction: "loop:gitAction",
} as const;

/**
 * Callbacks the host may ask main for.
 *
 * One today. It is a named constant rather than a bare string because the two
 * halves are bundled separately — a typo would be a runtime rejection in a code
 * path that only runs when someone commits without writing a message.
 */
export const HOST_CALLBACKS = {
    commitMessage: "core.commitMessage",
} as const;
