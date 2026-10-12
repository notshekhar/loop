/**
 * Pull requests of a project's repository, as loop reads them through `gh`
 * (packages/core/src/workspace/pullRequests.ts). Read-only: a list, one PR in
 * detail, and its diff. The shapes mirror core's records field for field.
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
});
export type LoopPullRequestFile = typeof LoopPullRequestFile.Type;

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
});
export type LoopPullRequestDetail = typeof LoopPullRequestDetail.Type;

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
