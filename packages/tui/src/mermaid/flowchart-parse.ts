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
    const lines = source.split("\n");
    let direction: Direction = "TD";
    const nodes = new Map<string, { label: string; shape: NodeShape }>();
    const edges: FlowEdge[] = [];
    const groups: FlowGroup[] = [];
    // Innermost first, so a node joins the group it sits closest inside.
    const open: FlowGroup[] = [];
    let seenHeader = false;

    const note = (ref: NodeRef) => {
        const group = open[open.length - 1];
        if (group && !group.members.includes(ref.id)) group.members.push(ref.id);
        const existing = nodes.get(ref.id);
        const label = ref.label === undefined ? undefined : unquote(ref.label);
        if (!existing) {
            nodes.set(ref.id, { label: label ?? ref.id, shape: ref.shape });
            return;
        }
        // A later definition carrying a real label beats an earlier bare mention.
        if (label !== undefined) {
            existing.label = label;
            existing.shape = ref.shape;
        }
    };

    for (const raw of lines) {
        const line = raw.replace(/%%.*$/, "").trim();
        if (!line) continue;

        if (!seenHeader) {
            const header = /^(?:flowchart|graph)(?:\s+([A-Za-z]{2}))?\s*(.*)$/.exec(line);
            if (!header) return undefined;
            seenHeader = true;
            if (header[1]) direction = DIRECTIONS[header[1].toUpperCase()] ?? "TD";
            if (!header[2]) continue;
        }

        if (IGNORED.test(line)) continue;
        if (line === "end") {
            open.pop();
            continue;
        }
        if (/^subgraph\b/.test(line)) {
            const match = SUBGRAPH_PATTERN.exec(line);
            const id = match?.[1] ?? `group${groups.length}`;
            const title = match?.[2] ?? match?.[3];
            const group: FlowGroup = { id, title: title === undefined ? id : unquote(title), members: [] };
            groups.push(group);
            open.push(group);
            continue;
        }

        let cursor = line;
        let from = parseNodeRef(cursor);
        if (!from) continue;
        note(from);
        cursor = cursor.slice(from.length).trimStart();

        // `A --> B --> C` keeps going from whichever node the last link landed on.
        let guard = 0;
        while (cursor.length > 0 && guard++ < 64) {
            const link = parseLink(cursor);
            if (!link) break;
            cursor = cursor.slice(link.length).trimStart();
            const to = parseNodeRef(cursor);
            if (!to) break;
            note(to);
            edges.push({ from: from.id, to: to.id, label: link.label, head: link.head, tail: link.tail });
            cursor = cursor.slice(to.length).trimStart();
            from = to;
        }
    }

    if (nodes.size === 0) return undefined;
    return { direction, nodes, edges, groups };
}
