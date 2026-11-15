import { Container, Spacer } from "@notshekhar/loop-tui";
import { AssistantMessageComponent, type FoldableHandle } from "../../ui/messages";
import type { ToolExecutionComponent } from "../../ui/tool-execution";
import type { RunStep } from "../../transcript-folds";
import type { FoldParticipant, FoldSlot } from "../transcript-fold-view";

/** A selectable transcript entry: a prompt, a response, a thought, a call. */
export interface Foldable extends FoldParticipant {
    kind: "user" | "response" | "thinking" | "tool" | "compaction";
    handle: FoldableHandle;
    getText: () => string;
    /** Component that renders this entry (user/tool: the component itself;
     * thinking/response: the assistant message + content index) — lets range
     * tracking map rendered lines back to entries. */
    comp: unknown;
    contentIndex?: number;
}

/** Prompts, responses and thoughts are what a transcript is scrolled back
 * FOR, so they end any run of tool calls and are never counted into one. */
export const NEVER_FOLDS = (): RunStep => ({ kind: "break" });

/** An entry that is a whole component of its own and never joins a run (a
 * prompt, a compaction summary). */
export function standaloneFoldable(
    kind: "user" | "compaction",
    comp: FoldableHandle & { getText(): string },
): Foldable {
    return { kind, handle: comp, getText: () => comp.getText(), comp, foldStep: NEVER_FOLDS };
}

/** A tool call: its fold role changes as it runs, finishes or opens. */
export function toolFoldable(comp: ToolExecutionComponent): Foldable {
    return {
        kind: "tool",
        handle: comp,
        getText: () => comp.copyText(),
        comp,
        foldStep: () => comp.foldStep(),
        member: () => comp.groupMember(),
    };
}

/** Where each foldable lives in the component tree. */
export interface FoldableIndex {
    /** A component that IS an entry (a prompt, a call). */
    single: Map<unknown, number>;
    /** An assistant message holding several block entries, in content order. */
    blocks: Map<unknown, number[]>;
}

export function foldableIndex(foldables: readonly Foldable[]): FoldableIndex {
    const single = new Map<unknown, number>();
    const blocks = new Map<unknown, number[]>();
    foldables.forEach((f, i) => {
        if (f.contentIndex === undefined) {
            single.set(f.comp, i);
            return;
        }
        const list = blocks.get(f.comp) ?? [];
        list.push(i);
        blocks.set(f.comp, list);
    });
    for (const list of blocks.values()) {
        list.sort((a, b) => foldables[a].contentIndex! - foldables[b].contentIndex!);
    }
    return { single, blocks };
}

/**
 * The transcript in render order, as the fold pass sees it: each entry,
 * and a break for every visible row that is not one (a system line, an
 * error) — those end any run they interrupt, as they do in grok.
 */
export function foldSlots(root: Container, foldables: readonly Foldable[]): FoldSlot[] {
    const { single, blocks } = foldableIndex(foldables);
    const slots: FoldSlot[] = [];
    const visit = (children: ReadonlyArray<unknown>): void => {
        for (const child of children) {
            if (child instanceof AssistantMessageComponent) {
                for (const i of blocks.get(child) ?? []) slots.push(foldables[i]);
            } else if (single.has(child)) {
                slots.push(foldables[single.get(child)!]);
            } else if (child instanceof Spacer) {
                continue;
            } else if (child instanceof Container) {
                visit(child.children);
            } else {
                slots.push(null);
            }
        }
    };
    visit(root.children);
    return slots;
}
