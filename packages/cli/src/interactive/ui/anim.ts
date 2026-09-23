/**
 * The transcript's animation clock — one shared frame counter that every
 * animated surface (running accent rails, streaming bullets, the "waiting on
 * you" pulse) reads, plus the brightness curves that turn a tick into a
 * colour.
 *
 * Ported from grok-build's model (`theme/tokyonight.rs`, `entry_renderer.rs`):
 * a running block's rail carries a `sin²` wave travelling DOWN it, while a
 * blocked one freezes into a slow whole-block pulse. Same maths, same
 * constants, so the motion reads the same.
 *
 * Two deliberate departures from grok:
 *
 * 1. **20fps, not 30.** loop has already been bitten once by a delta storm
 *    freezing the renderer (every tool-input-delta rebuilding the whole
 *    transcript). A frame clock is a second, independent source of repaints,
 *    so it runs as slow as it can while still reading as smooth.
 * 2. **The clock only exists while something is running.** An idle prompt
 *    holds no timer at all — `setActive(false)` clears it — so a session
 *    sitting at the prompt costs exactly what it did before.
 *
 * Renderers read {@link animTick} directly (module-level, like the active theme)
 * rather than threading a tick through every render signature.
 */
import type { TUI } from "@notshekhar/loop-tui";
import { mix } from "./palette";

/** Frames per second. See the note above on why this is 20 and not grok's 30. */
const FPS = 20;

/**
 * Radians per tick for the running wave. grok uses 0.15 at 30fps; matching
 * its wall-clock speed at 20fps means scaling by 30/20.
 */
const WAVE_SPEED = 0.15 * (30 / FPS);

/**
 * Rows per full wave cycle down a rail (grok's `animation.wave_rows`). Larger
 * = a longer, lazier wave.
 */
const WAVE_ROWS = 32;

/**
 * Radians per tick for the "waiting on you" pulse. grok's 0.08 at 30fps is a
 * ~1.3s bright→dim→bright cycle (`sin²` has period π).
 */
const PULSE_SPEED = 0.08 * (30 / FPS);

/** How long a block's rail flashes its finished colour before going quiet. */
export const FINISH_FLASH_MS = 400;

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let tui: TUI | null = null;

/** Wire the clock to the TUI it should repaint. Call once at startup. */
export function initAnimationClock(target: TUI): void {
    tui = target;
}

/**
 * The current frame. Monotonic while the clock runs and frozen (not reset)
 * while it doesn't, so a wave resumes from its own phase instead of snapping
 * back to the top of the cycle when the next tool starts.
 */
export function animTick(): number {
    return tick;
}

/**
 * Start/stop the frame clock. Idempotent — call it from wherever the set of
 * running blocks changes and let it settle; it only touches the timer when
 * the state actually flips.
 */
export function setAnimationActive(active: boolean): void {
    if (active === (timer !== null)) return;
    if (active) {
        timer = setInterval(() => {
            tick++;
            tui?.requestRender();
        }, 1000 / FPS);
        // An animation clock must never be the reason a process stays alive:
        // it is pure decoration, and holding the loop open would keep a
        // finished `loop run` from exiting.
        timer.unref?.();
    } else {
        clearInterval(timer!);
        timer = null;
    }
}

/**
 * Pin the frame for a test. Animated rendering is a pure function of the tick,
 * so a test can step frames deterministically instead of sleeping and hoping.
 */
export function setAnimTickForTest(frame: number): void {
    tick = frame;
}

/**
 * Brightness (0..1) for `row` of a running block's rail — a `sin²` wave whose
 * phase advances with the row, so the bright band travels down the rail.
 *
 * `sin²` rather than a raw sine because it never goes negative and spends
 * more of its cycle near the extremes, which reads as a pulse rather than a
 * wash.
 */
export function waveBrightness(row: number, t = tick): number {
    const phase = (row / WAVE_ROWS) * 2 * Math.PI;
    const s = Math.sin(t * WAVE_SPEED + phase);
    return s * s;
}

/**
 * Brightness (0..1) for a whole-element pulse — every element sharing a tick
 * pulses in unison (no spatial phase). This is the "paused on you" cue, and
 * the point is that it reads as DIFFERENT motion from the running wave.
 */
export function pulseBrightness(t = tick): number {
    const s = Math.sin(t * PULSE_SPEED);
    return s * s;
}

/**
 * Apply a brightness to an accent colour by blending it toward the canvas.
 *
 * `floor` keeps the trough visible: at brightness 0 a rail blended all the way
 * to the background would vanish and the block would look like it had ended.
 * grok holds its pulse at 0.3 for the same reason.
 */
export function accentAtBrightness(bg: string, accent: string, brightness: number, floor = 0.25): string {
    return mix(bg, accent, floor + (1 - floor) * brightness);
}
