import { describe, expect, test } from "bun:test";

import { isStaged, isUnstaged, parsePorcelainV2 } from "../../src/workspace/porcelain";

/** Records as git writes them with -z: NUL after every one. */
const z = (...records: string[]) => `${records.join("\0")}\0`;

describe("ordinary entries", () => {
    test("splits the XY pair into an index side and a worktree side", () => {
        // "MM" is the case the old data model could not express at all: staged
        // edits AND further unstaged edits to the same file.
        const [entry] = parsePorcelainV2(z("1 MM N... 100644 100644 100644 aaaa bbbb src/git.ts"));
        expect(entry?.path).toBe("src/git.ts");
        expect(entry?.indexStatus).toBe("M");
        expect(entry?.worktreeStatus).toBe("M");
        expect(isStaged(entry!)).toBe(true);
        expect(isUnstaged(entry!)).toBe(true);
    });

    test("a dot means nothing on that side", () => {
        const [staged] = parsePorcelainV2(z("1 M. N... 100644 100644 100644 aaaa bbbb a.ts"));
        expect(staged?.indexStatus).toBe("M");
        expect(staged?.worktreeStatus).toBeNull();
        expect(isUnstaged(staged!)).toBe(false);

        const [unstaged] = parsePorcelainV2(z("1 .M N... 100644 100644 100644 aaaa bbbb b.ts"));
        expect(unstaged?.indexStatus).toBeNull();
        expect(isStaged(unstaged!)).toBe(false);
        expect(isUnstaged(unstaged!)).toBe(true);
    });

    test("a path containing spaces survives", () => {
        // The trailing field is a path and must not be split on whitespace.
        const [entry] = parsePorcelainV2(z("1 .M N... 100644 100644 100644 aaaa bbbb src/my notes file.md"));
        expect(entry?.path).toBe("src/my notes file.md");
    });
});

describe("renames", () => {
    test("consumes the source path instead of treating it as another file", () => {
        // The bug this exists to prevent: with -z a rename spends TWO NUL-separated
        // fields, so a naive split turns every rename's source into a phantom entry.
        const entries = parsePorcelainV2(
            z(
                "2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new.ts",
                "src/old.ts",
                "1 .M N... 100644 100644 100644 cccc dddd src/other.ts",
            ),
        );
        expect(entries).toHaveLength(2);
        expect(entries[0]?.path).toBe("src/new.ts");
        expect(entries[0]?.originalPath).toBe("src/old.ts");
        expect(entries[0]?.score).toBe(100);
        // The record after the rename is still parsed as itself.
        expect(entries[1]?.path).toBe("src/other.ts");
    });
});

describe("conflicts", () => {
    test("names every unmerged combination git can report", () => {
        const cases: Array<[string, string]> = [
            ["UU", "both-modified"],
            ["AA", "both-added"],
            ["DD", "both-deleted"],
            ["AU", "added-by-us"],
            ["UA", "added-by-them"],
            ["DU", "deleted-by-us"],
            ["UD", "deleted-by-them"],
        ];
        for (const [xy, expected] of cases) {
            const [entry] = parsePorcelainV2(
                z(`u ${xy} N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts`),
            );
            expect(entry?.conflict).toBe(expected as never);
        }
    });

    test("a conflicted file is neither staged nor unstaged", () => {
        // It is its own state: offering "unstage" on a conflict would be a lie, and
        // it must not be swept into either group.
        const [entry] = parsePorcelainV2(z("u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/x.ts"));
        expect(isStaged(entry!)).toBe(false);
        expect(isUnstaged(entry!)).toBe(false);
    });
});

describe("untracked and ignored", () => {
    test("untracked files are unstaged, and carry no status letters", () => {
        const [entry] = parsePorcelainV2(z("? src/brand new.ts"));
        expect(entry?.path).toBe("src/brand new.ts");
        expect(entry?.untracked).toBe(true);
        expect(entry?.indexStatus).toBeNull();
        expect(isUnstaged(entry!)).toBe(true);
        expect(isStaged(entry!)).toBe(false);
    });

    test("ignored files are marked so they can be left out", () => {
        const [entry] = parsePorcelainV2(z("! node_modules/x.js"));
        expect(entry?.ignored).toBe(true);
        expect(entry?.untracked).toBe(false);
    });
});

describe("robustness", () => {
    test("empty output is no entries, not a crash", () => {
        expect(parsePorcelainV2("")).toEqual([]);
        expect(parsePorcelainV2("\0")).toEqual([]);
    });

    test("a truncated record is skipped rather than half-read", () => {
        // Better to lose one malformed row than to index into a ragged array and
        // report a file whose path is a mode bit.
        const entries = parsePorcelainV2(z("1 MM N... 100644", "1 .M N... 100644 100644 100644 aaaa bbbb good.ts"));
        expect(entries).toHaveLength(1);
        expect(entries[0]?.path).toBe("good.ts");
    });

    test("header lines are ignored", () => {
        // `--branch` adds `# branch.*` records; they are not files.
        const entries = parsePorcelainV2(
            z("# branch.oid aaaa", "# branch.head main", "1 .M N... 100644 100644 100644 a b f.ts"),
        );
        expect(entries).toHaveLength(1);
        expect(entries[0]?.path).toBe("f.ts");
    });
});
