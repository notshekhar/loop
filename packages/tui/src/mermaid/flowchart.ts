import { visibleWidth, wrapTextWithAnsi } from "../utils";
import { Canvas } from "./canvas";
import type { Direction, FlowEdge, NodeShape, ParsedFlowchart } from "./flowchart-parse";

/** Cells left between two boxes on the cross axis. */
const CROSS_GAP = 2;
/**
 * A placeholder is one cell of line, not a box, so it needs less clearance than
 * two boxes do. Tightening it is what keeps a long edge in an LR chart from
 * opening a corridor twice as wide as the line running down it.
 */
const gapBetween = (left: LayoutNode, right: LayoutNode) => (left.virtual || right.virtual ? 1 : CROSS_GAP);
/** Cells a label is inset from its box border. */
const PAD = 1;

interface LayoutNode {
    id: string;
    virtual: boolean;
    label: string[];
    shape: NodeShape;
    rank: number;
    order: number;
    /** Extent on the cross axis. */
    breadth: number;
    /** Extent on the flow axis. */
    depth: number;
    cross: number;
    flow: number;
}

/** One edge after splitting across the ranks it spans; each hop joins adjacent ranks. */
interface Hop {
    from: string;
    to: string;
    edge: FlowEdge;
    first: boolean;
    last: boolean;
    /** Lane inside the band that carries this hop's turn, or -1 when it runs straight. */
    channel: number;
    /** Lane the label sits on. A straight hop still needs one, or two edges
     * leaving the same node write their labels over each other. */
    labelLane?: number;
    /** Absolute flow coordinate of the lane, resolved once the bands are placed. */
    laneFlow?: number;
    labelFlow?: number;
    label?: string;
}

const vertical = (direction: Direction) => direction === "TD" || direction === "BT";
const reversed = (direction: Direction) => direction === "BT" || direction === "RL";
const centreOf = (node: LayoutNode) => node.cross + Math.floor(node.breadth / 2);

/**
 * Rank every node by longest path from a source. Edges that close a cycle are
 * found by DFS colouring and left out of the ranking, so a cyclic graph still
 * lays out; the edge itself is still drawn.
 */
function assignRanks(ids: string[], edges: FlowEdge[]): Map<string, number> {
    const outgoing = new Map<string, number[]>(ids.map((id) => [id, []]));
    edges.forEach((edge, index) => {
        if (edge.from !== edge.to) outgoing.get(edge.from)?.push(index);
    });

    const back = new Set<number>();
    const state = new Map<string, 0 | 1 | 2>();
    const visit = (id: string) => {
        state.set(id, 1);
        for (const index of outgoing.get(id) ?? []) {
            const next = edges[index]!.to;
            const seen = state.get(next) ?? 0;
            if (seen === 1) back.add(index);
            else if (seen === 0) visit(next);
        }
        state.set(id, 2);
    };
    for (const id of ids) if ((state.get(id) ?? 0) === 0) visit(id);

    const forward = edges.filter((edge, index) => !back.has(index) && edge.from !== edge.to);
    const ranks = new Map<string, number>(ids.map((id) => [id, 0]));
    // Relaxation rather than a topological walk: with back edges removed the
    // graph is acyclic, so |V| passes always settle the longest path.
    for (let pass = 0; pass < ids.length; pass++) {
        let moved = false;
        for (const edge of forward) {
            const next = (ranks.get(edge.from) ?? 0) + 1;
            if (next > (ranks.get(edge.to) ?? 0)) {
                ranks.set(edge.to, next);
                moved = true;
            }
        }
        if (!moved) break;
    }
    return ranks;
}

function measure(label: string[], shape: NodeShape, direction: Direction): { breadth: number; depth: number } {
    const text = Math.max(1, ...label.map((line) => visibleWidth(line)));
    // A diamond keeps one extra cell each side for its markers.
    const extra = shape === "diamond" ? 2 : 0;
    const width = text + PAD * 2 + 2 + extra;
    const height = label.length + 2;
    return vertical(direction) ? { breadth: width, depth: height } : { breadth: height, depth: width };
}

interface Neighbours {
    above: Map<string, LayoutNode[]>;
    below: Map<string, LayoutNode[]>;
}

function neighboursOf(nodes: Map<string, LayoutNode>, hops: Hop[]): Neighbours {
    const above = new Map<string, LayoutNode[]>();
    const below = new Map<string, LayoutNode[]>();
    const push = (map: Map<string, LayoutNode[]>, key: string, value: LayoutNode) => {
        const list = map.get(key);
        if (list) list.push(value);
        else map.set(key, [value]);
    };
    for (const hop of hops) {
        const from = nodes.get(hop.from);
        const to = nodes.get(hop.to);
        if (!from || !to || from.rank === to.rank) continue;
        // Keyed by rank, not by which way the edge points: an edge that closes a
        // cycle runs from a lower rank to a higher one, and letting it record
        // itself as an incoming neighbour makes each pass chase a position the
        // next pass undoes, walking the whole chart sideways.
        const [upper, lower] = from.rank < to.rank ? [from, to] : [to, from];
        push(above, lower.id, upper);
        push(below, upper.id, lower);
    }
    return { above, below };
}

/**
 * Barycentre sweeps: cheap, and enough to untangle the fan-outs that make up
 * almost every hand-written flowchart.
 */
function orderRanks(byRank: LayoutNode[][], { above, below }: Neighbours): void {
    for (const rank of byRank) rank.forEach((node, index) => (node.order = index));

    for (let pass = 0; pass < 4; pass++) {
        const downward = pass % 2 === 0;
        const order = downward ? [...byRank.keys()] : [...byRank.keys()].reverse();
        for (const index of order) {
            const rank = byRank[index]!;
            if (rank.length < 2) continue;
            const weights = new Map<string, number>();
            for (const node of rank) {
                const others = (downward ? above : below).get(node.id) ?? [];
                const weight = others.length
                    ? others.reduce((sum, other) => sum + other.order, 0) / others.length
                    : node.order;
                weights.set(node.id, weight);
            }
            rank.sort((left, right) => (weights.get(left.id) ?? 0) - (weights.get(right.id) ?? 0));
            rank.forEach((node, position) => (node.order = position));
        }
    }
}

/**
 * Cross-axis coordinates. Packing each rank and centring it against the widest
 * one looks tidy on a balanced tree and wrong on everything else: a rank that
 * a placeholder made wider drags its real nodes out of line with the rank above.
 * So nodes are pulled toward the median of their neighbours instead, then
 * clamped apart, which is what keeps a chain drawn as a straight line.
 */
function placeCross(byRank: LayoutNode[][], { above, below }: Neighbours): void {
    for (const rank of byRank) {
        let cursor = 0;
        rank.forEach((node, position) => {
            node.cross = cursor;
            const next = rank[position + 1];
            cursor += node.breadth + (next ? gapBetween(node, next) : 0);
        });
    }

    const median = (values: number[]) => {
        const sorted = [...values].sort((left, right) => left - right);
        const middle = sorted.length >> 1;
        return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
    };

    // An odd number of passes so the last one runs downward: an upward pass
    // leaves every sink wherever its own last move put it, which is what pulls
    // a join out from under the branches feeding it.
    for (let pass = 0; pass < 7; pass++) {
        const downward = pass % 2 === 0;
        const order = downward ? [...byRank.keys()] : [...byRank.keys()].reverse();
        for (const index of order) {
            const rank = byRank[index]!;
            const desired = rank.map((node) => {
                const all = (downward ? above : below).get(node.id) ?? [];
                // Line up with real neighbours where there are any; a placeholder
                // is only ever a bend in someone else's edge, and letting it vote
                // drags a straight chain off its own axis.
                const real = all.filter((other) => !other.virtual);
                const others = real.length > 0 ? real : all;
                if (others.length === 0) return node.cross;
                return median(others.map(centreOf)) - Math.floor(node.breadth / 2);
            });
            // Left to right, honouring each node's wish but never overlapping.
            for (let position = 0; position < rank.length; position++) {
                const node = rank[position]!;
                const previous = rank[position - 1];
                const floor = previous ? previous.cross + previous.breadth + gapBetween(previous, node) : -Infinity;
                node.cross = Math.max(desired[position]!, floor === -Infinity ? desired[position]! : floor);
            }
            // Right to left, giving back any slack the first pass overshot.
            for (let position = rank.length - 2; position >= 0; position--) {
                const node = rank[position]!;
                const next = rank[position + 1]!;
                const previous = rank[position - 1];
                const ceiling = next.cross - gapBetween(node, next) - node.breadth;
                const floor = previous ? previous.cross + previous.breadth + gapBetween(previous, node) : -Infinity;
                const want = Math.min(desired[position]!, ceiling);
                node.cross = floor === -Infinity ? want : Math.max(want, floor);
            }
        }
    }

    const lowest = Math.min(...byRank.flatMap((rank) => rank.map((node) => node.cross)));
    for (const rank of byRank) for (const node of rank) node.cross -= lowest;
}

export interface FlowchartLayout {
    nodes: LayoutNode[];
    hops: Hop[];
    width: number;
    height: number;
    direction: Direction;
}

/**
 * Longest label a node may carry on one line. Left unbounded a single prose
 * label sets the width of its whole rank, and a handful of them push a diagram
 * past any terminal — wrapping costs a row or two and saves tens of columns.
 */
function wrapLabel(label: string, limit: number): string[] {
    return label.split("\n").flatMap((line) => (visibleWidth(line) <= limit ? [line] : wrapTextWithAnsi(line, limit)));
}

export function layoutFlowchart(parsed: ParsedFlowchart, limit = Infinity): FlowchartLayout | undefined {
    const { direction } = parsed;
    const ids = [...parsed.nodes.keys()];
    const ranks = assignRanks(ids, parsed.edges);

    const nodes = new Map<string, LayoutNode>();
    for (const id of ids) {
        const spec = parsed.nodes.get(id)!;
        const label = wrapLabel(spec.label, limit);
        const { breadth, depth } = measure(label, spec.shape, direction);
        nodes.set(id, {
            id,
            virtual: false,
            label,
            shape: spec.shape,
            rank: ranks.get(id) ?? 0,
            order: 0,
            breadth,
            depth,
            cross: 0,
            flow: 0,
        });
    }

    // Split every edge into single-rank hops, inserting a virtual node for each
    // rank crossed. Those placeholders reserve cross-axis space, which is what
    // keeps a long edge from being drawn straight through an unrelated box.
    const hops: Hop[] = [];
    let virtualCount = 0;
    for (const edge of parsed.edges) {
        const from = nodes.get(edge.from)!;
        const to = nodes.get(edge.to)!;
        // A self-loop has nowhere to go in a cell grid; the node still renders.
        if (edge.from === edge.to) continue;
        const span = Math.abs(to.rank - from.rank);
        if (span <= 1) {
            hops.push({ from: edge.from, to: edge.to, edge, first: true, last: true, channel: 0, label: edge.label });
            continue;
        }
        const step = to.rank >= from.rank ? 1 : -1;
        let previous = edge.from;
        for (let offset = 1; offset < span; offset++) {
            const id = ` v${virtualCount++}`;
            nodes.set(id, {
                id,
                virtual: true,
                label: [],
                shape: "rect",
                rank: from.rank + step * offset,
                order: 0,
                breadth: 1,
                depth: 1,
                cross: 0,
                flow: 0,
            });
            hops.push({
                from: previous,
                to: id,
                edge,
                first: offset === 1,
                last: false,
                channel: 0,
                label: offset === 1 ? edge.label : undefined,
            });
            previous = id;
        }
        hops.push({ from: previous, to: edge.to, edge, first: false, last: true, channel: 0 });
    }

    const rankCount = Math.max(...[...nodes.values()].map((node) => node.rank)) + 1;
    const byRank: LayoutNode[][] = Array.from({ length: rankCount }, () => []);
    for (const node of nodes.values()) byRank[node.rank]!.push(node);
    const neighbours = neighboursOf(nodes, hops);
    orderRanks(byRank, neighbours);
    for (const rank of byRank) rank.sort((left, right) => left.order - right.order);

    placeCross(byRank, neighbours);
    let crossExtent = Math.max(...[...nodes.values()].map((node) => node.cross + node.breadth));

    // Band sizing. A hop whose ends do not line up needs a lane to turn in, and
    // two hops share a lane only when their spans do not overlap.
    // Along the flow axis a label reads across the lanes, so in TD it needs its
    // own lane and room beside the turn. Across it — LR — text cannot follow a
    // vertical lane at all, so the label rides the approach to its target and
    // the band has to be wide enough to hold it.
    const alongFlow = vertical(direction);
    const bands: number[] = [];
    // A label sitting beside a lane can reach past the widest box, and a
    // two-node chart is narrower than its own edge label more often than not.
    let labelExtent = 0;
    for (let rank = 0; rank < rankCount - 1; rank++) {
        const crossing = hops.filter((hop) => Math.min(nodes.get(hop.from)!.rank, nodes.get(hop.to)!.rank) === rank);
        const lanes: Array<Array<{ span: [number, number]; label: boolean }>> = [];
        let labelSpace = 0;
        for (const hop of crossing) {
            const from = nodes.get(hop.from)!;
            const to = nodes.get(hop.to)!;
            const straight = centreOf(from) === centreOf(to);
            hop.channel = straight ? -1 : 0;
            if (hop.label) labelSpace = Math.max(labelSpace, visibleWidth(hop.label) + 2);
            if (hop.label && alongFlow) {
                const anchor = (straight ? centreOf(from) : Math.min(centreOf(from), centreOf(to))) + 1;
                labelExtent = Math.max(labelExtent, anchor + visibleWidth(hop.label) + 2);
            }
            if (straight && !(hop.label && alongFlow)) continue;

            const label = Boolean(hop.label) && alongFlow;
            const text = label ? visibleWidth(hop.label!) + 2 : 0;
            const span: [number, number] = straight
                ? [centreOf(from), centreOf(from) + text]
                : [Math.min(centreOf(from), centreOf(to)), Math.max(centreOf(from), centreOf(to)) + text];
            // Two runs may share a lane when they do not overlap. Bare runs are
            // allowed to touch, because where they meet is a node they both
            // reach; a label needs the clearance to stay readable.
            let lane = lanes.findIndex((taken) =>
                taken.every((other) =>
                    label || other.label
                        ? span[1] < other.span[0] || span[0] > other.span[1]
                        : span[1] <= other.span[0] || span[0] >= other.span[1],
                ),
            );
            if (lane === -1) lane = lanes.push([]) - 1;
            lanes[lane]!.push({ span, label });
            if (label) hop.labelLane = lane;
            if (!straight) hop.channel = lane;
        }
        // A lead-in cell, the lanes, a lead-out cell, and — across the flow —
        // the run the label sits on.
        bands.push(Math.max(2, 1 + lanes.length + 1 + (alongFlow ? 0 : labelSpace)));
    }

    crossExtent = Math.max(crossExtent, labelExtent);

    let flow = 0;
    const bandFlow: number[] = [];
    for (let rank = 0; rank < rankCount; rank++) {
        const depth = Math.max(1, ...byRank[rank]!.map((node) => node.depth));
        for (const node of byRank[rank]!) {
            // A placeholder spans its whole rank, so the edge passing through
            // meets the bands on both sides instead of breaking either side of it.
            if (node.virtual) node.depth = depth;
            node.flow = flow + Math.floor((depth - node.depth) / 2);
        }
        bandFlow.push(flow + depth);
        flow += depth + (bands[rank] ?? 0);
    }
    const flowExtent = flow;

    // BT and RL are the same layout read from the far end.
    if (reversed(direction)) {
        for (const node of nodes.values()) node.flow = flowExtent - node.flow - node.depth;
        for (let rank = 0; rank < bandFlow.length; rank++) {
            bandFlow[rank] = flowExtent - bandFlow[rank]! - (bands[rank] ?? 0);
        }
    }

    for (const hop of hops) {
        const band = Math.min(nodes.get(hop.from)!.rank, nodes.get(hop.to)!.rank);
        hop.laneFlow = hop.channel < 0 ? undefined : (bandFlow[band] ?? 0) + 1 + hop.channel;
        hop.labelFlow = hop.labelLane === undefined ? undefined : (bandFlow[band] ?? 0) + 1 + hop.labelLane;
    }

    const width = vertical(direction) ? crossExtent : flowExtent;
    const height = vertical(direction) ? flowExtent : crossExtent;
    if (width <= 0 || height <= 0) return undefined;
    return { nodes: [...nodes.values()], hops, width, height, direction };
}

interface Point {
    cross: number;
    flow: number;
}

const TRANSPOSED: Record<Direction, Direction> = { TD: "LR", BT: "RL", LR: "TD", RL: "BT" };

/**
 * Fit the diagram to the width available, giving ground in the order that costs
 * the reader least: first wrap labels harder, and only then turn the diagram on
 * its side. A terminal is bounded across and unbounded down, so a fan-out too
 * wide to draw as TD draws comfortably as LR — and a diagram on its side beats
 * the fenced source, which is what the reader gets otherwise.
 */
export function drawFlowchart(parsed: ParsedFlowchart, maxWidth: number): Canvas | undefined {
    const limits = [...new Set([Math.max(16, Math.min(32, Math.floor(maxWidth / 3))), 24, 20, 16])];
    // Width is tried before orientation at every step: turning the diagram is a
    // smaller loss than breaking its words, so `@notshekhar/loop` split across
    // two lines must never win over the same chart drawn sideways.
    for (const limit of limits) {
        for (const direction of [parsed.direction, TRANSPOSED[parsed.direction]]) {
            const oriented = direction === parsed.direction ? parsed : { ...parsed, direction };
            const layout = layoutFlowchart(oriented, limit);
            if (layout && layout.width <= maxWidth) return paintFlowchart(layout);
        }
    }
    return undefined;
}

function paintFlowchart(layout: FlowchartLayout): Canvas {
    const { direction } = layout;
    const canvas = new Canvas(layout.width, layout.height);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    for (const node of layout.nodes) {
        if (node.virtual) continue;
        const x = vertical(direction) ? node.cross : node.flow;
        const y = vertical(direction) ? node.flow : node.cross;
        const width = vertical(direction) ? node.breadth : node.depth;
        const height = vertical(direction) ? node.depth : node.breadth;
        canvas.box(x, y, width, height, "border");
        if (node.shape === "round") {
            canvas.glyph(x, y, "╭", "border");
            canvas.glyph(x + width - 1, y, "╮", "border");
            canvas.glyph(x, y + height - 1, "╰", "border");
            canvas.glyph(x + width - 1, y + height - 1, "╯", "border");
        }
        const inner = width - 2;
        node.label.forEach((line, index) => {
            const offset = Math.max(0, Math.floor((inner - visibleWidth(line)) / 2));
            canvas.text(x + 1 + offset, y + 1 + index, line, "label");
        });
        if (node.shape === "diamond") {
            const middle = y + Math.floor(height / 2);
            canvas.glyph(x + 1, middle, "‹", "accent");
            canvas.glyph(x + width - 2, middle, "›", "accent");
        }
    }

    for (const node of layout.nodes) {
        if (!node.virtual) continue;
        const cross = centreOf(node);
        if (vertical(direction)) canvas.vline(cross, node.flow, node.depth, "edge");
        else canvas.hline(node.flow, cross, node.depth, "edge");
    }

    // Lines first, heads second. A node that both receives an edge and sends a
    // back edge shares a cell between the two, and whichever was drawn last won.
    for (const hop of layout.hops) drawHop(canvas, layout, byId, hop);
    for (const hop of layout.hops) drawHeads(canvas, layout, byId, hop);
    return canvas;
}

function drawHop(canvas: Canvas, layout: FlowchartLayout, byId: Map<string, LayoutNode>, hop: Hop): void {
    const from = byId.get(hop.from);
    const to = byId.get(hop.to);
    if (!from || !to) return;
    const direction = layout.direction;
    const isVertical = vertical(direction);
    // Which face the hop leaves by is decided by where the other end sits, not
    // by the diagram's direction: an edge that closes a cycle runs back up the
    // page, so it leaves the face its target is on.
    const descending = to.flow > from.flow;
    const start = descending ? from.flow + from.depth : from.flow - 1;
    const end = descending ? to.flow - 1 : to.flow + to.depth;
    const fromCross = centreOf(from);
    const toCross = centreOf(to);
    const lane = hop.laneFlow;

    const draw = (a: Point, b: Point) => {
        if (a.cross === b.cross) {
            const low = Math.min(a.flow, b.flow);
            const length = Math.abs(a.flow - b.flow) + 1;
            if (isVertical) canvas.vline(a.cross, low, length, "edge");
            else canvas.hline(low, a.cross, length, "edge");
        } else {
            const low = Math.min(a.cross, b.cross);
            const length = Math.abs(a.cross - b.cross) + 1;
            if (isVertical) canvas.hline(low, a.flow, length, "edge");
            else canvas.vline(a.flow, low, length, "edge");
        }
    };

    if (lane === undefined) {
        draw({ cross: fromCross, flow: start }, { cross: fromCross, flow: end });
    } else {
        draw({ cross: fromCross, flow: start }, { cross: fromCross, flow: lane });
        draw({ cross: fromCross, flow: lane }, { cross: toCross, flow: lane });
        draw({ cross: toCross, flow: lane }, { cross: toCross, flow: end });
    }

    if (hop.label) {
        // Spaces either side blank the run under the text, so the label reads as
        // sitting on the edge rather than replacing a stretch of it.
        const text = ` ${hop.label} `;
        if (isVertical) {
            const labelFlow = hop.labelFlow ?? (descending ? start + 1 : start - 1);
            const anchor = (lane === undefined ? fromCross : Math.min(fromCross, toCross)) + 1;
            canvas.text(anchor, labelFlow, text, "muted");
        } else {
            // Text runs across the flow, so it rides the last stretch into the
            // target — one label per target row, which is what keeps two edges
            // out of the same cells.
            // Stop one cell short of the target: that last cell is the arrowhead's.
            const span = visibleWidth(text);
            canvas.text(descending ? end - span : end + 1, toCross, text, "muted");
        }
    }
}

function drawHeads(canvas: Canvas, layout: FlowchartLayout, byId: Map<string, LayoutNode>, hop: Hop): void {
    const from = byId.get(hop.from);
    const to = byId.get(hop.to);
    if (!from || !to) return;
    const isVertical = vertical(layout.direction);
    const descending = to.flow > from.flow;
    const start = descending ? from.flow + from.depth : from.flow - 1;
    const end = descending ? to.flow - 1 : to.flow + to.depth;
    const lane = hop.laneFlow;
    const head = (towards: number, away: number) =>
        isVertical ? (towards >= away ? "v" : "^") : towards >= away ? ">" : "<";

    if (hop.last && hop.edge.head) {
        const cross = centreOf(to);
        canvas.glyph(isVertical ? cross : end, isVertical ? end : cross, head(end, lane ?? start), "edge");
    }
    if (hop.first && hop.edge.tail) {
        // `<-->` earns its second head only on the hop that starts the edge.
        const cross = centreOf(from);
        canvas.glyph(isVertical ? cross : start, isVertical ? start : cross, head(start, lane ?? end), "edge");
    }
}
