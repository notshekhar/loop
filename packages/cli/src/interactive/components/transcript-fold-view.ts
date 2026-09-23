/**
 * The transcript's runs of tool calls, as the chat history sees them: which
 * entries this render draws, which it hides, and which stand a header in for
 * the rest.
 *
 * The RULES live in `transcript-folds.ts` (pure). This is the glue between
 * those rules and a live transcript: it answers in terms of entries rather
 * than indices, because entries are what the rest of the transcript holds.
 * It depends on an abstraction, not on components — each entry says how it
 * takes part in a run right now ({@link FoldParticipant}) — so a new kind of
 * row joins the fold pass by answering that one question.
 */
import { verbGroupLabel, type GroupMember } from "../ui/verb-group";
import { computeFolds, type FoldRole, type FoldSpan, type RunStep } from "../transcript-folds";

/** How one transcript entry takes part in a run, asked fresh every render. */
export interface FoldParticipant {
    /** Its role right now — a call's changes as it runs, finishes, or opens. */
    foldStep(): RunStep;
    /** What it contributes to a header's label. Tool calls only. */
    member?(): GroupMember;
}

/** One position in the transcript's order: an entry, or a visible row that
 * is not one (a system line, an error) and so ends any run it interrupts. */
export type FoldSlot = FoldParticipant | null;

/** A run's header row, ready to draw. */
export interface FoldHeader {
    readonly label: string;
    readonly failed: number;
    readonly running: boolean;
    readonly open: boolean;
}

const BREAK: RunStep = { kind: "break" };

export class FoldView {
    private constructor(
        private readonly slots: readonly FoldSlot[],
        private readonly spans: readonly FoldSpan[],
        private readonly roles: ReadonlyMap<FoldParticipant, FoldRole>,
        private readonly indexOf: ReadonlyMap<FoldParticipant, number>,
    ) {}

    /** Run the fold pass over the transcript's current order. */
    static compute(slots: readonly FoldSlot[], openFolds: OpenFolds): FoldView {
        const participantsIn = (start: number, end: number): FoldParticipant[] =>
            slots.slice(start, end).filter((s): s is FoldParticipant => s !== null);
        const layout = computeFolds(
            slots.map((s) => s?.foldStep() ?? BREAK),
            (start, end) => openFolds.isOpen(participantsIn(start, end)),
        );
        const roles = new Map<FoldParticipant, FoldRole>();
        const indexOf = new Map<FoldParticipant, number>();
        slots.forEach((slot, i) => {
            if (!slot) return;
            roles.set(slot, layout.roles[i]);
            indexOf.set(slot, i);
        });
        return new FoldView(slots, layout.spans, roles, indexOf);
    }

    roleOf(entry: FoldParticipant): FoldRole {
        return this.roles.get(entry) ?? { kind: "self" };
    }

    isHidden(entry: FoldParticipant): boolean {
        return this.roleOf(entry).kind === "hidden";
    }

    /** The run whose header this entry draws, if any. */
    headedBy(entry: FoldParticipant): FoldSpan | null {
        const role = this.roleOf(entry);
        return role.kind === "header" ? role.span : null;
    }

    /** The run this entry sits inside (header or not), if any. */
    spanContaining(entry: FoldParticipant): FoldSpan | null {
        const i = this.indexOf.get(entry);
        if (i === undefined) return null;
        return this.spans.find((s) => i >= s.start && i < s.end) ?? null;
    }

    /** The entry that draws a run's header — where selection lands for it. */
    headerEntry(span: FoldSpan): FoldParticipant {
        return this.slots[span.start]!;
    }

    /** Every entry a run covers — what opening or closing it marks. */
    entriesOf(span: FoldSpan): FoldParticipant[] {
        return this.slots.slice(span.start, span.end).filter((s): s is FoldParticipant => s !== null);
    }

    /**
     * The header's label counts the run's MEMBERS ("Read 3 files, Ran 1
     * command"); an opened call keeps its own rows and is not what the header
     * describes.
     */
    header(span: FoldSpan): FoldHeader {
        const members = this.entriesOf(span)
            .filter((e) => e.foldStep().kind === "member")
            .flatMap((e) => (e.member ? [e.member()] : []));
        const { text, failed } = verbGroupLabel(members);
        return { label: text, failed, running: span.running, open: span.open };
    }
}

/**
 * The fold state that persists: which runs the user opened.
 *
 * Openness is remembered against EVERY entry a run covers, not just its first,
 * because a run's first entry is not stable — opening that call makes it
 * transparent and moves the header to the next one. Keyed on the head alone,
 * an open group would snap shut under you. grok migrates the key instead
 * (`selection.rs:rekey_verb_group_expansion`); holding every entry is the same
 * fix without a migration step to keep in sync.
 */
export class OpenFolds {
    private readonly open = new Set<FoldParticipant>();

    isOpen(entries: readonly FoldParticipant[]): boolean {
        return entries.some((e) => this.open.has(e));
    }

    set(entries: readonly FoldParticipant[], open: boolean): void {
        for (const e of entries) {
            if (open) this.open.add(e);
            else this.open.delete(e);
        }
    }

    clear(): void {
        this.open.clear();
    }
}
