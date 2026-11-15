import { parseOsc11BackgroundColor, type RgbColor } from "../terminal-colors";
import type { Terminal } from "../terminal";

type PendingQuery = {
    settled: boolean;
    resolve: ((rgb: RgbColor | undefined) => void) | undefined;
    timer: NodeJS.Timeout | undefined;
};

/** OSC 11 background-colour queries, answered in the order they were sent. */
export class BackgroundColorQueries {
    private pending: PendingQuery[] = [];

    constructor(private readonly terminal: Pick<Terminal, "write">) {}

    /**
     * Query the terminal's default background color with OSC 11 (`ESC ] 11 ; ? BEL`).
     * @returns the parsed RGB color, or undefined if it times out or fails to parse.
     */
    query(timeoutMs: number): Promise<RgbColor | undefined> {
        return new Promise((resolve) => {
            const query: PendingQuery = { settled: false, resolve, timer: undefined };
            query.timer = setTimeout(() => settle(query, undefined), timeoutMs);
            this.pending.push(query);
            this.terminal.write("\x1b]11;?\x07");
        });
    }

    /** A reply arrived; it answers the oldest query, even one that already timed out. */
    deliver(report: string): void {
        const query = this.pending.shift();
        if (query) settle(query, parseOsc11BackgroundColor(report));
    }
}

function settle(query: PendingQuery, rgb: RgbColor | undefined): void {
    if (query.settled) return;
    query.settled = true;
    if (query.timer) {
        clearTimeout(query.timer);
        query.timer = undefined;
    }
    query.resolve?.(rgb);
    query.resolve = undefined;
}
