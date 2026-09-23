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
import { setNoirSystem, SYSTEM_THEME_NAME } from "./noir-mode";
import { initTheme, theme } from "./theme";

/**
 * How long a probe waits. Terminals that support these reports answer in
 * microseconds; the timeout only bounds the ones that will never answer, and
 * nothing is blocked on it — the probe runs in the background.
 */
const PROBE_TIMEOUT_MS = 250;

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

/**
 * Ask the terminal both questions; undefined when it tells us nothing.
 *
 * The BACKGROUND COLOUR decides, and the scheme report is the fallback — which
 * is the opposite of how it first looks, and the difference is a bug worth
 * remembering. `CSI ? 996 n` reports the user's colour-scheme PREFERENCE, and
 * on macOS that is the OS appearance: a light desktop running a dark-themed
 * terminal answers "light" perfectly correctly, and a theme that believed it
 * painted near-black text and a near-white input bar onto a dark screen.
 *
 * OSC 11 has no such gap — it is the colour of the surface we are actually
 * drawing on. So when both answer, the colour wins the polarity AND tunes the
 * palette; the report is what's left when a terminal won't name its background.
 */
async function probe(tui: TUI): Promise<{ scheme: "dark" | "light"; canvas?: string } | undefined> {
    const reported = await tui.queryTerminalColorScheme({ timeoutMs: PROBE_TIMEOUT_MS });
    const bg = await tui.queryTerminalBackgroundColor({ timeoutMs: PROBE_TIMEOUT_MS });
    if (bg) return { scheme: isLight(bg) ? "light" : "dark", canvas: toHex(bg) };
    return reported ? { scheme: reported } : undefined;
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
        if (!answer || !setNoirSystem(answer.scheme, answer.canvas)) return false;
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
