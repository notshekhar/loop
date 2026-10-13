/**
 * The Pull requests page: a project's PRs on the left — filtered by state and
 * by who they involve, searchable — and the selected one on the right.
 *
 * Everything goes through `gh` on the machine that holds the project, so a
 * project on a remote host lists that host's view of GitHub. When `gh` is not
 * signed in, the page offers to sign it in rather than showing the error.
 */
import type {
  LoopPullRequestDetail,
  LoopPullRequestInvolvement,
  LoopPullRequestListState,
  LoopPullRequestSummary,
} from "@loop/contracts";
import { scopeProjectRef } from "@loop/runtime/environment";
import { useRouter } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  GitPullRequestIcon,
  LogInIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { GithubSignInDialog } from "./GithubSignInDialog";
import { PullRequestDetail, type PullRequestTab } from "./PullRequestDetail";
import {
  checksTone,
  isGhMissingError,
  isGithubAuthError,
  matchesPullRequestQuery,
  reviewLabel,
  reviewPrompt,
  shortAge,
  stateTone,
} from "./pullRequestPresentation";
import { usePullRequestList, type PullRequestScope } from "./usePullRequests";

const STATES: ReadonlyArray<{ value: LoopPullRequestListState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
const INVOLVEMENT: ReadonlyArray<{ value: LoopPullRequestInvolvement; label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "authored", label: "Mine" },
  { value: "reviewing", label: "To review" },
];

const LAST_PROJECT_KEY = "loop:pull-requests:project";

function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function writeLastProject(key: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, key);
  } catch {
    // A remembered project is a convenience; without storage the first one opens.
  }
}

function Segmented<T extends string>(props: {
  readonly options: ReadonlyArray<{ value: T; label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => props.onChange(option.value)}
          className={cn(
            "flex-1 cursor-pointer rounded-md px-2 py-0.5 text-xs",
            props.value === option.value
              ? "bg-background font-medium text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Row(props: {
  readonly pr: LoopPullRequestSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { pr } = props;
  const state = stateTone(pr);
  const checks = checksTone(pr.checks);
  const review = reviewLabel(pr.reviewDecision);
  return (
    <button
      type="button"
      onClick={props.onSelect}
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer gap-2.5 rounded-lg px-2.5 py-2 text-left",
        props.selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", state.dotClass)} />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="line-clamp-2 text-sm leading-snug font-medium text-foreground">{pr.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          #{pr.number} · {pr.author?.login ?? "someone"} · {shortAge(pr.updatedAt)}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 text-[11px]">
          <span className={state.textClass}>{state.label}</span>
          {checks ? (
            <span className={cn("inline-flex items-center gap-1", checks.textClass)}>
              <span className={cn("size-1.5 rounded-full", checks.dotClass)} />
              {checks.label.replace("Checks ", "")}
            </span>
          ) : null}
          {review ? <span className="text-muted-foreground">{review}</span> : null}
          <span className="tabular-nums">
            <span className="text-success-foreground">+{pr.additions}</span>{" "}
            <span className="text-destructive-foreground">−{pr.deletions}</span>
          </span>
        </span>
      </span>
    </button>
  );
}

export function PullRequestsPage() {
  const projects = useProjects();
  const router = useRouter();
  const newThread = useNewThreadHandler();
  const [projectKey, setProjectKey] = useState<string | null>(readLastProject);
  const [state, setState] = useState<LoopPullRequestListState>("open");
  const [involvement, setInvolvement] = useState<LoopPullRequestInvolvement>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<PullRequestTab>("overview");
  const [signInOpen, setSignInOpen] = useState(false);

  const keyOf = (p: { environmentId: string; id: string }) => `${p.environmentId}:${p.id}`;
  const project = useMemo(
    () => projects.find((p) => keyOf(p) === projectKey) ?? projects[0] ?? null,
    [projectKey, projects],
  );
  const scope = useMemo<PullRequestScope | null>(
    () => (project ? { environmentId: project.environmentId, cwd: project.workspaceRoot } : null),
    [project],
  );
  const list = usePullRequestList(scope, { state, involvement });
  const rows = useMemo(
    () => (list.data ?? []).filter((pr) => matchesPullRequestQuery(pr, query)),
    [list.data, query],
  );

  // Another project or filter starts with nothing selected.
  useEffect(() => setSelected(null), [project?.id, state, involvement]);

  const chooseProject = useCallback((key: string) => {
    setProjectKey(key);
    writeLastProject(key);
  }, []);

  const reviewWithLoop = useCallback(
    async (pr: LoopPullRequestDetail) => {
      if (!project) return;
      await newThread(scopeProjectRef(project.environmentId, project.id));
      const match = /\/draft\/([^/?#]+)/.exec(router.state.location.pathname);
      if (!match?.[1]) return;
      const draftId = decodeURIComponent(match[1]) as DraftId;
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(draftId)?.prompt.trim() ?? "";
      // Never overwrite something the user was already writing in that draft.
      store.setPrompt(draftId, existing ? `${existing}\n\n${reviewPrompt(pr)}` : reviewPrompt(pr));
    },
    [newThread, project, router],
  );

  if (projects.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <GitPullRequestIcon className="size-6" />
        Add a project to see its pull requests.
      </div>
    );
  }

  const authProblem = isGithubAuthError(list.error);
  const ghMissing = isGhMissingError(list.error);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border/70">
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-1.5">
            <Menu>
              <MenuTrigger
                render={
                  <Button variant="outline" size="sm" className="min-w-0 flex-1 justify-between" />
                }
              >
                <span className="truncate">{project?.title ?? "Choose a project"}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
              </MenuTrigger>
              <MenuPopup align="start" className="max-h-80 min-w-64 overflow-y-auto">
                <MenuRadioGroup value={project ? keyOf(project) : ""} onValueChange={(v) => chooseProject(String(v))}>
                  {projects.map((p) => (
                    <MenuRadioItem key={keyOf(p)} value={keyOf(p)}>
                      <span className="truncate">{p.title}</span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh"
              onClick={list.refresh}
              disabled={list.isPending}
            >
              <RefreshCwIcon className={cn(list.isPending && "animate-spin")} />
            </Button>
          </div>
          <Segmented options={STATES} value={state} onChange={setState} />
          <Segmented options={INVOLVEMENT} value={involvement} onChange={setInvolvement} />
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder="Search title, #number, author, branch"
              className="pl-7"
              size="sm"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {list.error ? (
            <div className="space-y-3 px-2 pt-4 text-sm">
              {authProblem ? (
                <>
                  <p className="text-foreground">GitHub isn't signed in on this machine.</p>
                  <Button size="sm" onClick={() => setSignInOpen(true)}>
                    <LogInIcon /> Sign in to GitHub
                  </Button>
                </>
              ) : ghMissing ? (
                <p className="text-muted-foreground">
                  Pull requests need the GitHub CLI. Install it (
                  <code className="font-mono text-xs">brew install gh</code>), then come back.
                </p>
              ) : (
                <>
                  <p className="text-destructive-foreground">{list.error}</p>
                  <Button size="sm" variant="outline" onClick={list.refresh}>
                    Try again
                  </Button>
                </>
              )}
            </div>
          ) : !list.data ? (
            <p className="flex items-center gap-2 px-2 pt-4 text-sm text-muted-foreground">
              <Spinner className="size-3.5" /> Loading pull requests…
            </p>
          ) : rows.length === 0 ? (
            <p className="px-2 pt-4 text-sm text-muted-foreground">
              {query
                ? "Nothing matches that search."
                : involvement === "reviewing"
                  ? "Nothing is waiting on your review."
                  : involvement === "authored"
                    ? "You have no pull requests here."
                    : `No ${state === "all" ? "" : `${state} `}pull requests.`}
            </p>
          ) : (
            <div className="space-y-0.5">
              {rows.map((pr) => (
                <Row
                  key={pr.number}
                  pr={pr}
                  selected={pr.number === selected}
                  onSelect={() => setSelected(pr.number)}
                />
              ))}
            </div>
          )}
        </div>
      </aside>

      {scope && project && selected !== null ? (
        <PullRequestDetail
          key={`${keyOf(project)}:${selected}`}
          scope={scope}
          number={selected}
          tab={tab}
          onTabChange={setTab}
          onChanged={list.refresh}
          onReviewWithLoop={(pr) => void reviewWithLoop(pr)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <GitPullRequestIcon className="size-6 opacity-60" />
          Pick a pull request.
        </div>
      )}

      {project ? (
        <GithubSignInDialog
          open={signInOpen}
          environmentId={project.environmentId}
          onOpenChange={setSignInOpen}
          onSignedIn={list.refresh}
        />
      ) : null}
    </div>
  );
}
