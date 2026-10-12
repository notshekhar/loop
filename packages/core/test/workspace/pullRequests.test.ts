/**
 * Pull requests read through `gh`: its JSON normalized into plain records —
 * states, the checks rollup, review decision, reviewers — and the list
 * filters turned into the right `gh pr list` arguments.
 */
import { describe, expect, test } from "bun:test";

import { checkOf, checksStateOf, detailOf, listArgs, summaryOf } from "../../src/workspace/pullRequests";

const raw = {
    number: 42,
    title: "Add PR screens",
    state: "OPEN",
    isDraft: false,
    author: { login: "notshekhar", name: "Shekhar", is_bot: false },
    headRefName: "feat/prs",
    baseRefName: "main",
    createdAt: "2026-10-10T10:00:00Z",
    updatedAt: "2026-10-12T10:00:00Z",
    reviewDecision: "CHANGES_REQUESTED",
    additions: 120,
    deletions: 4,
    changedFiles: 3,
    url: "https://github.com/o/r/pull/42",
    labels: [{ name: "mobile", color: "0e8a16" }],
    statusCheckRollup: [
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "ci", detailsUrl: "https://x/1" },
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "", workflowName: "ci" },
        { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS", targetUrl: "" },
    ],
};

describe("a pull request from gh", () => {
    test("summary: state, review decision, labels and a checks rollup", () => {
        const pr = summaryOf(raw);
        expect(pr).toMatchObject({
            number: 42,
            state: "open",
            reviewDecision: "changes_requested",
            headRef: "feat/prs",
            checks: "pending",
            author: { login: "notshekhar", isBot: false },
        });
        expect(pr.labels).toEqual([{ name: "mobile", color: "0e8a16" }]);
        expect(summaryOf({ ...raw, state: "MERGED" }).state).toBe("merged");
        expect(summaryOf({ ...raw, reviewDecision: "" }).reviewDecision).toBeNull();
    });

    test("checks: a failure fails, anything running is pending, none is none", () => {
        expect(checkOf({ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE", name: "x" }).status).toBe("failure");
        expect(checkOf({ __typename: "StatusContext", state: "ERROR", context: "ci" }).status).toBe("failure");
        expect(checkOf({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED", name: "x" }).status).toBe("skipped");
        expect(checksStateOf([])).toBe("none");
        expect(checksStateOf([{ name: "a", status: "success", url: null, workflow: null }])).toBe("passing");
        expect(
            checksStateOf([
                { name: "a", status: "pending", url: null, workflow: null },
                { name: "b", status: "failure", url: null, workflow: null },
            ]),
        ).toBe("failing");
    });

    test("detail: files, counts, mergeability, and each reviewer's latest state", () => {
        const pr = detailOf({
            ...raw,
            body: "Hello",
            mergeable: "CONFLICTING",
            files: [{ path: "a.ts", additions: 3, deletions: 1 }],
            commits: [{}, {}],
            comments: [{}],
            reviews: [
                { author: { login: "alice" }, state: "COMMENTED" },
                { author: { login: "alice" }, state: "APPROVED" },
            ],
            reviewRequests: [{ login: "bob" }, { login: "alice" }],
        });
        expect(pr.mergeable).toBe("conflicting");
        expect(pr.files).toEqual([{ path: "a.ts", additions: 3, deletions: 1 }]);
        expect(pr.commitCount).toBe(2);
        expect(pr.commentCount).toBe(1);
        expect(pr.reviewers).toEqual([
            { login: "alice", state: "approved" },
            { login: "bob", state: "requested" },
        ]);
        expect(pr.checkRuns.map((c) => c.status)).toEqual(["success", "pending", "success"]);
    });
});

describe("list filters", () => {
    test("become gh pr list arguments", () => {
        expect(listArgs({})).toEqual(expect.arrayContaining(["--state", "open", "--limit", "50"]));
        expect(listArgs({ state: "merged", involvement: "authored" })).toEqual(
            expect.arrayContaining(["--state", "merged", "--author", "@me"]),
        );
        expect(listArgs({ involvement: "reviewing" })).toEqual(
            expect.arrayContaining(["--search", "review-requested:@me"]),
        );
        expect(listArgs({ limit: 500 })).toEqual(expect.arrayContaining(["--limit", "100"]));
    });
});
