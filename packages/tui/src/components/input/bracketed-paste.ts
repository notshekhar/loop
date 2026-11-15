const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** What a chunk of input turned out to be once bracketed paste is accounted for. */
export type PasteResult =
    { kind: "keys"; data: string } | { kind: "buffering" } | { kind: "paste"; text: string; remaining: string };

/**
 * Buffers bracketed-paste input (`ESC[200~ … ESC[201~`) across chunks, so a
 * paste split over several reads still lands as one paste.
 */
export class BracketedPaste {
    private buffer: string = "";
    private active: boolean = false;

    take(data: string): PasteResult {
        if (data.includes(BRACKETED_PASTE_START)) {
            this.active = true;
            this.buffer = "";
            data = data.replace(BRACKETED_PASTE_START, "");
        }
        if (!this.active) return { kind: "keys", data };

        this.buffer += data;
        const endIndex = this.buffer.indexOf(BRACKETED_PASTE_END);
        if (endIndex === -1) return { kind: "buffering" };

        const text = this.buffer.substring(0, endIndex);
        const remaining = this.buffer.substring(endIndex + BRACKETED_PASTE_END.length);
        this.active = false;
        this.buffer = "";
        return { kind: "paste", text, remaining };
    }
}
