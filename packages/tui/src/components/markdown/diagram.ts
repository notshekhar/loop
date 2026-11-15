import type { Tokens } from "marked";
import { type MermaidStyle, renderMermaid } from "../../mermaid";

/** A growing block would otherwise keep every frame it passed through. */
const MAX_CACHED_DIAGRAMS = 8;

/**
 * ```mermaid blocks, drawn — including while still arriving, so a diagram
 * grows in like every other block instead of sitting as source and popping
 * at the end.
 *
 * Only whole lines are laid out. A half-written `A[Requ` parses as a bare
 * node, so the box would flicker through its own label a character at a
 * time; waiting for the newline costs one line of latency and removes that
 * entirely. Layout is memoised on the source, so the deltas that arrive
 * mid-line cost nothing.
 */
export class DiagramRenderer {
    private cache = new Map<string, { lines: string[] | undefined }>();

    clear(): void {
        this.cache.clear();
    }

    /** The diagram's lines, or undefined when the block isn't mermaid or has no whole line yet. */
    render(token: Tokens.Code, width: number, style: Partial<MermaidStyle> | undefined): string[] | undefined {
        if ((token.lang ?? "").trim().split(/\s+/)[0] !== "mermaid") return undefined;
        const source = settledSource(token);
        if (source === undefined) return undefined;
        const key = `${width}\u0000${source}`;
        const memo = this.cache.get(key);
        if (memo !== undefined) return memo.lines;
        const lines = renderMermaid(source, { width, style });
        if (this.cache.size >= MAX_CACHED_DIAGRAMS) this.cache.clear();
        this.cache.set(key, { lines });
        return lines;
    }
}

/** The whole source of a closed block, or the complete lines of one still arriving. */
function settledSource(token: Tokens.Code): string | undefined {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1];
    const closed = !fence || new RegExp(`\n {0,3}${fence[0]}{${fence.length},}[ \t]*\n?$`).test(token.raw);
    if (closed) return token.text;
    const settled = token.text.lastIndexOf("\n");
    return settled <= 0 ? undefined : token.text.slice(0, settled);
}
