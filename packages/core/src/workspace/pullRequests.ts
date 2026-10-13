/**
 * Pull requests of a project's GitHub repository, read through the `gh` CLI.
 *
 * `gh` already holds the user's login and speaks GitHub's API, and loop uses
 * it for publishing and for opening PRs — so reading PRs needs no token, no
 * API client and no cache of our own: one `gh pr …` per request, run in the
 * project's folder so `gh` resolves the repository from its remote.
 *
 * Reads — the list, one PR in detail, its conversation and its diff — and the
 * writes a reviewer needs: comment, review, reply, comment on a line, mark a
 * file viewed, merge, close, reopen, and draft ↔ ready. Everything is
 * normalized here into plain records, so the screens never parse `gh` JSON.
 */
import { gh, ghError } from "./sourceControl";

export type PullRequestState = "open" | "closed" | "merged";
export type PullRequestListState = PullRequestState | "all";
/** All PRs, the ones you opened, or the ones waiting on your review. */
export type PullRequestInvolvement = "all" | "authored" | "reviewing";
export type PullRequestChecksState = "passing" | "failing" | "pending" | "none";
export type PullRequestReviewDecision = "approved" | "changes_requested" | "review_required" | null;

export interface PullRequestActor {
    readonly login: string;
    readonly name: string | null;
    readonly isBot: boolean;
}

export interface PullRequestCheck {
    readonly name: string;
    /** pending | success | failure | skipped | neutral | cancelled */
    readonly status: string;
    readonly url: string | null;
    readonly workflow: string | null;
}

export interface PullRequestSummary {
    readonly number: number;
    readonly title: string;
    readonly state: PullRequestState;
    readonly isDraft: boolean;
    readonly author: PullRequestActor | null;
    readonly headRef: string;
    readonly baseRef: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly reviewDecision: PullRequestReviewDecision;
    readonly additions: number;
    readonly deletions: number;
    readonly changedFiles: number;
    readonly url: string;
    readonly labels: ReadonlyArray<{ readonly name: string; readonly color: string | null }>;
    readonly checks: PullRequestChecksState;
}

export interface PullRequestFile {
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
    /** GitHub's own "Viewed" checkbox; null when it could not be read. */
    readonly viewed: boolean | null;
}

export interface PullRequestCommit {
    readonly oid: string;
    readonly headline: string;
    readonly author: string | null;
    readonly committedAt: string;
}

export interface PullRequestDetail extends PullRequestSummary {
    readonly body: string;
    readonly mergedAt: string | null;
    readonly closedAt: string | null;
    readonly mergeable: "mergeable" | "conflicting" | "unknown";
    readonly checkRuns: ReadonlyArray<PullRequestCheck>;
    readonly files: ReadonlyArray<PullRequestFile>;
    readonly commitCount: number;
    readonly commentCount: number;
    readonly reviewers: ReadonlyArray<{ readonly login: string; readonly state: string }>;
    readonly commits: ReadonlyArray<PullRequestCommit>;
    /** The head commit, which a line comment must name. */
    readonly headSha: string;
    /** GraphQL node id, which marking a file viewed must name. */
    readonly nodeId: string;
    /** A fork's PR: its branch is not ours to delete after a merge. */
    readonly isCrossRepository: boolean;
}

/** One comment on a line, or a reply to one. */
export interface PullRequestReviewComment {
    readonly id: number;
    readonly author: PullRequestActor | null;
    readonly body: string;
    readonly createdAt: string;
    readonly url: string | null;
}

/** What the Conversation tab draws, oldest first. */
export type PullRequestTimelineItem =
    | {
          readonly kind: "comment";
          readonly id: string;
          readonly author: PullRequestActor | null;
          readonly body: string;
          readonly createdAt: string;
          readonly url: string | null;
      }
    | {
          readonly kind: "review";
          readonly id: string;
          readonly author: PullRequestActor | null;
          /** approved | changes_requested | commented | dismissed | pending */
          readonly state: string;
          readonly body: string;
          readonly createdAt: string;
      }
    | {
          readonly kind: "thread";
          /** The first comment's id, which a reply is addressed to. */
          readonly id: number;
          readonly path: string;
          /** null once the line is gone from the latest diff (outdated). */
          readonly line: number | null;
          readonly side: "LEFT" | "RIGHT";
          readonly diffHunk: string;
          readonly comments: ReadonlyArray<PullRequestReviewComment>;
          readonly createdAt: string;
      };

export type PullRequestAction =
    | { readonly kind: "comment"; readonly body: string }
    | {
          readonly kind: "review";
          readonly event: "approve" | "request_changes" | "comment";
          readonly body: string;
      }
    | { readonly kind: "reply"; readonly commentId: number; readonly body: string }
    | {
          readonly kind: "line_comment";
          readonly path: string;
          readonly line: number;
          readonly startLine?: number;
          readonly side: "LEFT" | "RIGHT";
          readonly commitId: string;
          readonly body: string;
      }
    | { readonly kind: "viewed"; readonly nodeId: string; readonly path: string; readonly viewed: boolean }
    | {
          readonly kind: "merge";
          readonly method: "squash" | "merge" | "rebase";
          readonly deleteBranch: boolean;
      }
    | { readonly kind: "close" }
    | { readonly kind: "reopen" }
    | { readonly kind: "ready" }
    | { readonly kind: "draft" };

const SUMMARY_FIELDS =
    "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,reviewDecision,additions,deletions,changedFiles,url,labels,statusCheckRollup";
const DETAIL_FIELDS = `${SUMMARY_FIELDS},id,body,mergedAt,closedAt,mergeable,files,commits,comments,reviews,reviewRequests,headRefOid,isCrossRepository`;

/** A diff above this is cut: no screen has a use for a 20 MB patch. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

type Json = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function actorOf(value: unknown): PullRequestActor | null {
    if (!value || typeof value !== "object") return null;
    const a = value as Json;
    const login = str(a.login);
    if (!login) return null;
    return { login, name: str(a.name) || null, isBot: a.is_bot === true || login.endsWith("[bot]") };
}

function stateOf(value: unknown): PullRequestState {
    const s = str(value).toLowerCase();
    return s === "merged" ? "merged" : s === "closed" ? "closed" : "open";
}

function reviewDecisionOf(value: unknown): PullRequestReviewDecision {
    switch (str(value)) {
        case "APPROVED":
            return "approved";
        case "CHANGES_REQUESTED":
            return "changes_requested";
        case "REVIEW_REQUIRED":
            return "review_required";
        default:
            return null;
    }
}

/** One entry of `statusCheckRollup`: a CheckRun (Actions) or a StatusContext (commit status). */
export function checkOf(value: unknown): PullRequestCheck {
    const c = (value ?? {}) as Json;
    if (c.__typename === "StatusContext") {
        const state = str(c.state).toLowerCase();
        return {
            name: str(c.context) || "status",
            status:
                state === "success"
                    ? "success"
                    : state === "failure" || state === "error"
                      ? "failure"
                      : "pending",
            url: str(c.targetUrl) || null,
            workflow: null,
        };
    }
    const status = str(c.status).toLowerCase();
    const conclusion = str(c.conclusion).toLowerCase();
    const resolved =
        status !== "completed"
            ? "pending"
            : conclusion === "success"
              ? "success"
              : conclusion === "skipped"
                ? "skipped"
                : conclusion === "neutral"
                  ? "neutral"
                  : conclusion === "cancelled"
                    ? "cancelled"
                    : "failure";
    return {
        name: str(c.name) || "check",
        status: resolved,
        url: str(c.detailsUrl) || null,
        workflow: str(c.workflowName) || null,
    };
}

/** The rollup in one word: any failure fails, else anything still running is pending. */
export function checksStateOf(checks: ReadonlyArray<PullRequestCheck>): PullRequestChecksState {
    if (checks.length === 0) return "none";
    if (checks.some((c) => c.status === "failure")) return "failing";
    if (checks.some((c) => c.status === "pending")) return "pending";
    return "passing";
}

function labelsOf(value: unknown): PullRequestSummary["labels"] {
    if (!Array.isArray(value)) return [];
    return value
        .map((l) => (l && typeof l === "object" ? (l as Json) : null))
        .filter((l): l is Json => l !== null && !!str(l.name))
        .map((l) => ({ name: str(l.name), color: str(l.color) || null }));
}

export function summaryOf(raw: Json): PullRequestSummary {
    const checks = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup.map(checkOf) : [];
    return {
        number: num(raw.number),
        title: str(raw.title),
        state: stateOf(raw.state),
        isDraft: raw.isDraft === true,
        author: actorOf(raw.author),
        headRef: str(raw.headRefName),
        baseRef: str(raw.baseRefName),
        createdAt: str(raw.createdAt),
        updatedAt: str(raw.updatedAt),
        reviewDecision: reviewDecisionOf(raw.reviewDecision),
        additions: num(raw.additions),
        deletions: num(raw.deletions),
        changedFiles: num(raw.changedFiles),
        url: str(raw.url),
        labels: labelsOf(raw.labels),
        checks: checksStateOf(checks),
    };
}

export function detailOf(raw: Json): PullRequestDetail {
    const checkRuns = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup.map(checkOf) : [];
    const files = Array.isArray(raw.files)
        ? raw.files
              .map((f) => (f && typeof f === "object" ? (f as Json) : null))
              .filter((f): f is Json => f !== null && !!str(f.path))
              .map((f) => ({
                  path: str(f.path),
                  additions: num(f.additions),
                  deletions: num(f.deletions),
                  viewed: null,
              }))
        : [];
    const commits = Array.isArray(raw.commits)
        ? raw.commits.map((c) => {
              const commit = (c ?? {}) as Json;
              const first = Array.isArray(commit.authors) ? ((commit.authors[0] ?? {}) as Json) : {};
              return {
                  oid: str(commit.oid),
                  headline: str(commit.messageHeadline),
                  author: str(first.login) || str(first.name) || null,
                  committedAt: str(commit.committedDate),
              };
          })
        : [];
    // The latest review per reviewer, plus anyone asked who has not reviewed yet.
    const latest = new Map<string, string>();
    if (Array.isArray(raw.reviews)) {
        for (const r of raw.reviews) {
            const review = (r ?? {}) as Json;
            const login = str((review.author as Json | undefined)?.login);
            if (login) latest.set(login, str(review.state).toLowerCase() || "commented");
        }
    }
    if (Array.isArray(raw.reviewRequests)) {
        for (const r of raw.reviewRequests) {
            const request = (r ?? {}) as Json;
            const login = str(request.login) || str(request.name) || str(request.slug);
            if (login && !latest.has(login)) latest.set(login, "requested");
        }
    }
    const mergeable = str(raw.mergeable).toUpperCase();
    return {
        ...summaryOf(raw),
        body: str(raw.body),
        mergedAt: str(raw.mergedAt) || null,
        closedAt: str(raw.closedAt) || null,
        mergeable: mergeable === "MERGEABLE" ? "mergeable" : mergeable === "CONFLICTING" ? "conflicting" : "unknown",
        checkRuns,
        files,
        commitCount: commits.length,
        commentCount: Array.isArray(raw.comments) ? raw.comments.length : 0,
        reviewers: [...latest].map(([login, state]) => ({ login, state })),
        commits,
        headSha: str(raw.headRefOid),
        nodeId: str(raw.id),
        isCrossRepository: raw.isCrossRepository === true,
    };
}

/** owner, repo and host from a PR's URL — GraphQL and REST calls need them spelled out. */
export function repositoryOf(url: string): { host: string; owner: string; repo: string } | null {
    const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
    return match ? { host: match[1]!, owner: match[2]!, repo: match[3]! } : null;
}

/** `--hostname` for anything but github.com, so Enterprise hosts get their own API. */
function hostArgs(host: string): string[] {
    return host === "github.com" ? [] : ["--hostname", host];
}

const VIEWED_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        nodes { path viewerViewedState }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** Which files you have ticked "Viewed" on GitHub. Null when it cannot be read. */
async function viewedFiles(cwd: string, url: string): Promise<Map<string, boolean> | null> {
    const repo = repositoryOf(url);
    const number = /\/pull\/(\d+)/.exec(url)?.[1];
    if (!repo || !number) return null;
    const viewed = new Map<string, boolean>();
    let after: string | null = null;
    for (let page = 0; page < 30; page++) {
        const args = [
            "api",
            "graphql",
            ...hostArgs(repo.host),
            "-f",
            `query=${VIEWED_QUERY}`,
            "-F",
            `owner=${repo.owner}`,
            "-F",
            `repo=${repo.repo}`,
            "-F",
            `number=${number}`,
            ...(after ? ["-F", `after=${after}`] : []),
        ];
        const result = await gh(args, { cwd });
        if (!result.ok) return null;
        const files = (JSON.parse(result.stdout) as Json)?.data as Json | undefined;
        const connection = ((files?.repository as Json | undefined)?.pullRequest as Json | undefined)?.files as
            | Json
            | undefined;
        const nodes = Array.isArray(connection?.nodes) ? (connection.nodes as Json[]) : [];
        for (const node of nodes) viewed.set(str(node.path), str(node.viewerViewedState) === "VIEWED");
        const info = (connection?.pageInfo ?? {}) as Json;
        if (info.hasNextPage !== true) break;
        after = str(info.endCursor) || null;
        if (!after) break;
    }
    return viewed;
}

/** `gh pr list` arguments for a filter. Exported for tests. */
export function listArgs(input: {
    readonly state?: PullRequestListState;
    readonly involvement?: PullRequestInvolvement;
    readonly limit?: number;
}): string[] {
    const args = [
        "pr",
        "list",
        "--state",
        input.state ?? "open",
        "--limit",
        String(Math.max(1, Math.min(100, input.limit ?? 50))),
        "--json",
        SUMMARY_FIELDS,
    ];
    if (input.involvement === "authored") args.push("--author", "@me");
    if (input.involvement === "reviewing") args.push("--search", "review-requested:@me");
    return args;
}

export async function listPullRequests(input: {
    readonly cwd: string;
    readonly state?: PullRequestListState;
    readonly involvement?: PullRequestInvolvement;
    readonly limit?: number;
}): Promise<PullRequestSummary[]> {
    const result = await gh(listArgs(input), { cwd: input.cwd });
    if (!result.ok) throw ghError("Listing pull requests", result);
    const rows = JSON.parse(result.stdout || "[]") as Json[];
    return rows.map(summaryOf);
}

export async function pullRequestDetail(input: { readonly cwd: string; readonly number: number }): Promise<PullRequestDetail> {
    const result = await gh(["pr", "view", String(input.number), "--json", DETAIL_FIELDS], { cwd: input.cwd });
    if (!result.ok) throw ghError(`Reading pull request #${input.number}`, result);
    const detail = detailOf(JSON.parse(result.stdout) as Json);
    // Viewed state lives only in GraphQL; a PR is still worth showing without it.
    const viewed = await viewedFiles(input.cwd, detail.url).catch(() => null);
    if (!viewed) return detail;
    return {
        ...detail,
        files: detail.files.map((file) => ({ ...file, viewed: viewed.get(file.path) ?? false })),
    };
}

/** Comments, reviews and line threads of one PR, oldest first. Exported for tests. */
export function timelineOf(view: Json, lineComments: ReadonlyArray<Json>): PullRequestTimelineItem[] {
    const items: PullRequestTimelineItem[] = [];
    if (Array.isArray(view.comments)) {
        for (const c of view.comments) {
            const comment = (c ?? {}) as Json;
            items.push({
                kind: "comment",
                id: str(comment.id) || `comment-${items.length}`,
                author: actorOf(comment.author),
                body: str(comment.body),
                createdAt: str(comment.createdAt),
                url: str(comment.url) || null,
            });
        }
    }
    if (Array.isArray(view.reviews)) {
        for (const r of view.reviews) {
            const review = (r ?? {}) as Json;
            const state = str(review.state).toLowerCase() || "commented";
            // A "commented" review with no summary is only the wrapper of line
            // comments, which show as their own threads.
            if (state === "commented" && !str(review.body).trim()) continue;
            items.push({
                kind: "review",
                id: str(review.id) || `review-${items.length}`,
                author: actorOf(review.author),
                state,
                body: str(review.body),
                createdAt: str(review.submittedAt),
            });
        }
    }
    const threads = new Map<number, { root: Json; replies: Json[] }>();
    for (const c of lineComments) {
        const id = num(c.id);
        const parent = num(c.in_reply_to_id);
        if (parent && threads.has(parent)) threads.get(parent)!.replies.push(c);
        else if (!parent) threads.set(id, { root: c, replies: [] });
    }
    const commentOf = (c: Json): PullRequestReviewComment => {
        const user = (c.user ?? {}) as Json;
        const login = str(user.login);
        return {
            id: num(c.id),
            author: login ? { login, name: null, isBot: str(user.type) === "Bot" || login.endsWith("[bot]") } : null,
            body: str(c.body),
            createdAt: str(c.created_at),
            url: str(c.html_url) || null,
        };
    };
    for (const [id, { root, replies }] of threads) {
        items.push({
            kind: "thread",
            id,
            path: str(root.path),
            line: typeof root.line === "number" ? root.line : null,
            side: str(root.side) === "LEFT" ? "LEFT" : "RIGHT",
            diffHunk: str(root.diff_hunk),
            comments: [root, ...replies].map(commentOf),
            createdAt: str(root.created_at),
        });
    }
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function pullRequestConversation(input: {
    readonly cwd: string;
    readonly number: number;
}): Promise<PullRequestTimelineItem[]> {
    const [view, lines] = await Promise.all([
        gh(["pr", "view", String(input.number), "--json", "comments,reviews"], { cwd: input.cwd }),
        gh(["api", `repos/{owner}/{repo}/pulls/${input.number}/comments`, "--paginate", "--slurp"], {
            cwd: input.cwd,
            timeoutMs: 60_000,
        }),
    ]);
    if (!view.ok) throw ghError(`Reading the conversation of #${input.number}`, view);
    // Line comments are a bonus over the conversation, not a reason to show none of it.
    const pages = lines.ok ? (JSON.parse(lines.stdout || "[]") as unknown[]) : [];
    const lineComments = pages.flatMap((page) => (Array.isArray(page) ? (page as Json[]) : []));
    return timelineOf(JSON.parse(view.stdout) as Json, lineComments);
}

/** `gh` arguments for an action. Exported for tests; `viewed` and branch deletion are separate calls. */
export function actionArgs(number: number, action: PullRequestAction): string[] {
    const n = String(number);
    switch (action.kind) {
        case "comment":
            return ["pr", "comment", n, "--body", action.body];
        case "review": {
            const flag =
                action.event === "approve" ? "--approve" : action.event === "request_changes" ? "--request-changes" : "--comment";
            return ["pr", "review", n, flag, ...(action.body.trim() ? ["--body", action.body] : [])];
        }
        case "reply":
            return [
                "api",
                "-X",
                "POST",
                `repos/{owner}/{repo}/pulls/${n}/comments/${action.commentId}/replies`,
                "-f",
                `body=${action.body}`,
            ];
        case "line_comment":
            return [
                "api",
                "-X",
                "POST",
                `repos/{owner}/{repo}/pulls/${n}/comments`,
                "-f",
                `body=${action.body}`,
                "-f",
                `commit_id=${action.commitId}`,
                "-f",
                `path=${action.path}`,
                "-F",
                `line=${action.line}`,
                "-f",
                `side=${action.side}`,
                ...(action.startLine !== undefined && action.startLine < action.line
                    ? ["-F", `start_line=${action.startLine}`, "-f", `start_side=${action.side}`]
                    : []),
            ];
        case "merge":
            // Never `--delete-branch`: gh would also delete the LOCAL branch and
            // switch the checkout away from it, in the user's own working copy.
            return ["pr", "merge", n, `--${action.method}`];
        case "close":
            return ["pr", "close", n];
        case "reopen":
            return ["pr", "reopen", n];
        case "ready":
            return ["pr", "ready", n];
        case "draft":
            return ["pr", "ready", n, "--undo"];
        case "viewed":
            return [
                "api",
                "graphql",
                "-f",
                `query=mutation($id: ID!, $path: String!) { ${action.viewed ? "markFileAsViewed" : "unmarkFileAsViewed"}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`,
                "-f",
                `id=${action.nodeId}`,
                "-f",
                `path=${action.path}`,
            ];
    }
}

const ACTION_LABEL: Record<PullRequestAction["kind"], string> = {
    comment: "Commenting",
    review: "Submitting the review",
    reply: "Replying",
    line_comment: "Commenting on the line",
    viewed: "Marking the file",
    merge: "Merging",
    close: "Closing",
    reopen: "Reopening",
    ready: "Marking ready for review",
    draft: "Converting to draft",
};

export async function runPullRequestAction(input: {
    readonly cwd: string;
    readonly number: number;
    readonly action: PullRequestAction;
}): Promise<{ readonly ok: true }> {
    const { action } = input;
    if ("body" in action && action.kind !== "review" && !action.body.trim()) {
        throw new Error("Write something first.");
    }
    let args = actionArgs(input.number, action);
    if (action.kind === "viewed") {
        // GraphQL goes to the PR's own host; look it up only for Enterprise remotes.
        const view = await gh(["pr", "view", String(input.number), "--json", "url"], { cwd: input.cwd });
        const host = view.ok ? repositoryOf(str((JSON.parse(view.stdout) as Json).url))?.host : undefined;
        if (host && host !== "github.com") args = [...args.slice(0, 2), ...hostArgs(host), ...args.slice(2)];
    }
    const result = await gh(args, { cwd: input.cwd, timeoutMs: 60_000 });
    if (!result.ok) throw ghError(`${ACTION_LABEL[action.kind]} on #${input.number}`, result);
    if (action.kind === "merge" && action.deleteBranch) {
        // The remote branch only, and only one that lives in this repository.
        const view = await gh(["pr", "view", String(input.number), "--json", "headRefName,isCrossRepository"], {
            cwd: input.cwd,
        });
        const head = view.ok ? (JSON.parse(view.stdout) as Json) : null;
        if (head && head.isCrossRepository !== true && str(head.headRefName)) {
            const deleted = await gh(
                ["api", "-X", "DELETE", `repos/{owner}/{repo}/git/refs/heads/${str(head.headRefName)}`],
                { cwd: input.cwd },
            );
            if (!deleted.ok) throw ghError(`Merged #${input.number}, but deleting its branch`, deleted);
        }
    }
    return { ok: true };
}

export async function pullRequestDiff(input: {
    readonly cwd: string;
    readonly number: number;
}): Promise<{ readonly patch: string; readonly truncated: boolean }> {
    const result = await gh(["pr", "diff", String(input.number), "--color", "never"], {
        cwd: input.cwd,
        timeoutMs: 60_000,
    });
    if (!result.ok) throw ghError(`Reading the diff of pull request #${input.number}`, result);
    const truncated = result.stdout.length > MAX_DIFF_BYTES;
    return { patch: truncated ? result.stdout.slice(0, MAX_DIFF_BYTES) : result.stdout, truncated };
}
