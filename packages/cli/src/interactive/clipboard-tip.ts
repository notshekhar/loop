/**
 * "Image in clipboard · Ctrl+V to paste" — the nudge that closes the Cmd+V
 * dead end.
 *
 * Cmd+V with a raster-only clipboard is invisible to a raw-mode TUI: the
 * terminal owns the chord, reads the clipboard's *text* flavour, finds none,
 * and — measured in Ghostty 1.3.1 — sends nothing at all, not even an empty
 * bracketed paste. The user's paste silently does nothing and there is no
 * keystroke for us to hook. Ctrl+V does arrive, so the fix is discoverability:
 * notice the image and name the chord that works.
 *
 * Trigger model: one probe when the terminal regains focus — which is what
 * copying an image elsewhere and switching back looks like — never on a
 * keystroke. The probe is an `osascript` subprocess, and `clipboard info`
 * makes it a window-server client: macOS can flash it in the Dock under the
 * terminal's icon, which under cmux reads as a new cmux appearing with every
 * key. Keystrokes only take an already-read hint back down. Probes are still
 * throttled to one per {@link POLL_INTERVAL_MS} and refire only when the
 * clipboard actually changed — the same copied image never nags twice.
 */
import { spawn } from "node:child_process";

/** At most one pasteboard probe per this window, however fast keys arrive. */
const POLL_INTERVAL_MS = 1000;

/** Minimum spacing between fires, so copy-heavy work isn't nagged. */
const FIRE_COOLDOWN_MS = 30_000;

/**
 * macOS pasteboard flavours that mean "a raster image is on the board".
 * Names as `osascript -e 'clipboard info'` prints them.
 */
const RASTER_FLAVOURS = [
    "«class PNGf»",
    "«class AVIF»",
    "«class 8BPS»",
    "«class BMP »",
    "«class jp2 »",
    "«class TPIC»",
    "TIFF picture",
    "JPEG picture",
    "GIF picture",
];

/** A file reference — Finder copies carry one, plus a file-icon raster. */
const FILE_URL_FLAVOUR = "«class furl»";

/**
 * The clipboard's flavour list as a signature when it holds a *pasteable*
 * raster, else null.
 *
 * "Pasteable" excludes boards that also carry a file URL: a Finder copy puts a
 * file-icon raster next to the URL, and pasting the icon instead of the file
 * the user copied is never what they meant — those route through the existing
 * dropped-path flow.
 */
export function probeClipboardImage(): Promise<string | null> {
    if (process.platform !== "darwin") return Promise.resolve(null);
    return new Promise((resolve) => {
        const child = spawn("osascript", ["-e", "clipboard info"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (b: Buffer) => {
            out += b.toString();
        });
        child.on("error", () => resolve(null));
        child.on("close", (code) => {
            if (code !== 0) return resolve(null);
            const info = out.trim();
            if (info.includes(FILE_URL_FLAVOUR)) return resolve(null);
            resolve(RASTER_FLAVOURS.some((f) => info.includes(f)) ? info : null);
        });
    });
}

/** The status-line surface the tip borrows while it's up. */
export interface TipSurface {
    setHint(hint: string | null): void;
}

export interface ClipboardTipOptions {
    now?: () => number;
    probe?: () => Promise<string | null>;
}

/**
 * Fire-state for the tip. Pure except for the injected probe, so the whole
 * transition table — including "classify is not called inside the throttle
 * window" — is testable with a fake clock and a counting probe.
 */
export class ClipboardImageTip {
    private readonly now: () => number;
    private readonly probe: () => Promise<string | null>;
    private lastPollAt = -Infinity;
    private lastFiredAt = -Infinity;
    private lastSignature: string | null = null;
    private shown = false;
    private inFlight = false;

    constructor(opts: ClipboardTipOptions = {}) {
        this.now = opts.now ?? Date.now;
        this.probe = opts.probe ?? probeClipboardImage;
    }

    /** True while the hint owns the status line. */
    get visible(): boolean {
        return this.shown;
    }

    /** A keystroke: the hint has been read, so take it down. Never probes. */
    onKey(surface: TipSurface): void {
        this.dismiss(surface);
    }

    /**
     * Maybe probe the pasteboard — called when the terminal regains focus.
     * `eligible` is the caller's "an image would be accepted here" test (editor
     * focused, idle, vision model) — false short-circuits before any subprocess.
     */
    check(surface: TipSurface, eligible: () => boolean, onShow: () => void): void {
        this.dismiss(surface);
        if (this.inFlight || !eligible()) return;
        const now = this.now();
        if (now - this.lastPollAt < POLL_INTERVAL_MS) return;
        this.lastPollAt = now;
        this.inFlight = true;
        void this.probe()
            .then((signature) => {
                this.inFlight = false;
                if (signature === null) {
                    // Board no longer holds an image — let the next copy re-fire.
                    this.lastSignature = null;
                    return;
                }
                if (signature === this.lastSignature) return;
                if (this.now() - this.lastFiredAt < FIRE_COOLDOWN_MS) return;
                // Re-checked after the await: the probe outlives the keystroke,
                // and a hint that lands after the user opened a selector or nav
                // mode would steal a status line those own.
                if (!eligible()) return;
                this.lastSignature = signature;
                this.lastFiredAt = this.now();
                this.shown = true;
                surface.setHint("image in clipboard · Ctrl+V to paste it");
                onShow();
            })
            .catch(() => {
                this.inFlight = false;
            });
    }

    /** Release the status line if the tip is holding it. */
    dismiss(surface: TipSurface): void {
        if (!this.shown) return;
        this.shown = false;
        surface.setHint(null);
    }
}
