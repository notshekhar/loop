/**
 * Pull requests of a project's repository, as loop reads them through `gh`
 * (packages/core/src/workspace/pullRequests.ts): a list, one PR in detail, its
 * conversation and diff, and the actions a reviewer takes. The shapes mirror
 * core's records field for field. Fields added after the first release are
 * optional, so a client still reads a host that predates them.
 */
import * as Schema from "effect/Schema";

export const LoopPullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type LoopPullRequestState = typeof LoopPullRequestState.Type;

export const LoopPullRequestListState = Schema.Literals(["open", "closed", "merged", "all"]);
export type LoopPullRequestListState = typeof LoopPullRequestListState.Type;

/** All PRs, the ones you opened, or the ones waiting on your review. */
export const LoopPullRequestInvolvement = Schema.Literals(["all", "authored", "reviewing"]);
export type LoopPullRequestInvolvement = typeof LoopPullRequestInvolvement.Type;

export const LoopPullRequestChecksState = Schema.Literals(["passing", "failing", "pending", "none"]);
export type LoopPullRequestChecksState = typeof LoopPullRequestChecksState.Type;

export const LoopPullRequestReviewDecision = Schema.NullOr(
  Schema.Literals(["approved", "changes_requested", "review_required"]),
);

export const LoopPullRequestActor = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  isBot: Schema.Boolean,
});

export const LoopPullRequestLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
});

export const LoopPullRequestSummary = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: LoopPullRequestState,
  isDraft: Schema.Boolean,
  author: Schema.NullOr(LoopPullRequestActor),
  headRef: Schema.String,
  baseRef: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  reviewDecision: LoopPullRequestReviewDecision,
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  url: Schema.String,
  labels: Schema.Array(LoopPullRequestLabel),
  checks: LoopPullRequestChecksState,
});
export type LoopPullRequestSummary = typeof LoopPullRequestSummary.Type;

export const LoopPullRequestCheck = Schema.Struct({
  name: Schema.String,
  /** pending | success | failure | skipped | neutral | cancelled */
  status: Schema.String,
  url: Schema.NullOr(Schema.String),
  workflow: Schema.NullOr(Schema.String),
});
export type LoopPullRequestCheck = typeof LoopPullRequestCheck.Type;

export const LoopPullRequestFile = Schema.Struct({
  path: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  viewed: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type LoopPullRequestFile = typeof LoopPullRequestFile.Type;

export const LoopPullRequestCommit = Schema.Struct({
  oid: Schema.String,
  headline: Schema.String,
  author: Schema.NullOr(Schema.String),
  committedAt: Schema.String,
});
export type LoopPullRequestCommit = typeof LoopPullRequestCommit.Type;

export const LoopPullRequestDetail = Schema.Struct({
  ...LoopPullRequestSummary.fields,
  body: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(Schema.String),
  mergeable: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  checkRuns: Schema.Array(LoopPullRequestCheck),
  files: Schema.Array(LoopPullRequestFile),
  commitCount: Schema.Number,
  commentCount: Schema.Number,
  reviewers: Schema.Array(Schema.Struct({ login: Schema.String, state: Schema.String })),
  commits: Schema.optional(Schema.Array(LoopPullRequestCommit)),
  headSha: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
  isCrossRepository: Schema.optional(Schema.Boolean),
});
export type LoopPullRequestDetail = typeof LoopPullRequestDetail.Type;

export const LoopPullRequestReviewComment = Schema.Struct({
  id: Schema.Number,
  author: Schema.NullOr(LoopPullRequestActor),
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export type LoopPullRequestReviewComment = typeof LoopPullRequestReviewComment.Type;

export const LoopPullRequestTimelineItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("comment"),
    id: Schema.String,
    author: Schema.NullOr(LoopPullRequestActor),
    body: Schema.String,
    createdAt: Schema.String,
    url: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    id: Schema.String,
    author: Schema.NullOr(LoopPullRequestActor),
    state: Schema.String,
    body: Schema.String,
    createdAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    id: Schema.Number,
    path: Schema.String,
    line: Schema.NullOr(Schema.Number),
    side: Schema.Literals(["LEFT", "RIGHT"]),
    diffHunk: Schema.String,
    comments: Schema.Array(LoopPullRequestReviewComment),
    createdAt: Schema.String,
  }),
]);
export type LoopPullRequestTimelineItem = typeof LoopPullRequestTimelineItem.Type;

export const LoopPullRequestAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("comment"), body: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    event: Schema.Literals(["approve", "request_changes", "comment"]),
    body: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("reply"), commentId: Schema.Number, body: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("line_comment"),
    path: Schema.String,
    line: Schema.Number,
    startLine: Schema.optional(Schema.Number),
    side: Schema.Literals(["LEFT", "RIGHT"]),
    commitId: Schema.String,
    body: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("viewed"),
    nodeId: Schema.String,
    path: Schema.String,
    viewed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("merge"),
    method: Schema.Literals(["squash", "merge", "rebase"]),
    deleteBranch: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("close") }),
  Schema.Struct({ kind: Schema.Literal("reopen") }),
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("draft") }),
]);
export type LoopPullRequestAction = typeof LoopPullRequestAction.Type;

export const LoopPullRequestActionInput = Schema.Struct({
  cwd: Schema.String,
  number: Schema.Number,
  action: LoopPullRequestAction,
});
export type LoopPullRequestActionInput = typeof LoopPullRequestActionInput.Type;

/** A browser sign-in of `gh`: the code to enter and where to enter it. */
export const LoopGithubLogin = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  url: Schema.String,
});
export type LoopGithubLogin = typeof LoopGithubLogin.Type;

export const LoopGithubLoginStatus = Schema.Struct({
  state: Schema.Literals(["pending", "done", "failed"]),
  error: Schema.NullOr(Schema.String),
});
export type LoopGithubLoginStatus = typeof LoopGithubLoginStatus.Type;

export const LoopPullRequestDiff = Schema.Struct({
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type LoopPullRequestDiff = typeof LoopPullRequestDiff.Type;

export const LoopPullRequestListInput = Schema.Struct({
  cwd: Schema.String,
  state: Schema.optional(LoopPullRequestListState),
  involvement: Schema.optional(LoopPullRequestInvolvement),
  limit: Schema.optional(Schema.Number),
});
export type LoopPullRequestListInput = typeof LoopPullRequestListInput.Type;

export const LoopPullRequestRefInput = Schema.Struct({
  cwd: Schema.String,
  number: Schema.Number,
});
export type LoopPullRequestRefInput = typeof LoopPullRequestRefInput.Type;

export class LoopPullRequestError extends Schema.TaggedError<LoopPullRequestError>()(
  "LoopPullRequestError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
