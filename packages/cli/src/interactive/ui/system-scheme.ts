/**
 * Asking the terminal what it is — the machinery behind noir's `system` theme.
 *
 * Every other theme is a decision the user typed. `system` is the one that
 * refuses to be configured: it paints no canvas, so the terminal's own
 * background shows through, and its ink has to match a background loop does
 * not own and cannot see. So it asks, twice over:
 *
 *  1. OSC 11 — the background COLOUR. The authority: it is the surface we are
 *     drawing on, and it is what the palette is rebuilt against.
 *  2. `CSI ? 996 n` — the colour-scheme report, as a polarity fallback for a
 *     terminal that will not name its background.
 *
 * It asks ONCE — at startup, or when you pick the theme — and never again.
 * There was a watcher here that enabled unsolicited reports (`?2031h`) and
 * re-measured on every flip, and it was not worth what it cost. Following a
 * flip only ever repainted half the screen: live components re-resolve their
 * colours, but every line whose ANSI was already baked into the scrollback
 * keeps the old ink, so a flipped session read as two palettes stacked. And it
 * was the shape of the thing that made a catastrophic bug possible at all —
 * the reply to a scheme query IS a scheme report, so a watcher that re-asks on
 * every report re-asks forever (measured: 101,022 queries in ten seconds, whose
 * replies came back as ctrl+g and typed "continue" into people's sessions).
 * Asking once cannot loop. A flip mid-session is a `/reload` away, and that is
 * the one that gives you a whole screen in one palette anyway.
 *
 * A terminal that answers neither keeps the dark set on its safe canvas (see
 * `systemPalette`) — legible on anything from pure black to a light-ish
 * `#2e2e2e`, which is what makes an unanswered probe a non-event rather than
 * an unreadable screen. Both queries are cheap and time-limited, and neither
 * is ever asked unless `system` is the active theme.
 */
import type { RgbColor, TUI } from "@notshekhar/loop-tui";
import { applyCanvasWash } from "./canvas-wash";
import { setSystemScheme, SYSTEM_THEME_NAME } from "./themes";
import { initTheme, theme } from "./theme";

/**
 * How long the background-colour question may take.
 *
 * Terminals answer in microseconds when idle — but a loaded machine can take
 * far longer to deliver the reply, and a reply that misses its window is not
 * a terminal without the feature, it is an answer thrown away. It was 250ms,
 * and on a busy machine the colour lost that race: the probe fell back to the
 * scheme report, which on macOS is the OS appearance, and a dark terminal on
 * a light desktop was painted with the light set (near-white message boxes,
 * dark text). Nothing waits on this — the probe runs in the background after
 * the first paint — so the window can afford to be generous.
 */
const BACKGROUND_TIMEOUT_MS = 1_500;

/** The scheme report is only asked when the colour did not come back. */
const SCHEME_TIMEOUT_MS = 250;

/** Rec.601 luma — the same weights `palette.ts` weighs a hex with. */
function isLight(rgb: RgbColor): boolean {
    return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 > 0.5;
}

function toHex(rgb: RgbColor): string {
    return `#${[rgb.r, rgb.g, rgb.b]
        .map((c) =>
            Math.max(0, Math.min(255, Math.round(c)))
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")}`;
}

/** Is the theme that needs any of this the one currently rendering? */
export function systemThemeActive(): boolean {
    return theme.name === SYSTEM_THEME_NAME;
}

/** What the terminal told us, and where we are asking from. */
export interface SchemeEvidence {
    /** OSC 11 — the colour of the surface we are drawing on. */
    readonly background?: RgbColor;
    /** `CSI ? 996 n` — the colour-scheme report. */
    readonly reported?: "dark" | "light";
    readonly platform: NodeJS.Platform;
}

/**
 * Decide which set to wear from what the terminal said; undefined keeps the
 * default (the dark set on its safe canvas).
 *
 * The BACKGROUND COLOUR decides. It is the surface we are actually drawing on,
 * so it settles the polarity AND tunes the palette.
 *
 * The scheme report is the fallback for a terminal that will not name its
 * background — except on macOS, where it is not evidence about the terminal
 * at all. There it reports the user's colour-scheme PREFERENCE, which is the
 * OS appearance: a light desktop running a dark-themed terminal answers
 * "light" perfectly correctly, and a theme that believed it painted near-black
 * text and near-white message boxes onto a dark screen. Every macOS terminal
 * in use answers OSC 11, so no colour there means the reply was slow, not
 * missing — and the dark default is legible on any dark background, where
 * trusting the report is unreadable on the common one.
 */
export function resolveScheme(evidence: SchemeEvidence): { scheme: "dark" | "light"; canvas?: string } | undefined {
    const { background, reported, platform } = evidence;
    if (background) return { scheme: isLight(background) ? "light" : "dark", canvas: toHex(background) };
    if (!reported || platform === "darwin") return undefined;
    return { scheme: reported };
}

/** Ask the terminal — the colour first, the report only if the colour did
 * not come back. */
async function probe(tui: TUI): Promise<{ scheme: "dark" | "light"; canvas?: string } | undefined> {
    const background = await tui.queryTerminalBackgroundColor({ timeoutMs: BACKGROUND_TIMEOUT_MS });
    const reported = background
        ? undefined
        : await tui.queryTerminalColorScheme({ timeoutMs: SCHEME_TIMEOUT_MS });
    return resolveScheme({ background, reported, platform: process.platform });
}

/** Re-resolve `system` under the answer just recorded and repaint. */
function repaint(tui: TUI): void {
    initTheme(SYSTEM_THEME_NAME);
    // `system` carries no canvas, so this is what hands a previous theme's
    // wash back to the terminal (OSC 111/110) rather than what applies one.
    applyCanvasWash();
    tui.invalidate();
    tui.requestRender(true);
}

let probing = false;
let stopped = false;

/**
 * Ask, and adopt the answer. Resolves to whether anything changed.
 *
 * Single-flight, and silent once the UI is going away: a query whose reply
 * nobody is waiting for is not free. It arrives as input, and after exit it
 * arrives at whatever owns the terminal next — a wall of `^[]11;rgb:…` where
 * the shell prompt should be.
 */
export async function syncSystemScheme(tui: TUI): Promise<boolean> {
    if (probing || stopped) return false;
    probing = true;
    try {
        const answer = await probe(tui);
        if (!answer || !setSystemScheme(answer.scheme, answer.canvas)) return false;
        if (systemThemeActive()) repaint(tui);
        return true;
    } finally {
        probing = false;
    }
}

/**
 * Startup, `/ui`, and `/theme`: pay the probe only when `system` is the theme
 * actually rendering, and never block the first paint on a terminal that won't
 * answer.
 */
export function probeSystemScheme(tui: TUI): void {
    if (!systemThemeActive()) return;
    void syncSystemScheme(tui).catch(() => {});
}

/**
 * Shutdown: stop asking, before the TUI lets go of stdin.
 *
 * The latch is one-way — nothing after this point has anywhere to put a reply.
 */
export function stopSystemSchemeProbes(): void {
    stopped = true;
}

/** Reopen the latch — tests only. */
export function resumeSystemSchemeProbesForTest(): void {
    stopped = false;
    probing = false;
}
