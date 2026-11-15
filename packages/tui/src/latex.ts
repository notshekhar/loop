/**
 * Render a basic LaTeX math expression as terminal-friendly Unicode text.
 * The reader, symbol tables and 2D layout live in latex/.
 */
import { renderLayout, PROTECTED_SPACE, type LayoutNode } from "./latex/layout";
import { LatexParser } from "./latex/parser";

export interface RenderLatexOptions {
    /** Stack fractions and operator limits vertically for display math (default: false). */
    display?: boolean;
}

/**
 * Render a basic LaTeX math expression as terminal-friendly Unicode text.
 * Returns undefined when the expression contains unsupported or malformed syntax.
 */
export function renderLatex(source: string, options: RenderLatexOptions = {}): string | undefined {
    const layoutNodes: LayoutNode[] = [];
    const rendered = new LatexParser(source, layoutNodes, options.display === true).render();
    if (rendered === undefined) {
        return undefined;
    }
    if (layoutNodes.length === 0) {
        return rendered.replaceAll(PROTECTED_SPACE, " ");
    }
    const lines = renderLayout(rendered, layoutNodes).lines;
    const indentation = Math.min(
        ...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
    );
    return lines
        .map((line) => line.slice(indentation).trimEnd())
        .join("\n")
        .trimEnd()
        .replaceAll(PROTECTED_SPACE, " ");
}
