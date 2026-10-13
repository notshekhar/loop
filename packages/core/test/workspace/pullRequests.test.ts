/**
 * Pull requests read through `gh`: its JSON normalized into plain records —
 * states, the checks rollup, review decision, reviewers — and the list
 * filters turned into the right `gh pr list` arguments.
 */
import { describe, expect, test } from "bun:test";

import { parseDeviceCode } from "../../src/workspace/githubAuth";
import {
    actionArgs,
    checkOf,
    checksStateOf,
    detailOf,
    listArgs,
    repositoryOf,
    summaryOf,
    timelineOf,
} from "../../src/workspace/pullRequests";

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
        expect(pr.files).toEqual([{ path: "a.ts", additions: 3, deletions: 1, viewed: null }]);
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

describe("the conversation", () => {
    test("comments, reviews with a summary, and line threads with their replies, oldest first", () => {
        const items = timelineOf(
            {
                comments: [{ id: "IC_1", author: { login: "bob" }, body: "LGTM?", createdAt: "2026-10-12T10:05:00Z" }],
                reviews: [
                    { id: "R1", author: { login: "alice" }, state: "CHANGES_REQUESTED", body: "Fix it", submittedAt: "2026-10-12T10:10:00Z" },
                    // Only the wrapper of line comments: not its own entry.
                    { id: "R2", author: { login: "alice" }, state: "COMMENTED", body: "", submittedAt: "2026-10-12T10:11:00Z" },
                ],
            },
            [
                { id: 7, path: "a.ts", line: 3, side: "RIGHT", diff_hunk: "@@", body: "why?", user: { login: "alice", type: "User" }, created_at: "2026-10-12T10:00:00Z" },
                { id: 8, in_reply_to_id: 7, path: "a.ts", line: 3, body: "because", user: { login: "bot[bot]", type: "Bot" }, created_at: "2026-10-12T10:01:00Z" },
                { id: 9, path: "b.ts", line: null, side: "LEFT", diff_hunk: "@@", body: "old", user: { login: "x" }, created_at: "2026-10-12T10:20:00Z" },
            ],
        );
        expect(items.map((i) => i.kind)).toEqual(["thread", "comment", "review", "thread"]);
        const first = items[0];
        expect(first?.kind === "thread" && first.comments.map((c) => c.body)).toEqual(["why?", "because"]);
        expect(first?.kind === "thread" && first.comments[1]?.author?.isBot).toBe(true);
        const last = items[3];
        expect(last?.kind === "thread" && last.line).toBeNull();
        expect(items[2]).toMatchObject({ kind: "review", state: "changes_requested", body: "Fix it" });
    });
});

describe("actions", () => {
    test("become gh arguments, and a merge never deletes the local branch", () => {
        expect(actionArgs(4, { kind: "comment", body: "hi" })).toEqual(["pr", "comment", "4", "--body", "hi"]);
        expect(actionArgs(4, { kind: "review", event: "approve", body: "" })).toEqual(["pr", "review", "4", "--approve"]);
        expect(actionArgs(4, { kind: "review", event: "request_changes", body: "no" })).toEqual([
            "pr",
            "review",
            "4",
            "--request-changes",
            "--body",
            "no",
        ]);
        const merge = actionArgs(4, { kind: "merge", method: "squash", deleteBranch: true });
        expect(merge).toEqual(["pr", "merge", "4", "--squash"]);
        expect(actionArgs(4, { kind: "draft" })).toEqual(["pr", "ready", "4", "--undo"]);
    });

    test("a line comment names the head commit, the line, and a range's first line", () => {
        const args = actionArgs(4, {
            kind: "line_comment",
            path: "a.ts",
            line: 12,
            startLine: 10,
            side: "RIGHT",
            commitId: "abc",
            body: "x",
        });
        expect(args.slice(0, 4)).toEqual(["api", "-X", "POST", "repos/{owner}/{repo}/pulls/4/comments"]);
        expect(args).toEqual(expect.arrayContaining(["commit_id=abc", "path=a.ts", "line=12", "start_line=10", "side=RIGHT"]));
        const single = actionArgs(4, { kind: "line_comment", path: "a.ts", line: 12, side: "LEFT", commitId: "abc", body: "x" });
        expect(single.some((a) => a.startsWith("start_line"))).toBe(false);
    });

    test("viewed goes through GraphQL", () => {
        const args = actionArgs(4, { kind: "viewed", nodeId: "PR_1", path: "a.ts", viewed: false });
        expect(args[1]).toBe("graphql");
        expect(args.join(" ")).toContain("unmarkFileAsViewed");
        expect(args).toEqual(expect.arrayContaining(["id=PR_1", "path=a.ts"]));
    });

    test("the repository and host come from the PR's URL", () => {
        expect(repositoryOf("https://github.com/o/r/pull/2")).toEqual({ host: "github.com", owner: "o", repo: "r" });
        expect(repositoryOf("https://ghe.acme.dev/team/app/pull/9")?.host).toBe("ghe.acme.dev");
        expect(repositoryOf("nope")).toBeNull();
    });
});

describe("signing gh in", () => {
    test("reads the one-time code and where to enter it", () => {
        expect(
            parseDeviceCode(
                "! First copy your one-time code: ab12-cd34\nOpen this URL to continue in your web browser: https://github.com/login/device",
            ),
        ).toEqual({ code: "AB12-CD34", url: "https://github.com/login/device" });
        expect(parseDeviceCode("still starting")).toBeNull();
    });
});
