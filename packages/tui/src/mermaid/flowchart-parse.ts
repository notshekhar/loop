export type Direction = "TD" | "BT" | "LR" | "RL";

export type NodeShape = "rect" | "round" | "diamond";

export interface FlowEdge {
    from: string;
    to: string;
    label?: string;
    /** Arrowhead at the `to` end (`-->`); open links (`---`) carry none. */
    head: boolean;
    /** Arrowhead at the `from` end, for `<-->`. */
    tail: boolean;
}

export interface FlowGroup {
    id: string;
    title: string;
    members: string[];
}

export interface ParsedFlowchart {
    direction: Direction;
    nodes: Map<string, { label: string; shape: NodeShape }>;
    edges: FlowEdge[];
    groups: FlowGroup[];
}

/** `subgraph Id["Title"]`, `subgraph Id[Title]`, `subgraph Id` or `subgraph A Title`. */
const SUBGRAPH_PATTERN = /^subgraph\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(?:\[(.*)\]|\((.*)\))?\s*$/;

const DIRECTIONS: Record<string, Direction> = { TD: "TD", TB: "TD", BT: "BT", LR: "LR", RL: "RL" };

/** Lines that configure the render rather than describe the graph. */
const IGNORED = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;

/**
 * Node delimiters, longest opener first so `((x))` is not read as `(` then `(x)`.
 * Shapes a cell grid cannot draw collapse onto the three it can.
 */
const SHAPES: Array<[open: string, close: string, shape: NodeShape]> = [
    ["((", "))", "round"],
    ["([", "])", "round"],
    ["[[", "]]", "rect"],
    ["[(", ")]", "round"],
    ["{{", "}}", "diamond"],
    ["[/", "/]", "rect"],
    ["[/", "\\]", "rect"],
    ["[\\", "\\]", "rect"],
    ["[\\", "/]", "rect"],
    ["[", "]", "rect"],
    ["(", ")", "round"],
    ["{", "}", "diamond"],
    [">", "]", "rect"],
];

const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*/;

interface NodeRef {
    id: string;
    label?: string;
    shape: NodeShape;
    length: number;
}

export function parseNodeRef(source: string): NodeRef | undefined {
    const id = ID_PATTERN.exec(source)?.[0];
    if (!id) return undefined;
    const rest = source.slice(id.length);
    for (const [open, close, shape] of SHAPES) {
        if (!rest.startsWith(open)) continue;
        const end = rest.indexOf(close, open.length);
        if (end === -1) continue;
        return { id, label: rest.slice(open.length, end), shape, length: id.length + end + close.length };
    }
    return { id, shape: "rect", length: id.length };
}

interface Link {
    head: boolean;
    tail: boolean;
    label?: string;
    length: number;
}

const LINK_CHARS = new Set(["-", "=", "."]);

/**
 * Consume one link. Scanned rather than matched: mermaid spells the same edge
 * as `-->`, `-.->,` `==>`, `--x`, `-->|text|` and `-- text -->`, and a single
 * pattern covering all of them stops being readable long before it is correct.
 */
export function parseLink(source: string): Link | undefined {
    let cursor = 0;
    let tail = false;
    if (source[cursor] === "<") {
        tail = true;
        cursor++;
    }
    const start = cursor;
    while (cursor < source.length && LINK_CHARS.has(source[cursor]!)) cursor++;
    if (cursor - start < 2) return undefined;

    let head = false;
    const terminator = source[cursor];
    if (terminator === ">" || terminator === "x" || terminator === "o") {
        head = true;
        cursor++;
    }

    let label: string | undefined;
    if (source[cursor] === "|") {
        const close = source.indexOf("|", cursor + 1);
        if (close === -1) return undefined;
        label = source.slice(cursor + 1, close).trim();
        cursor = close + 1;
    } else if (!head) {
        // `A -- text --> B`: the text sits between two link runs, so the run we
        // just consumed was only the opening half.
        const middle = /^[ \t]*([^|\n]*?)[ \t]*([-=.]{2,})([>xo])?/.exec(source.slice(cursor));
        if (middle) {
            label = middle[1] ? middle[1].trim() : undefined;
            head = Boolean(middle[3]);
            cursor += middle[0].length;
        }
    }

    return { head, tail, label: label || undefined, length: cursor };
}

function unquote(value: string): string {
    const trimmed = value.trim();
    const bare =
        trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;
    // `<br>`, `<br/>` and a literal `\n` are all line breaks to mermaid.
    return bare
        .split(/<br\s*\/?>|\\n/i)
        .map((part) => part.trim())
        .join("\n");
}

export function parseFlowchart(source: string): ParsedFlowchart | undefined {
    const chart = new FlowchartBuilder();
    let seenHeader = false;
    for (const raw of source.split("\n")) {
        const line = raw.replace(/%%.*$/, "").trim();
        if (!line) continue;
        if (!seenHeader) {
            const header = /^(?:flowchart|graph)(?:\s+([A-Za-z]{2}))?\s*(.*)$/.exec(line);
            if (!header) return undefined;
            seenHeader = true;
            if (header[1]) chart.direction = DIRECTIONS[header[1].toUpperCase()] ?? "TD";
            if (!header[2]) continue;
        }
        chart.statement(line);
    }
    if (chart.nodes.size === 0) return undefined;
    return { direction: chart.direction, nodes: chart.nodes, edges: chart.edges, groups: chart.groups };
}

/** Links chained in one statement are capped, so a malformed line can't spin. */
const MAX_CHAINED_LINKS = 64;

class FlowchartBuilder {
    direction: Direction = "TD";
    readonly nodes = new Map<string, { label: string; shape: NodeShape }>();
    readonly edges: FlowEdge[] = [];
    readonly groups: FlowGroup[] = [];
    /** Innermost last, so a node joins the group it sits closest inside. */
    private readonly open: FlowGroup[] = [];

    statement(line: string): void {
        if (IGNORED.test(line)) return;
        if (line === "end") {
            this.open.pop();
            return;
        }
        if (/^subgraph\b/.test(line)) {
            this.openGroup(line);
            return;
        }
        this.chain(line);
    }

    private openGroup(line: string): void {
        const match = SUBGRAPH_PATTERN.exec(line);
        const id = match?.[1] ?? `group${this.groups.length}`;
        const title = match?.[2] ?? match?.[3];
        const group: FlowGroup = { id, title: title === undefined ? id : unquote(title), members: [] };
        this.groups.push(group);
        this.open.push(group);
    }

    /** `A --> B --> C` keeps going from whichever node the last link landed on. */
    private chain(line: string): void {
        let from = parseNodeRef(line);
        if (!from) return;
        this.note(from);
        let cursor = line.slice(from.length).trimStart();
        let guard = 0;
        while (cursor.length > 0 && guard++ < MAX_CHAINED_LINKS) {
            const link = parseLink(cursor);
            if (!link) break;
            cursor = cursor.slice(link.length).trimStart();
            const to = parseNodeRef(cursor);
            if (!to) break;
            this.note(to);
            this.edges.push({ from: from.id, to: to.id, label: link.label, head: link.head, tail: link.tail });
            cursor = cursor.slice(to.length).trimStart();
            from = to;
        }
    }

    private note(ref: NodeRef): void {
        const group = this.open[this.open.length - 1];
        if (group && !group.members.includes(ref.id)) group.members.push(ref.id);
        const existing = this.nodes.get(ref.id);
        const label = ref.label === undefined ? undefined : unquote(ref.label);
        if (!existing) {
            this.nodes.set(ref.id, { label: label ?? ref.id, shape: ref.shape });
            return;
        }
        // A later definition carrying a real label beats an earlier bare mention.
        if (label !== undefined) {
            existing.label = label;
            existing.shape = ref.shape;
        }
    }
}
