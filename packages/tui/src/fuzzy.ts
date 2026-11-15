/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
    matches: boolean;
    score: number;
}

/** Score bonus for a run of consecutive matches, per match in the run. */
const CONSECUTIVE_BONUS = 5;
/** Score cost of each skipped character between two matches. */
const GAP_PENALTY = 2;
/** Score bonus for a match at the start of a word. */
const WORD_BOUNDARY_BONUS = 10;
/** Score cost per character of distance into the text. */
const POSITION_PENALTY = 0.1;
/** Score bonus when the query is the whole text. */
const EXACT_MATCH_BONUS = 100;
/** Score cost of matching only after swapping a query's letters and digits. */
const SWAPPED_QUERY_PENALTY = 5;

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
    const queryLower = query.toLowerCase();
    const textLower = text.toLowerCase();
    const primaryMatch = matchInOrder(queryLower, textLower);
    if (primaryMatch.matches) {
        return primaryMatch;
    }
    // "v2" also finds "2v", and the other way round.
    const swappedQuery = swapLettersAndDigits(queryLower);
    if (!swappedQuery) {
        return primaryMatch;
    }
    const swappedMatch = matchInOrder(swappedQuery, textLower);
    if (!swappedMatch.matches) {
        return primaryMatch;
    }
    return { matches: true, score: swappedMatch.score + SWAPPED_QUERY_PENALTY };
}

function matchInOrder(query: string, textLower: string): FuzzyMatch {
    if (query.length === 0) {
        return { matches: true, score: 0 };
    }
    if (query.length > textLower.length) {
        return { matches: false, score: 0 };
    }
    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;
    for (let i = 0; i < textLower.length && queryIndex < query.length; i++) {
        if (textLower[i] !== query[queryIndex]) continue;
        if (lastMatchIndex === i - 1) {
            consecutiveMatches++;
            score -= consecutiveMatches * CONSECUTIVE_BONUS;
        } else {
            consecutiveMatches = 0;
            if (lastMatchIndex >= 0) {
                score += (i - lastMatchIndex - 1) * GAP_PENALTY;
            }
        }
        if (i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!)) {
            score -= WORD_BOUNDARY_BONUS;
        }
        score += i * POSITION_PENALTY;
        lastMatchIndex = i;
        queryIndex++;
    }
    if (queryIndex < query.length) {
        return { matches: false, score: 0 };
    }
    if (query === textLower) {
        score -= EXACT_MATCH_BONUS;
    }
    return { matches: true, score };
}

/** "abc12" → "12abc" and "12abc" → "abc12"; "" for anything else. */
function swapLettersAndDigits(query: string): string {
    const alphaNumeric = query.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
    if (alphaNumeric) return `${alphaNumeric.groups?.digits ?? ""}${alphaNumeric.groups?.letters ?? ""}`;
    const numericAlpha = query.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
    if (numericAlpha) return `${numericAlpha.groups?.letters ?? ""}${numericAlpha.groups?.digits ?? ""}`;
    return "";
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports whitespace- and slash-separated tokens: all tokens must match.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
    if (!query.trim()) {
        return items;
    }

    const tokens = query
        .trim()
        .split(/[\s/]+/)
        .filter((t) => t.length > 0);

    if (tokens.length === 0) {
        return items;
    }

    const results: { item: T; totalScore: number }[] = [];

    for (const item of items) {
        const text = getText(item);
        let totalScore = 0;
        let allMatch = true;

        for (const token of tokens) {
            const match = fuzzyMatch(token, text);
            if (match.matches) {
                totalScore += match.score;
            } else {
                allMatch = false;
                break;
            }
        }

        if (allMatch) {
            results.push({ item, totalScore });
        }
    }

    results.sort((a, b) => a.totalScore - b.totalScore);
    return results.map((r) => r.item);
}
