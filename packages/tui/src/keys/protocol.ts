/**
 * Whether the Kitty keyboard protocol is on. It decides how ambiguous legacy
 * bytes read: with it on, \x1b\r and \n are custom shift+enter mappings
 * rather than alt+enter and a bare newline.
 */
let kittyProtocolActive = false;

/**
 * Set the global Kitty keyboard protocol state.
 * Called by ProcessTerminal after detecting protocol support.
 */
export function setKittyProtocolActive(active: boolean): void {
    kittyProtocolActive = active;
}

/**
 * Query whether Kitty keyboard protocol is currently active.
 */
export function isKittyProtocolActive(): boolean {
    return kittyProtocolActive;
}
