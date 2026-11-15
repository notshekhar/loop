import { parseTerminalColorSchemeReport, type TerminalColorScheme } from "../terminal-colors";
import type { Terminal } from "../terminal";

const ENABLE_NOTIFICATIONS = "\x1b[?2031h";
const DISABLE_NOTIFICATIONS = "\x1b[?2031l";

type SchemeListener = (scheme: TerminalColorScheme) => void;

/** Dark/light colour-scheme reports (`CSI ? 997 ; n n`): one-off queries and live notifications. */
export class ColorSchemeReports {
    private listeners = new Set<SchemeListener>();
    private notificationsEnabled = false;

    constructor(private readonly terminal: Pick<Terminal, "write">) {}

    onChange(listener: SchemeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** `running` says whether the terminal is live; if not, the mode is sent on start(). */
    setNotifications(enabled: boolean, running: boolean): void {
        if (this.notificationsEnabled === enabled) return;
        this.notificationsEnabled = enabled;
        if (running) this.terminal.write(enabled ? ENABLE_NOTIFICATIONS : DISABLE_NOTIFICATIONS);
    }

    start(): void {
        if (this.notificationsEnabled) this.terminal.write(ENABLE_NOTIFICATIONS);
    }

    stop(): void {
        if (this.notificationsEnabled) this.terminal.write(DISABLE_NOTIFICATIONS);
    }

    deliver(report: string): void {
        const scheme = parseTerminalColorSchemeReport(report);
        if (!scheme) return;
        for (const listener of this.listeners) listener(scheme);
    }

    /**
     * Query the terminal's color-scheme preference with DSR (`CSI ? 996 n`).
     * Terminals that support the color palette notification protocol reply with
     * `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light.
     */
    query(timeoutMs: number): Promise<TerminalColorScheme | undefined> {
        return new Promise((resolve) => {
            let settled = false;
            let timer: NodeJS.Timeout | undefined;
            let unsubscribe: () => void = () => {};
            const settle = (scheme: TerminalColorScheme | undefined) => {
                if (settled) return;
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                unsubscribe();
                resolve(scheme);
            };
            unsubscribe = this.onChange(settle);
            timer = setTimeout(() => settle(undefined), timeoutMs);
            this.terminal.write("\x1b[?996n");
        });
    }
}
