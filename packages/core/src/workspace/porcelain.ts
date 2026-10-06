/**
 * `git status --porcelain=v2 -z`, parsed.
 *
 * The SCM panel could only ever show a flat list because the data behind it was
 * `git diff --numstat HEAD` — which fuses the index and the working tree into
 * one answer and carries no status letters at all. Nothing downstream could
 * distinguish a staged change from an unstaged one, or notice a conflict,
 * because that information was never read in the first place.
 *
 * Porcelain v2 is the format that has it: per-file index and worktree status
 * codes, rename detection with the original path, and unmerged entries carrying
 * the three index stages a merge leaves behind. Version 2 specifically — v1's
 * rename field is ambiguous, and the human-readable output is explicitly not a
 * stable interface.
 *
 * Kept free of any process spawning so the parsing can be tested against
 * captured output, which is the only practical way to cover states like "added
 * by them" that are a nuisance to manufacture with a real repository.
 */

/** A single letter from git's XY status pair. */
export type StatusCode = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?" | "!";

/**
 * How a file came to be conflicted, from the XY pair on an unmerged record.
 *
 * Both halves matter for what the UI can offer: "both modified" has a base to
 * merge against, while "both added" has none, and "deleted by them" is a choice
 * between keeping a file and dropping it rather than a text merge at all.
 */
export type ConflictKind =
    | "both-modified"
    | "both-added"
    | "both-deleted"
    | "added-by-us"
    | "added-by-them"
    | "deleted-by-us"
    | "deleted-by-them";

export interface PorcelainEntry {
    readonly path: string;
    /** Where a rename or copy came from. Absent otherwise. */
    readonly originalPath?: string;
    /** X — the index against HEAD. Null when the index matches HEAD. */
    readonly indexStatus: StatusCode | null;
    /** Y — the working tree against the index. Null when they match. */
    readonly worktreeStatus: StatusCode | null;
    /** Untracked, so it has no index side at all until it is added. */
    readonly untracked: boolean;
    readonly ignored: boolean;
    /** Set only on unmerged entries. */
    readonly conflict?: ConflictKind;
    /** Rename/copy similarity score, 0-100, when git reported one. */
    readonly score?: number;
}

const CONFLICTS: Record<string, ConflictKind> = {
    DD: "both-deleted",
    AU: "added-by-us",
    UD: "deleted-by-them",
    UA: "added-by-them",
    DU: "deleted-by-us",
    AA: "both-added",
    UU: "both-modified",
};

const CODES = new Set(["M", "A", "D", "R", "C", "T", "U", "?", "!"]);

/** "." is git's "nothing here", which is a null status rather than a letter. */
function codeOf(letter: string | undefined): StatusCode | null {
    if (letter === undefined || letter === "." || letter === "") return null;
    return CODES.has(letter) ? (letter as StatusCode) : null;
}

/**
 * Parse the whole `-z` stream.
 *
 * The awkward part, and the reason this walks the tokens rather than mapping
 * over them: `-z` terminates every record with NUL, but a rename or copy
 * (a type `2` record) spends **two** NUL-terminated fields — the record, then
 * the original path. Treating each NUL-separated token as one record therefore
 * turns every rename's source path into a bogus entry of its own, which is the
 * kind of bug that only shows up once somebody renames a file.
 */
export function parsePorcelainV2(output: string): PorcelainEntry[] {
    const tokens = output.split("\0");
    const entries: PorcelainEntry[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const record = tokens[i];
        if (record === undefined || record === "") continue;

        const kind = record[0];

        if (kind === "?" || kind === "!") {
            entries.push({
                path: record.slice(2),
                indexStatus: null,
                worktreeStatus: null,
                untracked: kind === "?",
                ignored: kind === "!",
            });
            continue;
        }

        if (kind === "1") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            const fields = splitFields(record, 8);
            if (!fields) continue;
            const [, xy] = fields;
            entries.push({
                path: fields[8] ?? "",
                indexStatus: codeOf(xy?.[0]),
                worktreeStatus: codeOf(xy?.[1]),
                untracked: false,
                ignored: false,
            });
            continue;
        }

        if (kind === "2") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>, then <origPath>.
            const fields = splitFields(record, 9);
            if (!fields) continue;
            const [, xy] = fields;
            const score = Number.parseInt((fields[8] ?? "").slice(1), 10);
            // The source path is the next NUL-terminated field, not part of this one.
            const originalPath = tokens[i + 1] ?? "";
            i += 1;
            entries.push({
                path: fields[9] ?? "",
                originalPath,
                indexStatus: codeOf(xy?.[0]),
                worktreeStatus: codeOf(xy?.[1]),
                untracked: false,
                ignored: false,
                ...(Number.isFinite(score) ? { score } : {}),
            });
            continue;
        }

        if (kind === "u") {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            const fields = splitFields(record, 10);
            if (!fields) continue;
            const xy = fields[1] ?? "";
            entries.push({
                path: fields[10] ?? "",
                indexStatus: codeOf(xy[0]),
                worktreeStatus: codeOf(xy[1]),
                untracked: false,
                ignored: false,
                // An unmerged record git does not name is still a conflict; treat an
                // unrecognised pair as the common case rather than dropping the entry.
                conflict: CONFLICTS[xy] ?? "both-modified",
            });
        }
    }

    return entries;
}

/**
 * Split a record into `count` space-separated fields plus the rest.
 *
 * The trailing field is a path and may contain spaces, so it cannot be split
 * on — everything after the last header field is taken verbatim. Returns null
 * when the record is too short to be the shape it claims, which is safer than
 * indexing into a ragged array.
 */
function splitFields(record: string, count: number): string[] | null {
    const fields: string[] = [];
    let offset = 0;
    for (let i = 0; i < count; i++) {
        const next = record.indexOf(" ", offset);
        if (next === -1) return null;
        fields.push(record.slice(offset, next));
        offset = next + 1;
    }
    fields.push(record.slice(offset));
    return fields;
}

/** Whether this entry has something in the index waiting to be committed. */
export function isStaged(entry: PorcelainEntry): boolean {
    return entry.conflict === undefined && entry.indexStatus !== null;
}

/** Whether the working tree differs from the index (including untracked). */
export function isUnstaged(entry: PorcelainEntry): boolean {
    if (entry.conflict !== undefined) return false;
    return entry.untracked || entry.worktreeStatus !== null;
}
