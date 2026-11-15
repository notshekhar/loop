export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const DISABLE_AUTOWRAP = "\x1b[?7l";
export const ENABLE_AUTOWRAP = "\x1b[?7h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";
export const SHOW_CURSOR = "\x1b[?25h";
export const HIDE_CURSOR = "\x1b[?25l";
/** OSC 133 shell-integration zone markers at the start of a line; terminals would treat them as prompts. */
export const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
export const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";

/**
 * Mouse tracking to ask for. Multiplexers can lag when every pointer movement
 * is forwarded; button-motion tracking still gives clicks, wheel events,
 * selections, and scrollbar dragging.
 */
export function mouseTrackingSequence(env: NodeJS.ProcessEnv = process.env): string {
    const term = env.TERM?.toLowerCase() ?? "";
    const multiplexed =
        env.TMUX !== undefined ||
        env.ZELLIJ !== undefined ||
        env.STY !== undefined ||
        term.startsWith("tmux") ||
        term.startsWith("screen");
    return multiplexed ? ENABLE_BUTTON_MOTION_MOUSE : ENABLE_ALL_MOTION_MOUSE;
}

export function isWezTerm(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.WEZTERM_PANE) || env.TERM_PROGRAM?.toLowerCase() === "wezterm";
}
