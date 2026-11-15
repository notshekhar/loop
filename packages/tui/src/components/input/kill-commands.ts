import { KillRing } from "../../kill-ring";
import { findWordBackward, findWordForward } from "../../word-navigation";
import type { InputBuffer } from "./buffer";

/**
 * Emacs-style kill and yank for the single-line input: deletions that save
 * what they removed to a kill ring (consecutive kills join into one entry),
 * yank to paste it back, and yank-pop to cycle through older entries.
 */
export class InputKillCommands {
    private killRing = new KillRing();

    constructor(private readonly buffer: InputBuffer) {}

    deleteToLineStart(): void {
        const { buffer } = this;
        if (buffer.cursor === 0) return;
        buffer.pushUndo();
        this.kill(buffer.value.slice(0, buffer.cursor), "backward");
        buffer.deleteRange(0, buffer.cursor);
        buffer.cursor = 0;
    }

    deleteToLineEnd(): void {
        const { buffer } = this;
        if (buffer.cursor >= buffer.value.length) return;
        buffer.pushUndo();
        this.kill(buffer.value.slice(buffer.cursor), "forward");
        buffer.deleteRange(buffer.cursor, buffer.value.length);
    }

    deleteWordBackward(): void {
        const { buffer } = this;
        if (buffer.cursor === 0) return;
        buffer.pushUndo();
        const deleteFrom = findWordBackward(buffer.value, buffer.cursor);
        this.kill(buffer.value.slice(deleteFrom, buffer.cursor), "backward");
        buffer.deleteRange(deleteFrom, buffer.cursor);
        buffer.cursor = deleteFrom;
    }

    deleteWordForward(): void {
        const { buffer } = this;
        if (buffer.cursor >= buffer.value.length) return;
        buffer.pushUndo();
        const deleteTo = findWordForward(buffer.value, buffer.cursor);
        this.kill(buffer.value.slice(buffer.cursor, deleteTo), "forward");
        buffer.deleteRange(buffer.cursor, deleteTo);
    }

    yank(): void {
        const text = this.killRing.peek();
        if (!text) return;
        this.buffer.pushUndo();
        this.buffer.insertAtCursor(text);
        this.buffer.lastAction = "yank";
    }

    yankPop(): void {
        const { buffer } = this;
        if (buffer.lastAction !== "yank" || this.killRing.length <= 1) return;

        buffer.pushUndo();

        // Delete the previously yanked text (still at end of ring before rotation)
        const prevText = this.killRing.peek() || "";
        buffer.deleteRange(buffer.cursor - prevText.length, buffer.cursor);
        buffer.cursor -= prevText.length;

        // Rotate and insert new entry
        this.killRing.rotate();
        buffer.insertAtCursor(this.killRing.peek() || "");
        buffer.lastAction = "yank";
    }

    /** Save deleted text; a kill straight after another kill joins its entry. */
    private kill(text: string, direction: "backward" | "forward"): void {
        this.killRing.push(text, { prepend: direction === "backward", accumulate: this.buffer.lastAction === "kill" });
        this.buffer.lastAction = "kill";
    }
}
