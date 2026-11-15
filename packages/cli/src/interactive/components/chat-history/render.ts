import { type Component, Container, logRenderError, truncateToWidth } from "@notshekhar/loop-tui";
import { theme } from "../../ui/theme";
import { renderToolGroup } from "../../ui/blocks/tool-group";
import { AssistantMessageComponent, markSelectedLines } from "../../ui/messages";
import { ToolExecutionComponent } from "../../ui/tool-execution";
import type { FoldSpan } from "../../transcript-folds";
import type { FoldView } from "../transcript-fold-view";
import { type Foldable, type FoldableIndex, foldableIndex } from "./foldables";

/** The lines one foldable occupies in a render — a click target and the
 * scroll anchor for the selection. */
export interface EntryRange {
    fIdx: number;
    start: number;
    end: number;
}

export interface TranscriptRenderInput {
    foldables: readonly Foldable[];
    view: FoldView;
    /** The selected entry, so a fold header standing in for it is marked. */
    selected: Foldable | null;
    /** Filled with each entry's line range as it is drawn. */
    ranges: EntryRange[];
}

/**
 * Draw one piece of the transcript, and never let it take the frame down.
 *
 * The transcript is the one place arbitrary content reaches the renderer —
 * model output, tool output, whatever an extension returns — so it is the one
 * place a render can meet input nobody anticipated. A throw here used to
 * escape the whole frame, and a frame that throws paints nothing: the UI
 * looked frozen until a restart. Now the entry that failed draws a single
 * line saying so, the failure is logged once with its stack, and everything
 * around it keeps working.
 */
function drawSafely(where: string, width: number, draw: () => string[]): string[] {
    try {
        return draw();
    } catch (error) {
        return failedToDraw(where, width, error);
    }
}

/** The one line a piece of the transcript draws in place of itself when it
 * could not be drawn — logged once, with its stack, for the bug report. */
function failedToDraw(where: string, width: number, error: unknown): string[] {
    logRenderError(`transcript ${where}`, error);
    const message = error instanceof Error ? error.message : String(error);
    return [truncateToWidth(theme.fg("error", ` ⚠ could not draw this ${where}: ${message}`), width)];
}

/**
 * Full transcript render with per-entry line ranges — the basis for
 * click-to-select and for scrolling the selection into view.
 *
 * Each entry is drawn according to its fold role: as itself; not at all
 * (hidden inside a closed fold); or as the fold's header — alone while the
 * fold is closed, above its own rows once it is open.
 */
export function renderTranscript(root: Container, width: number, input: TranscriptRenderInput): string[] {
    return new TranscriptPainter(width, input).paint(root.children);
}

/** One render pass: walks the component tree, appending lines and recording
 * which of them belong to which entry. */
class TranscriptPainter {
    private readonly lines: string[] = [];
    private readonly index: FoldableIndex;

    constructor(
        private readonly width: number,
        private readonly input: TranscriptRenderInput,
    ) {
        this.index = foldableIndex(input.foldables);
    }

    paint(children: readonly Component[]): string[] {
        this.walk(children);
        return this.lines;
    }

    private walk(children: readonly Component[]): void {
        const { single } = this.index;
        for (const child of children) {
            if (child instanceof AssistantMessageComponent) {
                this.pushMessage(child);
            } else if (single.has(child)) {
                this.pushSingle(single.get(child)!, child);
            } else if (child instanceof Container) {
                // Plain grouping container (assistant turn) — its render is
                // just child concatenation, so walking keeps line counts
                // identical while reaching the components inside.
                this.walk(child.children);
            } else {
                this.append(drawSafely("line", this.width, () => child.render(this.width)));
            }
        }
    }

    /** An assistant message, split into its block entries. */
    private pushMessage(message: AssistantMessageComponent): void {
        let sub: ReturnType<AssistantMessageComponent["renderTracked"]>;
        try {
            sub = message.renderTracked(this.width);
        } catch (error) {
            this.append(failedToDraw("message", this.width, error));
            return;
        }
        const { foldables } = this.input;
        const byIndex = new Map((this.index.blocks.get(message) ?? []).map((i) => [foldables[i].contentIndex!, i]));
        let cursor = 0;
        for (const b of sub.blocks) {
            // Lines between blocks (an error, an abort note) are the
            // message's own and always drawn.
            this.append(sub.lines.slice(cursor, b.start));
            const blockLines = sub.lines.slice(b.start, b.end + 1);
            const fIdx = byIndex.get(b.contentIndex);
            if (fIdx === undefined) this.append(blockLines);
            else this.push(fIdx, blockLines);
            cursor = b.end + 1;
        }
        this.append(sub.lines.slice(cursor));
    }

    /** A component that is one entry on its own: a prompt, a summary, a call. */
    private pushSingle(fIdx: number, child: Component): void {
        if (child instanceof ToolExecutionComponent) {
            this.pushTool(fIdx, child);
            return;
        }
        this.push(
            fIdx,
            drawSafely(this.input.foldables[fIdx].kind, this.width, () => child.render(this.width)),
        );
    }

    /**
     * A tool call, drawn under its fold role: not at all while a closed run
     * hides it; as the run's header — alone while the run is closed, above
     * its own rows once it is open; or simply as itself.
     */
    private pushTool(fIdx: number, call: ToolExecutionComponent): void {
        const { width } = this;
        const role = this.input.view.roleOf(this.input.foldables[fIdx]);
        if (role.kind === "hidden") return;
        if (role.kind === "self") {
            this.push(
                fIdx,
                drawSafely("tool call", width, () => call.render(width)),
            );
            return;
        }
        const header = drawSafely("fold header", width, () => this.foldHeader(role.span, call.leadsWithGap()));
        // Open, the header has already opened the block, so the row under
        // it is drawn without a blank line of its own.
        const below = role.span.open ? drawSafely("tool call", width, () => call.renderBelowHeader(width)) : [];
        this.push(fIdx, [...header, ...below]);
    }

    /** A fold's header row, marked when its entry is the selection. */
    private foldHeader(span: FoldSpan, lead: boolean): string[] {
        const { view, selected: selectedEntry } = this.input;
        const header = view.header(span);
        const selected = selectedEntry !== null && selectedEntry === view.headerEntry(span);
        const lines = renderToolGroup(
            {
                label: header.label,
                failed: header.failed,
                running: header.running,
                selected,
                expanded: header.open,
                lead,
            },
            { width: this.width, theme },
        );
        return selected ? markSelectedLines(lines) : lines;
    }

    /** Append an entry's lines, recording which lines are that entry's. */
    private push(fIdx: number, entryLines: readonly string[]): void {
        const start = this.lines.length;
        this.append(entryLines);
        if (this.lines.length > start) this.input.ranges.push({ fIdx, start, end: this.lines.length - 1 });
    }

    private append(lines: readonly string[]): void {
        for (const l of lines) this.lines.push(l);
    }
}
