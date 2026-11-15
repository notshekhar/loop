/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";
import { ESC, extractCompleteSequences, parseUnmodifiedKittyPrintableCodepoint } from "./stdin-sequences";

const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * A single high byte (> 127) is the old meta encoding: convert it to ESC +
 * (byte - 128), for compatibility with parseKeypress.
 */
function toInputString(data: string | Buffer): string {
    if (!Buffer.isBuffer(data)) return data;
    if (data.length === 1 && data[0]! > 127) return `\x1b${String.fromCharCode(data[0]! - 128)}`;
    return data.toString();
}

export type StdinBufferOptions = {
    /**
     * Maximum time to wait for an incomplete sequence such as CSI or mouse
     * (default: 50ms).
     */
    timeout?: number;
    /**
     * Maximum time to wait after a lone ESC before treating it as Escape
     * (default: 10ms). Increase for high-latency Alt+key input (SSH).
     */
    escapeTimeout?: number;
};

export type StdinBufferEventMap = {
    data: [string];
    paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
    private buffer: string = "";
    private timeout: ReturnType<typeof setTimeout> | null = null;
    private readonly timeoutMs: number;
    private readonly escapeTimeoutMs: number;
    private pasteMode: boolean = false;
    private pasteBuffer: string = "";
    private pendingKittyPrintableCodepoint: number | undefined;

    constructor(options: StdinBufferOptions = {}) {
        super();
        this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
        this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
    }

    public process(data: string | Buffer): void {
        this.cancelTimer();
        const str = toInputString(data);
        if (str.length === 0 && this.buffer.length === 0) {
            this.emitDataSequence("");
            return;
        }
        this.buffer += str;
        if (this.pasteMode) {
            this.pasteBuffer += this.buffer;
            this.buffer = "";
            this.finishPasteIfEnded();
            return;
        }
        const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
        if (startIndex !== -1) {
            this.beginPaste(startIndex);
            return;
        }
        const result = extractCompleteSequences(this.buffer);
        this.buffer = result.remainder;
        for (const sequence of result.sequences) {
            this.emitDataSequence(sequence);
        }
        if (this.buffer.length > 0) this.armFlushTimer();
    }

    /**
     * Whole sequences typed before the paste go out first; an incomplete one
     * cut off by the paste start is dropped.
     */
    private beginPaste(startIndex: number): void {
        if (startIndex > 0) {
            for (const sequence of extractCompleteSequences(this.buffer.slice(0, startIndex)).sequences) {
                this.emitDataSequence(sequence);
            }
        }
        this.pendingKittyPrintableCodepoint = undefined;
        this.pasteMode = true;
        this.pasteBuffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
        this.buffer = "";
        this.finishPasteIfEnded();
    }

    /** Once the paste end marker has arrived: emit the paste, then process what followed it. */
    private finishPasteIfEnded(): void {
        const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
        if (endIndex === -1) return;
        const pastedContent = this.pasteBuffer.slice(0, endIndex);
        const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
        this.pasteMode = false;
        this.pasteBuffer = "";
        this.pendingKittyPrintableCodepoint = undefined;
        this.emit("paste", pastedContent);
        if (remaining.length > 0) {
            this.process(remaining);
        }
    }

    /** An incomplete tail is flushed as-is if nothing completes it in time; a lone ESC waits less. */
    private armFlushTimer(): void {
        const timeoutMs = this.buffer === ESC ? this.escapeTimeoutMs : this.timeoutMs;
        this.timeout = setTimeout(() => {
            for (const sequence of this.flush()) {
                this.emitDataSequence(sequence);
            }
        }, timeoutMs);
    }

    private cancelTimer(): void {
        if (!this.timeout) return;
        clearTimeout(this.timeout);
        this.timeout = null;
    }

    private emitDataSequence(sequence: string): void {
        const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
        if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
            this.pendingKittyPrintableCodepoint = undefined;
            return;
        }

        this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
        this.emit("data", sequence);
    }

    flush(): string[] {
        this.cancelTimer();

        if (this.buffer.length === 0) {
            return [];
        }

        const sequences = [this.buffer];
        this.buffer = "";
        this.pendingKittyPrintableCodepoint = undefined;
        return sequences;
    }

    clear(): void {
        this.cancelTimer();
        this.buffer = "";
        this.pasteMode = false;
        this.pasteBuffer = "";
        this.pendingKittyPrintableCodepoint = undefined;
    }

    getBuffer(): string {
        return this.buffer;
    }

    destroy(): void {
        this.clear();
    }
}
