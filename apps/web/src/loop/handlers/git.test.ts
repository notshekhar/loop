import { SourceControlDiscoveryResult } from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  diffPreview,
  discoverSourceControl,
  initRepo,
  listRefs,
  refreshStatus,
  runStackedAction,
  statusStream,
} from "./git.ts";
import type {
  GitActionProgressMessage,
  GitDiscovery,
  GitRef,
  GitStatus,
  GitStackedActionOutcome,
  LoopGitBridge,
} from "../transport.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

const ref = (name: string, over: Partial<GitRef> = {}): GitRef => ({
  name,
  isRemote: false,
  current: false,
  isDefault: false,
  worktreePath: null,
  ...over,
});

const status: GitStatus = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "desktop-app",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "src/a.ts", insertions: 3, deletions: 1 }],
    insertions: 3,
    deletions: 1,
  },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
};

function withGit<T>(bridge: LoopGitBridge | undefined, run: () => Promise<T>): Promise<T> {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: () => Promise.reject(new Error("not used")),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
    ...(bridge === undefined ? {} : { git: bridge }),
  };
  return run().finally(() => {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  });
}

const bridge = (refs: readonly GitRef[]): LoopGitBridge => ({
  refs: () =>
    Promise.resolve({ refs, isRepo: true, hasPrimaryRemote: true, totalCount: refs.length }),
  status: () => Promise.resolve(status),
});

describe("git", () => {
  it("puts the current branch first, then the default", async () => {
    // Otherwise the two branches anyone actually wants are buried in a list
    // that is alphabetical and often long.
    const result = await withGit(
      bridge([
        ref("zeta"),
        ref("main", { isDefault: true }),
        ref("alpha"),
        ref("desktop-app", { current: true }),
      ]),
      () => Effect.runPromise(listRefs({ cwd: "/w" })),
    );
    expect(result.refs.map((r) => r.name)).toEqual(["desktop-app", "main", "alpha", "zeta"]);
  });

  it("filters by kind and query", async () => {
    const refs = [ref("main"), ref("origin/main", { isRemote: true, remoteName: "origin" })];
    const remote = await withGit(bridge(refs), () =>
      Effect.runPromise(listRefs({ cwd: "/w", refKind: "remote" })),
    );
    expect(remote.refs.map((r) => r.name)).toEqual(["origin/main"]);

    const queried = await withGit(bridge([...refs, ref("feature/login")]), () =>
      Effect.runPromise(listRefs({ cwd: "/w", query: "LOG" })),
    );
    expect(queried.refs.map((r) => r.name)).toEqual(["feature/login"]);
  });

  it("reports 'not a repo' in a browser rather than failing", async () => {
    // The UI polls listRefs unprompted, so failing here is a retry storm the
    // user can see and cannot act on.
    const result = await withGit(undefined, () => Effect.runPromise(listRefs({ cwd: "/w" })));
    expect(result.isRepo).toBe(false);
    expect(result.refs).toEqual([]);
  });

  it("carries the working tree through to the status panel", async () => {
    const result = await withGit(bridge([]), () =>
      Effect.runPromise(refreshStatus({ cwd: "/w" })),
    );
    expect(result.refName).toBe("desktop-app");
    expect(result.hasWorkingTreeChanges).toBe(true);
    expect(result.workingTree.files[0]?.path).toBe("src/a.ts");
    expect(result.pr).toBeNull();
  });
});

describe("the review pane's diff", () => {
  const source = {
    id: "working-tree",
    kind: "working-tree" as const,
    title: "Working tree",
    baseRef: "HEAD",
    headRef: null,
    diff: "diff --git a/a.ts b/a.ts\n",
    diffHash: "9f2c",
    truncated: false,
  };
  const previewing = (sources: readonly (typeof source)[]): LoopGitBridge => ({
    ...bridge([]),
    diffPreview: () => Promise.resolve({ isRepo: sources.length > 0, sources }),
  });

  it("decodes what the shell actually returns", async () => {
    // Regression: `generatedAt` was typed as a live `DateTime.Utc` while the
    // handler sends an ISO string, so every decode failed and the pane showed
    // "git returned an unexpected diff preview" instead of any diff at all.
    const result = await withGit(previewing([source]), () =>
      Effect.runPromise(diffPreview({ cwd: "/w" })),
    );
    expect(result.sources.map((s) => s.id)).toEqual(["working-tree"]);
    expect(result.sources[0]?.diff).toBe(source.diff);
    expect(result.cwd).toBe("/w");
  });

  it("treats a folder that is not a repo as an empty diff, not an error", async () => {
    const result = await withGit(previewing([]), () =>
      Effect.runPromise(diffPreview({ cwd: "/w" })),
    );
    expect(result.sources).toEqual([]);
  });

  it("says the surface cannot do it when the shell has no bridge", async () => {
    const failure = await withGit(bridge([]), () =>
      Effect.runPromise(Effect.flip(diffPreview({ cwd: "/w" }))),
    );
    expect(failure.detail).toContain("desktop app");
  });
});

describe("committing, pushing and opening a PR", () => {
  const outcome = (over: Partial<GitStackedActionOutcome> = {}): GitStackedActionOutcome => ({
    action: "commit",
    branch: { status: "skipped_not_requested" },
    commit: { status: "created", subject: "Add a.txt", commitSha: "a".repeat(40) },
    push: { status: "skipped_not_requested" },
    pr: { status: "skipped_not_requested" },
    ...over,
  });

  /**
   * A shell that replays `progress` before answering with `reply`. The listener
   * is captured so the events land exactly where a real shell's would: after
   * the call has started, before it resolves.
   */
  const acting = (options: {
    progress?: readonly GitActionProgressMessage[];
    reply?: { ok: true; value: GitStackedActionOutcome } | { ok: false; error: string };
    omitBridge?: boolean;
  }): LoopGitBridge => {
    let listener: ((event: GitActionProgressMessage) => void) | null = null;
    return {
      ...bridge([]),
      ...(options.omitBridge
        ? {}
        : {
            runStackedAction: async () => {
              for (const event of options.progress ?? []) listener?.(event);
              return options.reply ?? { ok: true as const, value: outcome() };
            },
          }),
      onActionProgress: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    };
  };

  const collect = (git: LoopGitBridge, input: Parameters<typeof runStackedAction>[0]) =>
    withGit(git, () => Effect.runPromise(Stream.runCollect(runStackedAction(input))));

  const input = { actionId: "act-1", cwd: "/w", action: "commit" as const };

  it("republishes the shell's progress and ends with the result", async () => {
    const events = await collect(
      acting({
        progress: [
          { ...input, kind: "action_started", phases: ["commit"] },
          { ...input, kind: "phase_started", phase: "commit", label: "Committing..." },
        ],
      }),
      input,
    );

    const kinds = [...events].map((e) => e.kind);
    expect(kinds).toEqual(["action_started", "phase_started", "action_finished"]);
    const finished = [...events].at(-1);
    if (finished?.kind !== "action_finished") throw new Error("expected action_finished");
    expect(finished.result.commit.subject).toBe("Add a.txt");
    // The toast is what the UI actually renders, so it has to be built.
    expect(finished.result.toast.title).toBe("Committed");
  });

  it("reports git's own message when the action fails", async () => {
    // A failing pre-commit hook must read as "lint failed", not as an IPC error.
    const events = await collect(
      acting({ reply: { ok: false, error: "git commit failed: lint failed on a.txt" } }),
      input,
    );

    const failed = [...events].at(-1);
    if (failed?.kind !== "action_failed") throw new Error("expected action_failed");
    expect(failed.message).toContain("lint failed on a.txt");
  });

  it("ignores progress belonging to a different action", async () => {
    // Two commits in flight must not paint into each other's toast.
    const events = await collect(
      acting({
        progress: [
          { ...input, actionId: "someone-else", kind: "phase_started", phase: "commit", label: "Nope" },
          { ...input, kind: "phase_started", phase: "commit", label: "Committing..." },
        ],
      }),
      input,
    );

    const labels = [...events].flatMap((e) => (e.kind === "phase_started" ? [e.label] : []));
    expect(labels).toEqual(["Committing..."]);
  });

  it("describes a push in the toast when that is what happened", async () => {
    const events = await collect(
      acting({
        reply: {
          ok: true,
          value: outcome({
            action: "commit_push",
            push: { status: "pushed", branch: "feature", upstreamBranch: "origin/feature" },
          }),
        },
      }),
      { ...input, action: "commit_push" },
    );

    const finished = [...events].at(-1);
    if (finished?.kind !== "action_finished") throw new Error("expected action_finished");
    expect(finished.result.toast.description).toContain("origin/feature");
  });

  it("offers a link to the pull request it opened", async () => {
    const events = await collect(
      acting({
        reply: {
          ok: true,
          value: outcome({
            action: "commit_push_pr",
            pr: { status: "created", url: "https://github.com/o/r/pull/7", number: 7, title: "Add a.txt" },
          }),
        },
      }),
      { ...input, action: "commit_push_pr" },
    );

    const finished = [...events].at(-1);
    if (finished?.kind !== "action_finished") throw new Error("expected action_finished");
    expect(finished.result.toast.cta).toEqual({
      kind: "open_pr",
      label: "View pull request",
      url: "https://github.com/o/r/pull/7",
    });
  });

  it("says a clean tree had nothing to commit", async () => {
    const events = await collect(
      acting({ reply: { ok: true, value: outcome({ commit: { status: "skipped_no_changes" } }) } }),
      input,
    );

    const finished = [...events].at(-1);
    if (finished?.kind !== "action_finished") throw new Error("expected action_finished");
    expect(finished.result.toast.title).toBe("Nothing to commit");
  });

  it("says the surface cannot do it when the shell has no bridge", async () => {
    const failure = await withGit(acting({ omitBridge: true }), () =>
      Effect.runPromise(Effect.flip(Stream.runCollect(runStackedAction(input)))),
    );
    expect(failure.detail).toContain("desktop app");
  });
});

describe("scanning the server environment", () => {
  const scan: GitDiscovery = {
    versionControlSystems: [
      {
        kind: "git",
        implemented: true,
        label: "Git",
        executable: "git",
        status: "available",
        version: "2.54.0",
        installHint: "Install Git",
        detail: null,
      },
    ],
    sourceControlProviders: [
      {
        kind: "github",
        label: "GitHub",
        executable: "gh",
        status: "available",
        version: "2.95.0",
        installHint: "brew install gh",
        detail: null,
        auth: {
          status: "authenticated",
          account: "notshekhar",
          host: "github.com",
          detail: null,
        },
      },
    ],
  };

  it("lifts the shell's nulls into the contract's Options", async () => {
    // The shell speaks plain JSON over IPC; the contract wants Option. Getting
    // this wrong is invisible until the panel renders nothing.
    const result = await withGit({ ...bridge([]), discover: () => Promise.resolve(scan) }, () =>
      Effect.runPromise(discoverSourceControl()),
    );

    const git = result.versionControlSystems[0];
    expect(Option.getOrNull(git!.version)).toBe("2.54.0");
    expect(Option.isNone(git!.detail)).toBe(true);

    const github = result.sourceControlProviders[0];
    expect(github!.auth.status).toBe("authenticated");
    expect(Option.getOrNull(github!.auth.account)).toBe("notshekhar");
    expect(Option.getOrNull(github!.auth.host)).toBe("github.com");
  });

  it("produces something the contract accepts", async () => {
    // Encoding is the check that matters: this handler builds its value rather
    // than decoding one, so nothing else validates the shape.
    const result = await withGit({ ...bridge([]), discover: () => Promise.resolve(scan) }, () =>
      Effect.runPromise(discoverSourceControl()),
    );
    const encoded = await Effect.runPromise(
      Schema.encodeUnknownEffect(SourceControlDiscoveryResult)(result),
    );
    expect(encoded).toBeDefined();
  });

  it("reports an empty environment in a browser instead of failing", async () => {
    // The panel then says "Nothing detected yet", which is true, rather than
    // showing an error the user cannot act on.
    const result = await withGit(bridge([]), () => Effect.runPromise(discoverSourceControl()));

    expect(result.versionControlSystems).toEqual([]);
    expect(result.sourceControlProviders).toEqual([]);
  });
});

describe("initializing a repository", () => {
  it("initializes the folder the caller asked about", async () => {
    const seen: string[] = [];
    await withGit(
      { ...bridge([]), init: (cwd) => { seen.push(cwd); return Promise.resolve(); } },
      () => Effect.runPromise(initRepo({ cwd: "/w/fresh" })),
    );
    expect(seen).toEqual(["/w/fresh"]);
  });

  it("says the surface cannot do it rather than failing as unsupported", async () => {
    // A browser has no filesystem, and an older shell has no `init` on its
    // bridge — both used to surface as the raw "vcs.init is not supported".
    const failure = await withGit(bridge([]), () =>
      Effect.runPromise(Effect.flip(initRepo({ cwd: "/w/fresh" }))),
    );
    expect(failure.detail).toContain("desktop app");
  });

  it("reports git's own message when init fails", async () => {
    // The exec error's message is just an exit code; git puts the useful part
    // ("permission denied") on stderr, and that is what the button must show.
    const failure = await withGit(
      { ...bridge([]), init: () => Promise.reject(new Error("permission denied")) },
      () => Effect.runPromise(Effect.flip(initRepo({ cwd: "/w/fresh" }))),
    );
    expect(failure.detail).toBe("permission denied");
  });
});

describe("status without polling", () => {
  it("re-reads git when the host says the repository changed, not on a timer", async () => {
    let reads = 0;
    let changed: ((event: { cwd: string }) => void) | undefined;
    const watches: string[] = [];
    const unwatched: string[] = [];
    const watching: LoopGitBridge = {
      refs: () => Promise.resolve({ refs: [], isRepo: true, hasPrimaryRemote: true, totalCount: 0 }),
      status: () => {
        reads += 1;
        return Promise.resolve({ ...status, refName: `branch-${reads}` });
      },
      watch: (cwd, id) => {
        watches.push(`${cwd}:${id}`);
        return Promise.resolve({ native: true });
      },
      unwatch: (id) => {
        unwatched.push(id);
        return Promise.resolve();
      },
      onChanged: (listener) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    };
    const host = { git: () => watching } as unknown as Parameters<typeof statusStream>[1];
    const seen: Array<string | null> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(statusStream("/w", host), (event) =>
        Effect.sync(() => {
          if (event._tag === "snapshot") seen.push(event.local.refName);
        }),
      ),
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    expect(reads).toBe(1);
    expect(watches).toHaveLength(1);

    // Nothing changed: no re-read, however long it sits (the safety poll is a minute).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reads).toBe(1);

    changed?.({ cwd: "/elsewhere" });
    await settle();
    expect(reads).toBe(1);

    changed?.({ cwd: "/w" });
    await settle();
    expect(reads).toBe(2);
    expect(seen).toEqual(["branch-1", "branch-2"]);

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(unwatched).toHaveLength(1);
    expect(changed).toBeUndefined();
  });
});
