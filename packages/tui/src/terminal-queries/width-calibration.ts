import { setWidthCalibration } from "../utils";
import type { Terminal } from "../terminal";

const CANARY_COUNT = 3;
/** How long to wait for the terminal to answer before giving up on calibration. */
const GIVE_UP_MS = 2000;

/**
 * Probe how the terminal actually lays out complex-script clusters, since
 * Devanagari-style cluster widths are unstandardized across terminals.
 * Prints three canaries — की (base + spacing matra), प्रे (conjunct with
 * virama), and स्त्र (three-consonant conjunct whose per-codepoint sum is
 * 3) — and reads the cursor column back with DSR (`CSI 6 n`). Together
 * they tell us whether spacing marks get their own cell, whether conjunct
 * clusters are shaped into one, and whether the terminal caps a cluster
 * at one cell pair (Ghostty's unicode width mode renders स्त्र in 2 cells
 * where wcwidth-style terminals use 3). visibleWidth() is then calibrated
 * to match, keeping the one-logical-line-per-row rendering invariant
 * intact. The canaries are printed and erased in the same write, wrapped
 * in synchronized output so they are never presented.
 */
export class WidthCalibrationProbe {
    private pendingReplies = 0;
    private columns: number[] = [];
    private timer: NodeJS.Timeout | undefined;

    /** `onChanged` runs when calibration changed widths, so everything must be repainted. */
    constructor(
        private readonly terminal: Pick<Terminal, "write">,
        private readonly onChanged: () => void,
    ) {}

    get isPending(): boolean {
        return this.pendingReplies > 0;
    }

    start(): void {
        if (!process.stdout.isTTY) return;
        this.pendingReplies = CANARY_COUNT;
        this.columns = [];
        this.terminal.write(
            "\x1b[?2026h\x1b7\rकी\x1b[6n\r\x1b[2Kप्रे\x1b[6n\r\x1b[2Kस्त्र\x1b[6n\r\x1b[2K\x1b8\x1b[?2026l",
        );
        // If the terminal never answers, stop intercepting CPR-shaped input
        // (it collides with modified-F3 key reports) and keep the defaults.
        this.timer = setTimeout(() => {
            this.pendingReplies = 0;
            this.columns = [];
            this.timer = undefined;
        }, GIVE_UP_MS);
    }

    /** The give-up timer would otherwise hold the event loop open. */
    cancel(): void {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.pendingReplies = 0;
    }

    /**
     * Consume cursor-position reports (`CSI row ; col R`) belonging to the
     * probe. Returns the input with consumed reports stripped; several
     * reports may arrive in one chunk.
     */
    consume(data: string): string {
        let rest = data;
        while (this.pendingReplies > 0) {
            const match = rest.match(/^\x1b\[(\d+);(\d+)R/);
            if (!match) break;
            this.columns.push(parseInt(match[2], 10));
            this.pendingReplies -= 1;
            rest = rest.slice(match[0].length);
        }
        if (this.pendingReplies === 0 && this.columns.length === CANARY_COUNT) this.finish();
        return rest;
    }

    private finish(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        // Columns are 1-based and the canary starts at column 1, so
        // rendered width = reported column - 1. की → 3 means the matra
        // took a cell; प्रे → 2 means the whole conjunct was shaped into
        // the base cell; स्त्र → 3 (instead of 4) means the terminal caps
        // a cluster at one cell pair.
        const [matraCol, conjunctCol, clampCol] = this.columns;
        this.columns = [];
        const changed = setWidthCalibration({
            spacingMarkWidth: matraCol >= 3 ? 1 : 0,
            shapedClusters: conjunctCol <= 2,
            clampClusters: clampCol <= 3,
        });
        if (changed) this.onChanged();
    }
}
