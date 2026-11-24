/**
 * ShellsPanel — the pinned list of background shells (bash run_in_background).
 * Mounted in the app's fixed bottom region beside the todo panel, so a running
 * dev server stays visible while the conversation scrolls.
 *
 * This panel is what pays for backgrounding at all. bash bounds every
 * foreground run with a timeout because an unbounded one is invisible; a shell
 * listed here is not invisible, which is why promotion-on-timeout is gated on
 * this panel being mounted (setShellPanelPresent).
 *
 * Renders zero rows when nothing has ever run, so it costs no space until it
 * has something to say. Exited shells stay listed until the turn ends: a frame
 * that SHRINKS mid-turn is the one shape the renderer cannot take back (see
 * tui.ts's committed rows), and a row that vanishes the instant a process dies
 * is the easiest way to cause one.
 */
import { truncateToWidth, visibleWidth, type Component } from "@notshekhar/loop-tui";
import { formatDuration, type ShellInfo } from "@notshekhar/loop-core";
import { accentTitle, dim, dimStruck } from "../ui/text";

const MAX_ROWS = 4;

/**
 * The panel's last row: where to go to stop one. Shown whenever the panel has
 * rows at all — tying it to "something is running" would make the panel
 * shrink mid-turn the moment the last shell exits (see the header).
 */
export const SHELLS_HINT = "/shells to stop one or read its output";

function clip(s: string, width: number): string {
    return visibleWidth(s) <= width ? s : truncateToWidth(s, width, "…");
}

function statusCell(s: ShellInfo): string {
    if (s.status === "running") return formatDuration(Date.now() - s.startedAt);
    if (s.status === "killed") return "killed";
    if (s.status === "failed") return "failed";
    return s.exitCode === 0 ? "done" : `exit ${s.exitCode ?? "?"}`;
}

/** The most recent non-empty output line, for the row's trailing hint. */
function lastLine(s: ShellInfo): string {
    for (let i = s.preview.length - 1; i >= 0; i--) {
        const line = s.preview[i].trim();
        if (line) return line;
    }
    return "";
}

const MARKER_WIDTH = 4; // "[~] "
const GAP = 2; // between the command, the hint and the status

/**
 * One row: `[~] bash_1  bun run dev      ready in 340ms   2m14s`
 *
 * Laid out right to left, because the two things that must never be lost are
 * which shell this is and what state it is in. The status is reserved first,
 * the id and command next, and the process's last line takes whatever is left
 * — it is the first thing to disappear on a narrow terminal, and is dropped
 * entirely rather than clipped to a stub.
 */
export function formatShellRow(s: ShellInfo, width: number): string {
    const status = statusCell(s);
    const head = `${s.id}  ${s.command.split("\n")[0]}`;
    const avail = Math.max(1, width - MARKER_WIDTH);
    const forHead = Math.max(1, avail - visibleWidth(status) - GAP);

    let body: string;
    const tail = lastLine(s);
    // A hint is only worth showing if the command is fully visible and there
    // is real room after it — half a log line reads as noise.
    const headRoom = visibleWidth(head);
    const hintRoom = forHead - headRoom - GAP;
    if (tail && headRoom <= forHead && hintRoom >= 12) {
        const hint = clip(tail, hintRoom);
        const pad = forHead - headRoom - visibleWidth(hint);
        body = `${head}${" ".repeat(Math.max(GAP, pad))}${hint}`;
    } else {
        const left = clip(head, forHead);
        body = left + " ".repeat(Math.max(0, forHead - visibleWidth(left)));
    }

    const line = `${body}${" ".repeat(GAP)}${status}`;
    // [~] running · [x] finished cleanly · [-] killed · [!] something went wrong
    const marker =
        s.status === "running"
            ? "[~] "
            : s.status === "killed"
              ? "[-] "
              : s.status === "exited" && s.exitCode === 0
                ? "[x] "
                : "[!] ";
    const text = marker + line;
    if (s.status === "running") return accentTitle(text);
    if (s.status === "killed") return dimStruck(text);
    return dim(text);
}

export class ShellsPanel implements Component {
    private shells: ShellInfo[] = [];

    /** Replace the list. The registry is the source of truth; this is a view. */
    setShells(shells: ShellInfo[]): void {
        this.shells = shells;
    }

    isEmpty(): boolean {
        return this.shells.length === 0;
    }

    hasRunning(): boolean {
        return this.shells.some((s) => s.status === "running");
    }

    /** Drop finished shells at a turn boundary — see the header on why the
     * panel does not do this the moment a process exits. */
    retireFinished(): void {
        this.shells = this.shells.filter((s) => s.status === "running");
    }

    clear(): void {
        this.shells = [];
    }

    invalidate(): void {}

    render(width: number): string[] {
        if (this.shells.length === 0) return [];
        // Running first, then the most recently finished: a dead shell should
        // never push a live one off the panel.
        const ordered = [...this.shells].sort((a, b) => {
            if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
            return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
        });
        const shown = ordered.slice(0, MAX_ROWS);
        const rows = shown.map((s) => formatShellRow(s, width));
        const hidden = ordered.length - shown.length;
        const more = hidden > 0 ? `+${hidden} more · ` : "";
        rows.push(clip(dim(`    ${more}${SHELLS_HINT}`), width));
        return rows;
    }
}
