import type { EditorState } from "./types";

/** Older prompts beyond this are dropped. */
const MAX_HISTORY = 100;

export type HistoryStep =
    { kind: "entry"; text: string; entered: boolean } | { kind: "draft"; draft: EditorState | null };

/**
 * Prompt history for up/down navigation, newest first. While browsing, the
 * draft being typed is kept aside and comes back when you step past the
 * newest entry.
 */
export class PromptHistory {
    private entries: string[] = [];
    /** -1 = not browsing, 0 = most recent, 1 = older, etc. */
    private index = -1;
    private draft: EditorState | null = null;

    get isBrowsing(): boolean {
        return this.index > -1;
    }

    add(text: string): void {
        const trimmed = text.trim();
        if (!trimmed) return;
        if (this.entries[0] === trimmed) return;
        this.entries.unshift(trimmed);
        if (this.entries.length > MAX_HISTORY) {
            this.entries.pop();
        }
    }

    exit(): void {
        this.index = -1;
        this.draft = null;
    }

    /**
     * Step older (-1) or newer (1). Undefined when there is nowhere to go.
     * `entered` is true on the step that starts browsing, when `current` is
     * kept as the draft.
     */
    step(direction: 1 | -1, current: EditorState): HistoryStep | undefined {
        if (this.entries.length === 0) return undefined;
        const newIndex = this.index - direction;
        if (newIndex < -1 || newIndex >= this.entries.length) return undefined;

        const entered = this.index === -1 && newIndex >= 0;
        if (entered) this.draft = structuredClone(current);
        this.index = newIndex;

        if (this.index >= 0) return { kind: "entry", text: this.entries[this.index] || "", entered };
        const draft = this.draft;
        this.draft = null;
        return { kind: "draft", draft };
    }
}
