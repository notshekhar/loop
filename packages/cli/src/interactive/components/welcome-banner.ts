import { PRODUCT_NAME } from "@notshekhar/loop-core";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@notshekhar/loop-tui";
import { mix } from "../ui/palette";
import { isLightTheme, theme, verticalRule } from "../ui/theme";

/**
 * Startup welcome banner, styled to match the desktop app: a vertical gradient
 * rule down the left edge — the theme's accent (the desktop's `--primary`)
 * ramped from a pale tint at the top to a deep one at the bottom — with the
 * product name and greeting beside it, then an aligned label/value block.
 *
 * Every colour resolves through the active theme, so the banner follows
 * whichever UI mode and light/dark theme is in play rather than pinning the
 * dark palette's hexes.
 *
 * Static by design — it renders once and never animates, so it costs nothing
 * after it scrolls up into the terminal's scrollback.
 */

export interface WelcomeBannerInfo {
    /** Greeting name (OS username). */
    name: string;
    /** "provider/model" id, or empty when no model is selected. */
    model: string;
    /** Session id or "unsaved". */
    session: string;
    /** Non-default agent name, or null. */
    agent: string | null;
    /** Current git branch, or null when not a repo / detached. */
    branch: string | null;
    /** Working directory (already ~-shortened). */
    cwd: string;
    /** loop version, if known. */
    version?: string;
}

const BAR = "█";
/** Space between the rule and the text column. */
const BAR_GAP = "  ";
/** Space between the label column and the value column. */
const LABEL_GAP = "  ";

/**
 * Where the rule's endpoints sit relative to the accent: `top` is how far it
 * is lightened, `bottom` how far it is darkened. On a light terminal the pale
 * end has to stay well short of white or the top of the rule disappears
 * against the canvas, so its ramp is both shallower and shifted darker.
 */
const RAMP = {
    dark: { top: 0.55, bottom: 0.6 },
    light: { top: 0.26, bottom: 0.5 },
};

/**
 * The rule's colours, top to bottom, over `rows` lines. Built from the theme's
 * accent so the banner restyles with the theme; falls back to a flat accent
 * when the accent is a 256-index or the terminal default (a custom theme's
 * choice we cannot interpolate).
 */
function barColors(rows: number): Array<string | null> {
    const accent = theme.raw("accent");
    if (typeof accent !== "string" || !accent.startsWith("#")) return Array(rows).fill(null);
    const ramp = isLightTheme() ? RAMP.light : RAMP.dark;
    const top = mix(accent, "#ffffff", ramp.top);
    const bottom = mix(accent, "#000000", ramp.bottom);
    return Array.from({ length: rows }, (_, i) => mix(top, bottom, rows > 1 ? i / (rows - 1) : 0));
}

export class WelcomeBanner implements Component {
    private cachedWidth?: number;
    private cachedLines?: string[];
    /** Optional "update available" line, set asynchronously after the network check. */
    private updateNotice?: string;

    constructor(
        private readonly tui: TUI,
        private readonly info: WelcomeBannerInfo,
    ) {}

    /** Show (or clear) the update-available line under the masthead and repaint. */
    setUpdateNotice(text: string | undefined): void {
        this.updateNotice = text;
        this.cachedLines = undefined;
        this.tui.requestRender();
    }

    invalidate(): void {
        this.cachedLines = undefined;
        this.cachedWidth = undefined;
    }

    /** The label/value rows, in display order. */
    private rows(): Array<readonly [string, string]> {
        const rows: Array<readonly [string, string]> = [];
        if (this.info.version) rows.push(["version", theme.fg("text", this.info.version)]);
        rows.push([
            "model",
            this.info.model
                ? theme.fg("text", this.info.model)
                : theme.fg("warning", "no model — run /login or /provider"),
        ]);
        if (this.info.branch) rows.push(["branch", theme.fg("text", this.info.branch)]);
        rows.push(["cwd", theme.fg("text", this.info.cwd)]);
        rows.push([
            "session",
            this.info.session === "unsaved" ? theme.fg("dim", "unsaved") : theme.fg("text", this.info.session),
        ]);
        if (this.info.agent) rows.push(["agent", theme.fg("text", this.info.agent)]);
        return rows;
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

        const rows = this.rows();
        const labelWidth = Math.max(...rows.map(([label]) => label.length));

        // Everything that sits beside the gradient rule, in order.
        const beside: string[] = [
            theme.fg("text", theme.bold(PRODUCT_NAME)),
            theme.fg("muted", `Welcome back, ${this.info.name}`),
            "",
            ...rows.map(([label, value]) => theme.fg("dim", label.padEnd(labelWidth)) + LABEL_GAP + value),
        ];
        if (this.updateNotice) {
            beside.push("");
            beside.push(theme.fg("warning", this.updateNotice));
        }
        // The rule must end on the last row that has something beside it — a
        // trailing blank would leave a bar segment hanging under the block.
        while (beside.length > 0 && beside[beside.length - 1] === "") beside.pop();

        const bar = barColors(beside.length);
        const lines: string[] = [""];
        for (let i = 0; i < beside.length; i++) {
            const hex = bar[i];
            // verticalRule, not fgHex: on Terminal.app a column of █ glyphs
            // renders with gaps between the rows, so the rule is painted as a
            // background there instead (see theme.verticalRule).
            const rule = hex ? verticalRule(hex, BAR) : theme.fg("accent", BAR);
            lines.push(` ${rule}${BAR_GAP}${beside[i]}`);
        }
        lines.push("");
        lines.push(
            ` ${theme.fg("dim", "type ")}${theme.fg("text", theme.bold("/help"))}${theme.fg("dim", " for slash commands")}`,
        );
        lines.push(` ${theme.fg("dim", "ctrl+e navigates transcript · shift+tab agents · ctrl+c twice to quit")}`);
        lines.push("");

        // Truncate then pad each line to full width so the differential
        // renderer overwrites cleanly. Truncation matters: a deep cwd made
        // the path row exceed the terminal width, tripping the TUI's
        // width-overflow crash guard (silent exit at startup).
        const padded = lines.map((l) => {
            const truncated = visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l;
            const pad = Math.max(0, width - visibleWidth(truncated));
            return truncated + " ".repeat(pad);
        });

        this.cachedLines = padded;
        this.cachedWidth = width;
        return padded;
    }
}
