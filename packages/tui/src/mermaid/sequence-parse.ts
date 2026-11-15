/** Parsing a mermaid `sequenceDiagram`: participants, messages, notes and frames. */

export type ArrowHead = "arrow" | "open" | "cross" | "async";

export interface SequenceMessage {
    kind: "message";
    from: string;
    to: string;
    text: string;
    dashed: boolean;
    head: ArrowHead;
}

export interface SequenceNote {
    kind: "note";
    /** Lifelines the note covers; one entry for `left of` / `right of`. */
    over: string[];
    side: "over" | "left" | "right";
    text: string;
}

export interface SequenceFrame {
    kind: "frame";
    /** `else` continues the frame it sits in rather than opening a new one. */
    tag: "loop" | "alt" | "opt" | "par" | "critical" | "break" | "else" | "end";
    text: string;
}

export type SequenceEvent = SequenceMessage | SequenceNote | SequenceFrame;

export interface ParsedSequence {
    participants: Array<{ id: string; label: string }>;
    events: SequenceEvent[];
}

const HEADS: Array<[token: string, dashed: boolean, head: ArrowHead]> = [
    ["-->>", true, "arrow"],
    ["--\\)", true, "async"],
    ["--x", true, "cross"],
    ["-->", true, "open"],
    ["->>", false, "arrow"],
    ["-\\)", false, "async"],
    ["-x", false, "cross"],
    ["->", false, "open"],
];

const MESSAGE_PATTERN = new RegExp(
    `^([A-Za-z0-9_]+)\\s*(${HEADS.map(([token]) => token).join("|")})\\s*([A-Za-z0-9_]+)\\s*:\\s*(.*)$`,
);

const FRAME_TAGS = ["loop", "alt", "opt", "par", "critical", "break", "else"] as const;

/** Participants in first-mention order; a later `as` label renames one. */
class Participants {
    readonly list: Array<{ id: string; label: string }> = [];
    private readonly seen = new Set<string>();

    declare(id: string, label?: string): void {
        if (this.seen.has(id)) {
            if (label) {
                const existing = this.list.find((entry) => entry.id === id);
                if (existing) existing.label = label;
            }
            return;
        }
        this.seen.add(id);
        this.list.push({ id, label: label ?? id });
    }
}

export function parseSequence(source: string): ParsedSequence | undefined {
    const participants = new Participants();
    const events: SequenceEvent[] = [];
    let seenHeader = false;
    for (const raw of source.split("\n")) {
        const line = raw.replace(/%%.*$/, "").trim();
        if (!line) continue;
        if (!seenHeader) {
            if (!/^sequenceDiagram\b/.test(line)) return undefined;
            seenHeader = true;
            continue;
        }
        const event = parseLine(line, participants);
        if (event) events.push(event);
    }
    if (participants.list.length === 0) return undefined;
    return { participants: participants.list, events };
}

/**
 * One statement. autonumber, activate/deactivate, rect and links are known
 * but return nothing: a cell grid gains nothing from drawing them.
 */
function parseLine(line: string, participants: Participants): SequenceEvent | undefined {
    const participant = /^(?:participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/.exec(line);
    if (participant) {
        participants.declare(participant[1]!, participant[2]?.trim());
        return undefined;
    }
    const note = parseNote(line, participants);
    if (note) return note;
    if (line === "end") return { kind: "frame", tag: "end", text: "" };
    const frame = FRAME_PATTERN.exec(line);
    if (frame) return { kind: "frame", tag: frame[1]! as SequenceFrame["tag"], text: frame[2]!.trim() };
    return parseMessage(line, participants);
}

const FRAME_PATTERN = new RegExp(`^(${FRAME_TAGS.join("|")})\\b\\s*(.*)$`);

function parseNote(line: string, participants: Participants): SequenceNote | undefined {
    const note = /^Note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(line);
    if (!note) return undefined;
    const targets = note[2]!
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    targets.forEach((id) => participants.declare(id));
    const placement = note[1]!.toLowerCase();
    const side = placement.startsWith("left") ? "left" : placement.startsWith("right") ? "right" : "over";
    return { kind: "note", over: targets, side, text: note[3]!.trim() };
}

function parseMessage(line: string, participants: Participants): SequenceMessage | undefined {
    const message = MESSAGE_PATTERN.exec(line);
    if (!message) return undefined;
    const spec = HEADS.find(([candidate]) => candidate.replace(/\\/g, "") === message[2]);
    participants.declare(message[1]!);
    participants.declare(message[3]!);
    return {
        kind: "message",
        from: message[1]!,
        to: message[3]!,
        text: message[4]!.trim(),
        dashed: spec?.[1] ?? false,
        head: spec?.[2] ?? "arrow",
    };
}
