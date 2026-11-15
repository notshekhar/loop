import { statSync } from "fs";
import { basename, join } from "path";
import { FD_MAX_RESULTS, type FdEntry, walkDirectoryWithFd } from "./fd-walk";
import { buildCompletionValue, expandHomePath, toDisplayPath } from "./path-token";
import type { AutocompleteItem } from "./types";

/**
 * `@` completion: a fuzzy search of the project (or of the directory the query
 * names) with fd, ranked so the closest names come first.
 */

/** How many fuzzy hits the `@` list shows. */
export const MAX_FUZZY_SUGGESTIONS = 20;

interface ScopedQuery {
    baseDir: string;
    query: string;
    displayBase: string;
}

interface ScoredEntry extends FdEntry {
    score: number;
}

export interface FuzzyFileSearch {
    basePath: string;
    fdPath: string | null;
    isQuotedPrefix: boolean;
    signal: AbortSignal;
}

/** A query like `src/comp` searches inside `src/` for `comp`, when that directory exists. */
function resolveScopedFuzzyQuery(rawQuery: string, basePath: string): ScopedQuery | null {
    const normalizedQuery = toDisplayPath(rawQuery);
    const slashIndex = normalizedQuery.lastIndexOf("/");
    if (slashIndex === -1) {
        return null;
    }

    const displayBase = normalizedQuery.slice(0, slashIndex + 1);
    const query = normalizedQuery.slice(slashIndex + 1);

    let baseDir: string;
    if (displayBase.startsWith("~/")) {
        baseDir = expandHomePath(displayBase);
    } else if (displayBase.startsWith("/")) {
        baseDir = displayBase;
    } else {
        baseDir = join(basePath, displayBase);
    }

    try {
        if (!statSync(baseDir).isDirectory()) {
            return null;
        }
    } catch {
        return null;
    }

    return { baseDir, query, displayBase };
}

function scopedPathForDisplay(displayBase: string, relativePath: string): string {
    const normalizedRelativePath = toDisplayPath(relativePath);
    if (displayBase === "/") {
        return `/${normalizedRelativePath}`;
    }
    return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
}

// Score an entry against the query (higher = better match)
// isDirectory adds bonus to prioritize folders
function scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
    const fileName = basename(filePath);
    const lowerFileName = fileName.toLowerCase();
    const lowerQuery = query.toLowerCase();

    let score = 0;

    // Exact filename match (highest)
    if (lowerFileName === lowerQuery) score = 100;
    // Filename starts with query
    else if (lowerFileName.startsWith(lowerQuery)) score = 80;
    // Substring match in filename
    else if (lowerFileName.includes(lowerQuery)) score = 50;
    // Substring match in full path
    else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

    // Directories get a bonus to appear first
    if (isDirectory && score > 0) score += 10;

    return score;
}

/** The base directory's own entries first, then the recursive walk's, without repeats. */
async function collectEntries(baseDir: string, fdPath: string, query: string, signal: AbortSignal): Promise<FdEntry[]> {
    const baseDirEntries = await walkDirectoryWithFd(baseDir, fdPath, query, FD_MAX_RESULTS, signal, 1);
    const recursiveEntries = await walkDirectoryWithFd(baseDir, fdPath, query, FD_MAX_RESULTS, signal);
    const seenPaths = new Set(baseDirEntries.map((entry) => entry.path));
    return [
        ...baseDirEntries,
        ...recursiveEntries.filter((entry) => {
            if (seenPaths.has(entry.path)) return false;
            seenPaths.add(entry.path);
            return true;
        }),
    ];
}

function pathDepth(path: string): number {
    return toDisplayPath(path).split("/").filter(Boolean).length;
}

/** Best score first; ties go to the shallower, then shorter, then alphabetically first path. */
function compareScoredEntries(a: ScoredEntry, b: ScoredEntry): number {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;

    const depthDiff = pathDepth(a.path) - pathDepth(b.path);
    if (depthDiff !== 0) return depthDiff;

    const lengthDiff = a.path.length - b.path.length;
    if (lengthDiff !== 0) return lengthDiff;

    return a.path.localeCompare(b.path);
}

function rankEntries(entries: FdEntry[], query: string): ScoredEntry[] {
    return entries
        .map((entry) => ({
            ...entry,
            score: query ? scoreEntry(entry.path, query, entry.isDirectory) : 1,
        }))
        .filter((entry) => entry.score > 0)
        .sort(compareScoredEntries)
        .slice(0, MAX_FUZZY_SUGGESTIONS);
}

function toSuggestion(entry: FdEntry, scopedQuery: ScopedQuery | null, isQuotedPrefix: boolean): AutocompleteItem {
    const { path: entryPath, isDirectory } = entry;
    const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
    const displayPath = scopedQuery
        ? scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
        : pathWithoutSlash;
    const completionPath = isDirectory ? `${displayPath}/` : displayPath;
    return {
        value: buildCompletionValue(completionPath, { isAtPrefix: true, isQuotedPrefix }),
        label: basename(pathWithoutSlash) + (isDirectory ? "/" : ""),
        description: displayPath,
    };
}

// Fuzzy file search using fd (fast, respects .gitignore)
export async function getFuzzyFileSuggestions(query: string, search: FuzzyFileSearch): Promise<AutocompleteItem[]> {
    const { basePath, fdPath, isQuotedPrefix, signal } = search;
    if (!fdPath || signal.aborted) {
        return [];
    }

    try {
        const scopedQuery = resolveScopedFuzzyQuery(query, basePath);
        const fdBaseDir = scopedQuery?.baseDir ?? basePath;
        const fdQuery = scopedQuery?.query ?? query;
        const entries = await collectEntries(fdBaseDir, fdPath, fdQuery, signal);
        if (signal.aborted) {
            return [];
        }
        return rankEntries(entries, fdQuery).map((entry) => toSuggestion(entry, scopedQuery, isQuotedPrefix));
    } catch {
        return [];
    }
}
