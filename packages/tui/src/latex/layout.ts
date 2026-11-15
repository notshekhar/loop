/**
 * Display math that needs more than one row — stacked fractions, operators
 * with limits above and below, matrices. The parser leaves a marker in its
 * text for each such node; renderLayout lays the text and the nodes out side
 * by side on a shared baseline.
 */
import { visibleWidth } from "../utils";

interface FractionNode {
    type: "fraction";
    numerator: string;
    denominator: string;
}

interface OperatorNode {
    type: "operator";
    operator: string;
    lower?: string;
    upper?: string;
}

interface MatrixNode {
    type: "matrix";
    lines: string[];
    baseline: number;
}

export type LayoutNode = FractionNode | OperatorNode | MatrixNode;

interface Layout {
    lines: string[];
    width: number;
    baseline: number;
}

const LAYOUT_MARKER_START = "\u{f0000}";
const LAYOUT_MARKER_END = "\u{f0001}";
const LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}/gu;
export const TRAILING_LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}$/u;
/** Padding inside a matrix cell that the whitespace normalisation must not collapse. */
export const PROTECTED_SPACE = "\u{f0002}";

/** Store `node` and return the marker that stands for it in the parsed text. */
export function addLayoutNode(nodes: LayoutNode[], node: LayoutNode): string {
    const index = nodes.push(node) - 1;
    return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
}

function padLayoutLine(line: string, width: number, centered = false): string {
    const padding = Math.max(0, width - visibleWidth(line));
    const left = centered ? Math.floor(padding / 2) : 0;
    return `${" ".repeat(left)}${line}${" ".repeat(padding - left)}`;
}

const textLayout = (text: string): Layout => ({ lines: [text], width: visibleWidth(text), baseline: 0 });

function joinLayouts(layouts: readonly Layout[]): Layout {
    if (layouts.length === 0) {
        return { lines: [""], width: 0, baseline: 0 };
    }
    const baseline = Math.max(...layouts.map((layout) => layout.baseline));
    const below = Math.max(...layouts.map((layout) => layout.lines.length - layout.baseline - 1));
    const lines: string[] = [];
    for (let row = 0; row <= baseline + below; row++) {
        let line = "";
        for (const layout of layouts) {
            const sourceRow = row - baseline + layout.baseline;
            line +=
                sourceRow >= 0 && sourceRow < layout.lines.length
                    ? padLayoutLine(layout.lines[sourceRow] ?? "", layout.width)
                    : " ".repeat(layout.width);
        }
        lines.push(line.trimEnd());
    }
    return {
        lines,
        width: layouts.reduce((width, layout) => width + layout.width, 0),
        baseline,
    };
}

export function renderLayout(source: string, nodes: readonly LayoutNode[]): Layout {
    const renderedLines: string[] = [];
    let firstBaseline = 0;
    for (const sourceLine of source.split("\n")) {
        const lineLayout = joinLayouts(layoutLine(sourceLine, nodes));
        if (renderedLines.length === 0) {
            firstBaseline = lineLayout.baseline;
        }
        renderedLines.push(...lineLayout.lines);
    }
    return {
        lines: renderedLines,
        width: Math.max(0, ...renderedLines.map((line) => visibleWidth(line))),
        baseline: firstBaseline,
    };
}

/** One source line: the text between markers, and each marker's node. */
function layoutLine(sourceLine: string, nodes: readonly LayoutNode[]): Layout[] {
    const layouts: Layout[] = [];
    let position = 0;
    let previousNode: LayoutNode | undefined;
    for (const match of sourceLine.matchAll(LAYOUT_MARKER_PATTERN)) {
        const index = match.index;
        const node = nodes[Number(match[1])];
        if (!node) {
            continue;
        }
        if (index > position) {
            layouts.push(textLayout(textBetween(sourceLine.slice(position, index), previousNode, node)));
        }
        layouts.push(layoutNode(node, nodes));
        position = index + match[0].length;
        previousNode = node;
    }
    if (position < sourceLine.length) {
        const sliced = sourceLine.slice(position);
        const trimmed = previousNode ? sliced.trimStart() : sliced;
        layouts.push(textLayout(previousNode?.type === "matrix" && /^\s/.test(sliced) ? ` ${trimmed}` : trimmed));
    }
    return layouts;
}

/** Text between two nodes is trimmed, except for one space kept beside a matrix. */
function textBetween(sliced: string, previousNode: LayoutNode | undefined, nextNode: LayoutNode): string {
    const trimmed = (previousNode ? sliced.trimStart() : sliced).trimEnd();
    const preserveLeadingSpace = previousNode?.type === "matrix" && /^\s/.test(sliced);
    const preserveTrailingSpace = nextNode.type === "matrix" && /\s$/.test(sliced);
    if (trimmed) return `${preserveLeadingSpace ? " " : ""}${trimmed}${preserveTrailingSpace ? " " : ""}`;
    return preserveLeadingSpace || preserveTrailingSpace ? " " : "";
}

function layoutNode(node: LayoutNode, nodes: readonly LayoutNode[]): Layout {
    if (node.type === "fraction") return layoutFraction(node, nodes);
    if (node.type === "operator") return layoutOperator(node);
    const width = Math.max(0, ...node.lines.map((line) => visibleWidth(line)));
    return { lines: node.lines.map((line) => padLayoutLine(line, width)), width, baseline: node.baseline };
}

/** Numerator over a rule over denominator, centred, one space either side. */
function layoutFraction(node: FractionNode, nodes: readonly LayoutNode[]): Layout {
    const numerator = renderLayout(node.numerator, nodes);
    const denominator = renderLayout(node.denominator, nodes);
    const contentWidth = Math.max(numerator.width, denominator.width, 1);
    const width = contentWidth + 2;
    return {
        lines: [
            ...numerator.lines.map((line) => padLayoutLine(line, width, true)),
            ` ${"─".repeat(contentWidth)} `,
            ...denominator.lines.map((line) => padLayoutLine(line, width, true)),
        ],
        width,
        baseline: numerator.lines.length,
    };
}

/** Upper limit, operator, lower limit — centred in a column, one space after. */
function layoutOperator(node: OperatorNode): Layout {
    const contentWidth = Math.max(
        visibleWidth(node.operator),
        node.lower === undefined ? 0 : visibleWidth(node.lower),
        node.upper === undefined ? 0 : visibleWidth(node.upper),
    );
    const rows = [node.upper, node.operator, node.lower].filter((row): row is string => row !== undefined);
    return {
        lines: rows.map((row) => `${padLayoutLine(row, contentWidth, true)} `),
        width: contentWidth + 1,
        baseline: node.upper === undefined ? 0 : 1,
    };
}
