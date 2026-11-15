/** \begin{…}…\end{…} environments: equations, aligned rows, cases and matrices. */
import { visibleWidth } from "../utils";
import { addLayoutNode, PROTECTED_SPACE, type LayoutNode } from "./layout";

/** What an environment needs from the parser that found it. */
export interface EnvironmentHost {
    /** Render LaTeX source with a fresh parser sharing the layout nodes. */
    renderNested(source: string, stackFractions?: boolean): string;
    readonly layoutNodes: LayoutNode[];
    /** Mark the expression as unsupported. */
    fail(): void;
}

const EQUATION_ENVIRONMENTS = new Set(["equation", "equation*", "displaymath"]);
const ALIGNED_ENVIRONMENTS = new Set([
    "aligned",
    "align",
    "align*",
    "alignedat",
    "alignat",
    "alignat*",
    "gather",
    "gathered",
    "multline",
    "multline*",
    "split",
]);
/** alignat-style environments pair their columns: `a & b & c & d` is two cells. */
const PAIRED_COLUMN_ENVIRONMENTS = new Set(["alignedat", "alignat", "alignat*"]);
const CASES_ENVIRONMENTS = new Set(["cases", "cases*"]);
const MATRIX_ENVIRONMENTS = new Set([
    "array",
    "matrix",
    "smallmatrix",
    "pmatrix",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
]);
/** Matrices drawn without brackets. */
const BARE_MATRIX_ENVIRONMENTS = new Set(["array", "matrix", "smallmatrix"]);

/** Top-left, top-right, middle-left, middle-right, bottom-left, bottom-right. */
type Delimiters = readonly [string, string, string, string, string, string];

const MATRIX_DELIMITERS: Readonly<Record<string, Delimiters>> = {
    pmatrix: ["⎛", "⎞", "⎜", "⎟", "⎝", "⎠"],
    bmatrix: ["⎡", "⎤", "⎢", "⎥", "⎣", "⎦"],
    Bmatrix: ["⎧", "⎫", "⎨", "⎬", "⎩", "⎭"],
    vmatrix: ["│", "│", "│", "│", "│", "│"],
    Vmatrix: ["║", "║", "║", "║", "║", "║"],
};

/** A leading `{…}` column spec (array, alignat) carries no content. */
const stripColumnSpec = (body: string) => body.replace(/^\s*\{[^}]*\}/, "");

function splitEnvironmentRows(body: string): string[] {
    return body.split(/\\\\(?:\[[^\]\n]*\])?/);
}

/** Rows of cells, each rendered as inline math; rows with nothing in them dropped. */
function renderCells(host: EnvironmentHost, body: string): string[][] {
    return splitEnvironmentRows(body)
        .map((row) => row.split("&").map((cell) => host.renderNested(cell, false).trim()))
        .filter((row) => row.some(Boolean));
}

export function renderEnvironment(host: EnvironmentHost, environment: string, body: string): string {
    if (EQUATION_ENVIRONMENTS.has(environment)) return host.renderNested(body).trim();
    if (ALIGNED_ENVIRONMENTS.has(environment)) return renderAligned(host, environment, body);
    if (CASES_ENVIRONMENTS.has(environment)) return renderCases(host, body);
    if (MATRIX_ENVIRONMENTS.has(environment)) {
        return renderMatrix(host, environment, environment === "array" ? stripColumnSpec(body) : body);
    }
    host.fail();
    return body;
}

/** One line per row; alignment points are dropped. */
function renderAligned(host: EnvironmentHost, environment: string, body: string): string {
    const paired = PAIRED_COLUMN_ENVIRONMENTS.has(environment);
    return splitEnvironmentRows(paired ? stripColumnSpec(body) : body)
        .map((row) => {
            const cells = row.split("&");
            const source = paired
                ? Array.from({ length: Math.ceil(cells.length / 2) }, (_, index) =>
                      cells.slice(index * 2, index * 2 + 2).join(""),
                  ).join(" ")
                : cells.join("");
            return host.renderNested(source).trim();
        })
        .filter(Boolean)
        .join("\n");
}

/** `⎧ value if condition` rows under a tall brace. */
function renderCases(host: EnvironmentHost, body: string): string {
    const rows = renderCells(host, body);
    return rows
        .map((row, index) => {
            const value = (row[0] ?? "").replace(/,\s*$/, "");
            const condition = row[1] ?? "";
            const delimiter = index === 0 ? "⎧" : index === rows.length - 1 ? "⎩" : "⎨";
            const conditionPrefix = /^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ";
            return `${delimiter} ${value}${condition ? `${conditionPrefix}${condition}` : ""}`;
        })
        .join("\n");
}

function renderMatrix(host: EnvironmentHost, environment: string, body: string): string {
    const rows = alignedMatrixRows(renderCells(host, body));
    let lines: string[];
    if (BARE_MATRIX_ENVIRONMENTS.has(environment)) {
        lines = rows;
    } else {
        const delimiter = MATRIX_DELIMITERS[environment];
        if (!delimiter) {
            host.fail();
            return rows.join("\n");
        }
        lines = rows.map((row, index) => bracketRow(row, index, rows.length, delimiter));
    }
    if (lines.length <= 1) {
        return lines[0] ?? "";
    }
    return addLayoutNode(host.layoutNodes, { type: "matrix", lines, baseline: 0 });
}

/** Cells padded to their column's width and joined with a rule. */
function alignedMatrixRows(matrix: string[][]): string[] {
    const columnCount = Math.max(0, ...matrix.map((row) => row.length));
    const columnWidths = Array.from({ length: columnCount }, (_, column) =>
        Math.max(0, ...matrix.map((row) => visibleWidth(row[column] ?? ""))),
    );
    return matrix.map((row) =>
        Array.from({ length: columnCount }, (_, column) => {
            const cell = row[column] ?? "";
            return `${cell}${PROTECTED_SPACE.repeat(Math.max(0, (columnWidths[column] ?? 0) - visibleWidth(cell)))}`;
        }).join(" │ "),
    );
}

function bracketRow(row: string, index: number, rowCount: number, delimiter: Delimiters): string {
    const left = index === 0 ? delimiter[0] : index === rowCount - 1 ? delimiter[4] : delimiter[2];
    const right = index === 0 ? delimiter[1] : index === rowCount - 1 ? delimiter[5] : delimiter[3];
    return `${left} ${row} ${right}`;
}
