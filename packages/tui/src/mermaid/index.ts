import type { MermaidStyle } from "./canvas";
import { drawFlowchart } from "./flowchart";
import { foldGroups } from "./flowchart-groups";
import { parseFlowchart } from "./flowchart-parse";
import { drawSequence, parseSequence } from "./sequence";

export type { MermaidStyle, Role } from "./canvas";

export interface RenderMermaidOptions {
    /** Cells available for the diagram; a diagram wider than this is declined. */
    width: number;
    style?: Partial<MermaidStyle>;
}

const PLAIN = (text: string) => text;

const DEFAULT_STYLE: MermaidStyle = {
    border: PLAIN,
    label: PLAIN,
    edge: PLAIN,
    accent: PLAIN,
    muted: PLAIN,
};

/** The header word decides the grammar, exactly as it does in mermaid. */
function detect(source: string): "flowchart" | "sequence" | undefined {
    for (const raw of source.split("\n")) {
        const line = raw.replace(/%%.*$/, "").trim();
        if (!line) continue;
        if (/^(flowchart|graph)\b/.test(line)) return "flowchart";
        if (/^sequenceDiagram\b/.test(line)) return "sequence";
        return undefined;
    }
    return undefined;
}

/**
 * Render a mermaid diagram into terminal lines, or `undefined` when the source
 * is a kind we do not draw, is malformed, or will not fit the given width. The
 * caller falls back to showing the fenced source, which is what mermaid text
 * looked like before this existed.
 */
export function renderMermaid(source: string, options: RenderMermaidOptions): string[] | undefined {
    const width = Math.floor(options.width);
    if (!Number.isFinite(width) || width < 8) return undefined;
    const style = { ...DEFAULT_STYLE, ...options.style };

    try {
        const kind = detect(source);
        if (kind === "flowchart") {
            const parsed = parseFlowchart(source);
            // Far past anything a terminal could show. Bailing here rather than
            // after layout keeps the cost of a pasted-in monster off the render
            // path, since the result would be declined for width regardless.
            if (!parsed || parsed.nodes.size > 120 || parsed.edges.length > 240) return undefined;
            return drawFlowchart(foldGroups(parsed), width)?.emit(style);
        }
        if (kind === "sequence") {
            const parsed = parseSequence(source);
            if (!parsed || parsed.participants.length > 40 || parsed.events.length > 400) return undefined;
            return drawSequence(parsed, width)?.emit(style);
        }
        return undefined;
    } catch {
        // A diagram is decoration: a parse or layout slip must never take a
        // message down with it.
        return undefined;
    }
}
