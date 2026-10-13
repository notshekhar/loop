import type { LoopPullRequestSummary, LoopPullRequestTimelineItem } from "@loop/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isGhMissingError,
  isGithubAuthError,
  lineCommentAnchor,
  matchesPullRequestQuery,
  reviewPrompt,
  stateTone,
  threadsByLine,
} from "./pullRequestPresentation";

const pr: LoopPullRequestSummary = {
  number: 42,
  title: "Add pull request page",
  state: "open",
  isDraft: false,
  author: { login: "notshekhar", name: null, isBot: false },
  headRef: "feat/prs",
  baseRef: "main",
  createdAt: "2026-10-12T10:00:00Z",
  updatedAt: "2026-10-12T10:00:00Z",
  reviewDecision: null,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  url: "https://github.com/o/r/pull/42",
  labels: [{ name: "desktop", color: null }],
  checks: "none",
};

describe("pull request list", () => {
  it("finds a PR by number, title words, author, branch or label", () => {
    expect(matchesPullRequestQuery(pr, "")).toBe(true);
    expect(matchesPullRequestQuery(pr, "#42")).toBe(true);
    expect(matchesPullRequestQuery(pr, "4")).toBe(true);
    expect(matchesPullRequestQuery(pr, "page add")).toBe(true);
    expect(matchesPullRequestQuery(pr, "shekhar feat/prs")).toBe(true);
    expect(matchesPullRequestQuery(pr, "desktop")).toBe(true);
    expect(matchesPullRequestQuery(pr, "mobile")).toBe(false);
    expect(matchesPullRequestQuery(pr, "#7")).toBe(false);
  });

  it("names drafts and merged PRs", () => {
    expect(stateTone({ state: "open", isDraft: true }).label).toBe("Draft");
    expect(stateTone({ state: "merged", isDraft: false }).label).toBe("Merged");
  });
});

describe("line comments", () => {
  it("anchor to the last selected line, with the first one for a range", () => {
    expect(lineCommentAnchor({ start: 5, end: 5, side: "additions" })).toEqual({ line: 5, side: "RIGHT" });
    expect(lineCommentAnchor({ start: 8, end: 3, side: "deletions" })).toEqual({
      line: 8,
      startLine: 3,
      side: "LEFT",
    });
  });

  it("group threads by side and line, leaving outdated ones out", () => {
    const thread = (id: number, line: number | null, side: "LEFT" | "RIGHT", path = "a.ts") =>
      ({
        kind: "thread",
        id,
        path,
        line,
        side,
        diffHunk: "",
        comments: [],
        createdAt: "",
      }) satisfies LoopPullRequestTimelineItem;
    const groups = threadsByLine(
      [thread(1, 3, "RIGHT"), thread(2, 3, "RIGHT"), thread(3, 3, "LEFT"), thread(4, null, "RIGHT"), thread(5, 3, "RIGHT", "b.ts")],
      "a.ts",
    );
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.side === "additions")?.threads.map((t) => t.id)).toEqual([1, 2]);
    expect(groups.find((g) => g.side === "deletions")?.lineNumber).toBe(3);
  });
});

describe("GitHub problems", () => {
  it("tell a missing login from a missing gh", () => {
    expect(isGithubAuthError("HTTP 401: Requires authentication. Try gh auth login")).toBe(true);
    expect(isGithubAuthError("Listing pull requests failed: no pull requests")).toBe(false);
    expect(isGhMissingError("The GitHub CLI (gh) is not installed or not on PATH.")).toBe(true);
  });

  it("asks loop to review without changing anything", () => {
    const prompt = reviewPrompt(pr);
    expect(prompt).toContain("gh pr diff 42");
    expect(prompt).toContain("don't post anything to GitHub");
  });
});
