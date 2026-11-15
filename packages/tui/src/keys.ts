/**
 * Keyboard input handling for terminal applications.
 *
 * Supports both legacy terminal sequences and Kitty keyboard protocol.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 * Reference: https://github.com/sst/opentui/blob/7da92b4088aebfe27b9f691c04163a48821e49fd/packages/core/src/lib/parse.keypress.ts
 *
 * Symbol keys are also supported, however some ctrl+symbol combos
 * overlap with ASCII codes, e.g. ctrl+[ = ESC.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#legacy-ctrl-mapping-of-ascii-keys
 * Those can still be * used for ctrl+shift combos
 *
 * API:
 * - matchesKey(data, keyId) - Check if input matches a key identifier
 * - parseKey(data) - Parse input and return the key identifier
 * - Key - Helper object for creating typed key identifiers
 * - setKittyProtocolActive(active) - Set global Kitty protocol state
 * - isKittyProtocolActive() - Query global Kitty protocol state
 *
 * The pieces live in keys/; this module is their public face.
 */
export { isKittyProtocolActive, setKittyProtocolActive } from "./keys/protocol";
export { Key, type KeyId } from "./keys/key-id";
export { isKeyRelease, isKeyRepeat, type KeyEventType } from "./keys/sequences";
export { matchesKey } from "./keys/match";
export { parseKey } from "./keys/parse";
export { decodeKittyPrintable, decodePrintableKey } from "./keys/printable";
