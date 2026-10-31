import type { WelcomePanel } from "@notshekhar/loop-core";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@notshekhar/loop-tui";

/**
 * An app's live lines under the masthead (AppProfile.welcomePanel).
 *
 * The panel never gets shorter. Once the transcript grows past it, the
 * masthead's rows are committed to the terminal's scrollback, and a committed
 * row can be reprinted in place but nothing below it can move up — so a panel
 * that shrank would leave the rows under it duplicated. Growing is safe while
 * it is on screen, and an app's panel is a fixed shape in practice.
 */
export class WelcomePanelView implements Component {
    private tallest = 0;
    private readonly unsubscribe: () => void;

    constructor(
        tui: TUI,
        private readonly panel: WelcomePanel,
    ) {
        this.unsubscribe = panel.subscribe(() => tui.requestRender());
    }

    /** Stop following the panel — the banner it sat under was replaced. */
    dispose(): void {
        this.unsubscribe();
    }

    invalidate(): void {}

    render(width: number): string[] {
        const lines = this.panel.lines(width).map((line) => {
            const fitted = visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
            return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
        });
        this.tallest = Math.max(this.tallest, lines.length);
        while (lines.length < this.tallest) lines.push(" ".repeat(width));
        return lines;
    }
}
