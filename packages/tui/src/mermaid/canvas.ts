import { getGraphemeSegmenter, visibleWidth } from "../utils";

/**
 * What a cell is, so the caller can colour structure and prose differently
 * without the diagram code knowing anything about themes.
 */
export type Role = "border" | "label" | "edge" | "accent" | "muted";

export interface MermaidStyle {
    border: (text: string) => string;
    label: (text: string) => string;
    edge: (text: string) => string;
    accent: (text: string) => string;
    muted: (text: string) => string;
}

/** Line directions, as a bitmask, so crossings can be merged instead of overwritten. */
export const UP = 1;
export const RIGHT = 2;
export const DOWN = 4;
export const LEFT = 8;

/**
 * Every mask to the box-drawing character that carries exactly those arms.
 * A single arm becomes a full line rather than a half line (╵╶╷╴): the half
 * lines are drawn from a narrower part of the Box Drawing block and fall back
 * to tofu in more fonts than the diagrams are worth.
 */
const MASK_CHARS = [" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"] as const;

/** A cell a wide grapheme has spilled into; emit() skips it. */
const CONSUMED = "";

export class Canvas {
    readonly width: number;
    readonly height: number;
    private readonly chars: string[];
    private readonly roles: (Role | undefined)[];
    /**
     * Arms drawn into each cell, kept beside the character rather than
     * recovered from it: several masks share a glyph (│ is UP, DOWN and both),
     * so reading the mask back off the character turns a stub into a full line
     * and every junction gains arms that were never drawn.
     */
    private readonly masks: number[];

    constructor(width: number, height: number) {
        this.width = Math.max(0, width);
        this.height = Math.max(0, height);
        const size = this.width * this.height;
        this.chars = new Array<string>(size).fill(" ");
        this.roles = new Array<Role | undefined>(size).fill(undefined);
        this.masks = new Array<number>(size).fill(0);
    }

    private index(x: number, y: number): number | undefined {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
        return y * this.width + x;
    }

    set(x: number, y: number, char: string, role: Role): void {
        const at = this.index(x, y);
        if (at === undefined) return;
        const width = visibleWidth(char);
        if (width > 1) {
            // Claim the trailing cell first: if it falls off the canvas the
            // grapheme would be clipped in half, so drop it entirely.
            const tail = this.index(x + width - 1, y);
            if (tail === undefined) return;
            for (let offset = 1; offset < width; offset++) {
                const spill = this.index(x + offset, y)!;
                this.chars[spill] = CONSUMED;
                this.roles[spill] = role;
            }
        }
        this.chars[at] = char;
        this.roles[at] = role;
        this.masks[at] = 0;
    }

    text(x: number, y: number, value: string, role: Role): void {
        let cursor = x;
        for (const { segment } of getGraphemeSegmenter().segment(value)) {
            this.set(cursor, y, segment, role);
            cursor += Math.max(1, visibleWidth(segment));
        }
    }

    /**
     * Draw line arms into a cell, merging with whatever is already there so a
     * crossing becomes ┼ and a tee becomes ├ instead of clobbering the cell.
     */
    line(x: number, y: number, mask: number, role: Role): void {
        const at = this.index(x, y);
        if (at === undefined) return;
        const merged = this.masks[at]! | mask;
        this.masks[at] = merged;
        this.chars[at] = MASK_CHARS[merged] ?? MASK_CHARS[mask]!;
        // A label already in the cell keeps its role: colouring prose as
        // structure reads worse than a line borrowing the label's colour.
        if (this.roles[at] !== "label") this.roles[at] = role;
    }

    hline(x: number, y: number, length: number, role: Role): void {
        for (let offset = 0; offset < length; offset++) {
            let mask = 0;
            if (offset > 0) mask |= LEFT;
            if (offset < length - 1) mask |= RIGHT;
            this.line(x + offset, y, mask === 0 ? LEFT | RIGHT : mask, role);
        }
    }

    vline(x: number, y: number, length: number, role: Role): void {
        for (let offset = 0; offset < length; offset++) {
            let mask = 0;
            if (offset > 0) mask |= UP;
            if (offset < length - 1) mask |= DOWN;
            this.line(x, y + offset, mask === 0 ? UP | DOWN : mask, role);
        }
    }

    box(x: number, y: number, width: number, height: number, role: Role): void {
        if (width < 2 || height < 2) return;
        const right = x + width - 1;
        const bottom = y + height - 1;
        this.line(x, y, RIGHT | DOWN, role);
        this.line(right, y, LEFT | DOWN, role);
        this.line(x, bottom, RIGHT | UP, role);
        this.line(right, bottom, LEFT | UP, role);
        for (let offset = 1; offset < width - 1; offset++) {
            this.line(x + offset, y, LEFT | RIGHT, role);
            this.line(x + offset, bottom, LEFT | RIGHT, role);
        }
        for (let offset = 1; offset < height - 1; offset++) {
            this.line(x, y + offset, UP | DOWN, role);
            this.line(right, y + offset, UP | DOWN, role);
        }
    }

    /**
     * Wipe a rectangle back to blank. A box drawn across a line would otherwise
     * merge with it and grow a tee where the border should simply cover it.
     */
    clear(x: number, y: number, width: number, height: number): void {
        for (let row = y; row < y + height; row++) {
            for (let column = x; column < x + width; column++) {
                const at = this.index(column, row);
                if (at === undefined) continue;
                this.chars[at] = " ";
                this.roles[at] = undefined;
                this.masks[at] = 0;
            }
        }
    }

    /** Overwrite a cell outright, ignoring line merging — for arrowheads and glyphs. */
    glyph(x: number, y: number, char: string, role: Role): void {
        this.set(x, y, char, role);
    }

    emit(style: MermaidStyle): string[] {
        const lines: string[] = [];
        for (let y = 0; y < this.height; y++) {
            let line = "";
            let run = "";
            let runRole: Role | undefined;
            const flush = () => {
                if (run.length === 0) return;
                line += runRole ? style[runRole](run) : run;
                run = "";
            };
            let lastPainted = -1;
            for (let x = 0; x < this.width; x++) {
                if (this.chars[y * this.width + x] !== " ") lastPainted = x;
            }
            for (let x = 0; x <= lastPainted; x++) {
                const at = y * this.width + x;
                const char = this.chars[at]!;
                if (char === CONSUMED) continue;
                const role = this.roles[at];
                if (role !== runRole) {
                    flush();
                    runRole = role;
                }
                run += char;
            }
            flush();
            lines.push(line);
        }
        return lines;
    }
}
