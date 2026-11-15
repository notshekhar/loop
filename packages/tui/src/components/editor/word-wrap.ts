import { cjkBreakRegex, getGraphemeSegmenter, isWhitespaceChar, visibleWidth } from "../../utils";
import { isPasteMarker } from "./paste-markers";

const graphemeSegmenter = getGraphemeSegmenter();

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
    text: string;
    startIndex: number;
    endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
    if (!line || maxWidth <= 0) {
        return [{ text: "", startIndex: 0, endIndex: 0 }];
    }
    if (visibleWidth(line) <= maxWidth) {
        return [{ text: line, startIndex: 0, endIndex: line.length }];
    }
    const segments = preSegmented ?? [...graphemeSegmenter.segment(line)];
    const builder = new ChunkBuilder(line, maxWidth);
    for (let i = 0; i < segments.length; i++) {
        builder.add(segments[i]!, segments[i + 1]);
    }
    return builder.finish();
}

/** Walks a line grapheme by grapheme, cutting a chunk whenever the next one would overflow. */
class ChunkBuilder {
    private chunks: TextChunk[] = [];
    private currentWidth = 0;
    private chunkStart = 0;
    // Wrap opportunity: the position after the last whitespace before a non-whitespace
    // grapheme, i.e. where a line break is allowed.
    private wrapOppIndex = -1;
    private wrapOppWidth = 0;

    constructor(
        private readonly line: string,
        private readonly maxWidth: number,
    ) {}

    add(seg: Intl.SegmentData, next: Intl.SegmentData | undefined): void {
        const grapheme = seg.segment;
        const width = visibleWidth(grapheme);
        if (this.currentWidth + width > this.maxWidth) {
            this.breakBefore(seg.index, width);
        }
        if (width > this.maxWidth) {
            this.splitOversized(grapheme, seg.index);
            return;
        }
        this.currentWidth += width;
        this.recordWrapOpportunity(grapheme, next);
    }

    finish(): TextChunk[] {
        this.chunks.push({
            text: this.line.slice(this.chunkStart),
            startIndex: this.chunkStart,
            endIndex: this.line.length,
        });
        return this.chunks;
    }

    private push(start: number, end: number): void {
        this.chunks.push({ text: this.line.slice(start, end), startIndex: start, endIndex: end });
    }

    /** The grapheme at `charIndex` doesn't fit: end the chunk at the last wrap point, or right here. */
    private breakBefore(charIndex: number, width: number): void {
        if (this.wrapOppIndex >= 0 && this.currentWidth - this.wrapOppWidth + width <= this.maxWidth) {
            // Backtrack to the last wrap opportunity: what follows it plus
            // this grapheme still fits.
            this.push(this.chunkStart, this.wrapOppIndex);
            this.chunkStart = this.wrapOppIndex;
            this.currentWidth -= this.wrapOppWidth;
        } else if (this.chunkStart < charIndex) {
            // No viable wrap opportunity — or backtracking wouldn't help
            // because the rest plus this (e.g. wide) grapheme still overflows.
            this.push(this.chunkStart, charIndex);
            this.chunkStart = charIndex;
            this.currentWidth = 0;
        }
        this.wrapOppIndex = -1;
    }

    /**
     * A single atomic segment wider than the line (e.g. a paste marker in a
     * narrow terminal) is re-wrapped at grapheme granularity. It stays one
     * unit for cursor movement and editing — the split is purely visual.
     */
    private splitOversized(grapheme: string, charIndex: number): void {
        const subChunks = wordWrapLine(grapheme, this.maxWidth);
        for (const sc of subChunks.slice(0, -1)) {
            this.push(charIndex + sc.startIndex, charIndex + sc.endIndex);
        }
        const last = subChunks[subChunks.length - 1]!;
        this.chunkStart = charIndex + last.startIndex;
        this.currentWidth = visibleWidth(last.text);
        this.wrapOppIndex = -1;
    }

    /**
     * A break is allowed after whitespace that is followed by non-whitespace
     * (multiple spaces join; the break point is after the last space), or at
     * a boundary where either side is CJK (CJK can break between any two
     * characters).
     */
    private recordWrapOpportunity(grapheme: string, next: Intl.SegmentData | undefined): void {
        if (!next) return;
        const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);
        const nextIsMarker = isPasteMarker(next.segment);
        const nextIsWs = isWhitespaceChar(next.segment);
        let canBreak = false;
        if (isWs) {
            canBreak = nextIsMarker || !nextIsWs;
        } else if (!nextIsWs) {
            const isCjk = !isPasteMarker(grapheme) && cjkBreakRegex.test(grapheme);
            canBreak = isCjk || (!nextIsMarker && cjkBreakRegex.test(next.segment));
        }
        if (canBreak) {
            this.wrapOppIndex = next.index;
            this.wrapOppWidth = this.currentWidth;
        }
    }
}
