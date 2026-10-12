/**
 * Pull requests of a project's GitHub repository, read through the `gh` CLI.
 *
 * `gh` already holds the user's login and speaks GitHub's API, and loop uses
 * it for publishing and for opening PRs — so reading PRs needs no token, no
 * API client and no cache of our own: one `gh pr …` per request, run in the
 * project's folder so `gh` resolves the repository from its remote.
 *
 * Read-only for now: the list, one PR in detail, and its diff. Everything is
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
}

const SUMMARY_FIELDS =
    "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,reviewDecision,additions,deletions,changedFiles,url,labels,statusCheckRollup";
const DETAIL_FIELDS = `${SUMMARY_FIELDS},body,mergedAt,closedAt,mergeable,files,commits,comments,reviews,reviewRequests`;

/** A diff above this is cut: a phone has no use for a 20 MB patch. */
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
              .map((f) => ({ path: str(f.path), additions: num(f.additions), deletions: num(f.deletions) }))
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
        commitCount: Array.isArray(raw.commits) ? raw.commits.length : 0,
        commentCount: Array.isArray(raw.comments) ? raw.comments.length : 0,
        reviewers: [...latest].map(([login, state]) => ({ login, state })),
    };
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
    return detailOf(JSON.parse(result.stdout) as Json);
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
