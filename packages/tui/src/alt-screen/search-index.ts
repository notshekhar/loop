import { getGraphemeSegmenter, stripTerminalSequences, visibleWidth } from "../utils";

const segmenter = getGraphemeSegmenter();

interface SearchSourceSpan {
    textStart: number;
    textEnd: number;
    row: number;
    startCol: number;
    endCol: number;
    linearColumns: boolean;
}

interface SearchCorpus {
    text: string;
    spans: SearchSourceSpan[];
}

export interface AltScreenSearchSegment {
    row: number;
    startCol: number;
    endCol: number;
}

export interface AltScreenSearchMatch {
    segments: AltScreenSearchSegment[];
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
    const corpus = new CorpusBuilder();
    for (let row = 0; row < lines.length; row++) {
        const line = stripTerminalSequences(lines[row] ?? "");
        // Rendered transcripts are overwhelmingly ASCII. Index complete non-space
        // runs at once instead of segmenting and allocating one mapping per cell.
        if (PRINTABLE_ASCII.test(line)) corpus.addAsciiLine(row, line);
        else corpus.addGraphemeLine(row, line);
        corpus.endLine();
    }
    return corpus.build();
}

/**
 * The searchable text: every row's words joined by single spaces, each
 * remembering where on screen it came from. Runs of whitespace — including
 * line ends — collapse into one separator, written only when another word
 * follows it.
 */
class CorpusBuilder {
    private readonly chunks: string[] = [];
    private readonly spans: SearchSourceSpan[] = [];
    private textLength = 0;
    private pendingSeparator = false;

    addAsciiLine(row: number, line: string): void {
        let column = 0;
        let index = 0;
        while (index < line.length) {
            if (line.charCodeAt(index) === 0x20) {
                this.whitespace();
                column += 1;
                index += 1;
                continue;
            }
            let end = index + 1;
            while (end < line.length && line.charCodeAt(end) !== 0x20) end += 1;
            const text = line.slice(index, end);
            this.word(text, row, column, text.length, true);
            column += text.length;
            index = end;
        }
    }

    addGraphemeLine(row: number, line: string): void {
        let column = 0;
        for (const grapheme of segmenter.segment(line)) {
            const text = grapheme.segment;
            const width = visibleWidth(text);
            if (/^\s+$/u.test(text)) this.whitespace();
            else this.word(text, row, column, width, false);
            column += width;
        }
    }

    endLine(): void {
        this.whitespace();
    }

    build(): SearchCorpus {
        return { text: this.chunks.join(""), spans: this.spans };
    }

    private whitespace(): void {
        if (this.textLength > 0) this.pendingSeparator = true;
    }

    private word(text: string, row: number, column: number, width: number, linearColumns: boolean): void {
        if (this.pendingSeparator) {
            this.chunks.push(" ");
            this.textLength += 1;
            this.pendingSeparator = false;
        }
        this.chunks.push(text);
        this.spans.push({
            textStart: this.textLength,
            textEnd: this.textLength + text.length,
            row,
            startCol: column,
            endCol: column + width,
            linearColumns,
        });
        this.textLength += text.length;
    }
}

function normalizeQuery(query: string): string {
    return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSearchCorpusMatches(corpus: SearchCorpus, normalizedQuery: string): AltScreenSearchMatch[] {
    if (!normalizedQuery) return [];
    const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
    const matches: AltScreenSearchMatch[] = [];
    let spanIndex = 0;

    for (const match of corpus.text.matchAll(expression)) {
        const start = match.index;
        const end = start + match[0].length;
        while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= start) spanIndex += 1;

        const segments: AltScreenSearchSegment[] = [];
        for (let index = spanIndex; index < corpus.spans.length; index++) {
            const span = corpus.spans[index]!;
            if (span.textStart >= end) break;
            if (span.textEnd <= start) continue;
            const startCol = span.linearColumns
                ? span.startCol + Math.max(start, span.textStart) - span.textStart
                : span.startCol;
            const endCol = span.linearColumns
                ? span.startCol + Math.min(end, span.textEnd) - span.textStart
                : span.endCol;
            const previous = segments[segments.length - 1];
            if (previous && previous.row === span.row && startCol <= previous.endCol) {
                previous.endCol = Math.max(previous.endCol, endCol);
            } else {
                segments.push({ row: span.row, startCol, endCol });
            }
        }
        while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= end) spanIndex += 1;
        if (segments.length > 0) matches.push({ segments });
    }

    return matches;
}

export interface AltScreenSearchResult {
    matches: AltScreenSearchMatch[];
    changed: boolean;
}

/** Cache the searchable corpus and matches while rendered transcript lines remain unchanged. */
export class AltScreenSearchIndex {
    private sourceLines: string[] | undefined;
    private corpus: SearchCorpus | undefined;
    private normalizedQuery: string | undefined;
    private matches: AltScreenSearchMatch[] = [];

    search(lines: readonly string[], query: string): AltScreenSearchResult {
        let sourceChanged = this.sourceLines?.length !== lines.length;
        if (!sourceChanged && this.sourceLines) {
            for (let index = 0; index < lines.length; index++) {
                if (this.sourceLines[index] === lines[index]) continue;
                sourceChanged = true;
                break;
            }
        }
        if (sourceChanged || !this.corpus) {
            this.sourceLines = Array.from(lines);
            this.corpus = buildSearchCorpus(lines);
        }

        const normalizedQuery = normalizeQuery(query);
        const changed = sourceChanged || normalizedQuery !== this.normalizedQuery;
        if (changed) {
            this.normalizedQuery = normalizedQuery;
            this.matches = findSearchCorpusMatches(this.corpus, normalizedQuery);
        }
        return { matches: this.matches, changed };
    }
}

export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
    const normalizedQuery = normalizeQuery(query);
    return normalizedQuery ? findSearchCorpusMatches(buildSearchCorpus(lines), normalizedQuery) : [];
}

export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
    const first = match.segments[0];
    const last = match.segments[match.segments.length - 1];
    return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}
