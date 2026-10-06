/**
 * The seam between the shell's runner and the contract.
 *
 * `runStackedAction` in the renderer decodes each event the shell emits and
 * silently drops what it cannot decode, so a shape mismatch here would not fail
 * loudly — it would just make progress events vanish and leave the toast stuck.
 * That is exactly how `review.getDiffPreview` broke: a field the handler sent
 * one way and the contract expected another, with the mismatch swallowed.
 *
 * So this drives the *real* shell runner against a *real* repo and decodes its
 * *real* emissions with the *real* schema. The handler tests next door use
 * hand-written events, which cannot catch drift between the two sides.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { GitActionProgressEvent } from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runStackedAction } from "../../../../../packages/core/src/workspace/gitActions.ts";

const run = promisify(execFile);
const decode = Schema.decodeUnknownOption(GitActionProgressEvent);

const AUTHOR = {
  GIT_AUTHOR_NAME: "loop",
  GIT_AUTHOR_EMAIL: "loop@example.com",
  GIT_COMMITTER_NAME: "loop",
  GIT_COMMITTER_EMAIL: "loop@example.com",
};

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repoWithHook(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loop-seam-"));
  made.push(dir);
  await run("git", ["init", "--initial-branch=main"], { cwd: dir, env: { ...process.env, ...AUTHOR } });
  // The identity goes in the repo's own config, not just the env above: the
  // action under test spawns its own git and inherits none of it. A developer
  // machine has a global identity to fall back on and a fresh CI runner does
  // not, so without this the commit fails with "Author identity unknown" on
  // CI alone.
  await run("git", ["config", "user.name", AUTHOR.GIT_AUTHOR_NAME], { cwd: dir });
  await run("git", ["config", "user.email", AUTHOR.GIT_AUTHOR_EMAIL], { cwd: dir });
  // A hook that writes to both streams, so hook_output is exercised for real
  // rather than assumed.
  await run("git", ["config", "core.hooksPath", ".hooks"], { cwd: dir });
  await mkdir(join(dir, ".hooks"), { recursive: true });
  const hook = join(dir, ".hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\necho 'checking files'\necho 'a warning' >&2\nexit 0\n");
  await chmod(hook, 0o755);
  await writeFile(join(dir, "a.md"), "hello\n");
  return dir;
}

describe("shell progress against the contract", () => {
  it("emits only events the contract can decode", async () => {
    const cwd = await repoWithHook();
    // Exactly the stamping `main.ts` does on the way to the renderer.
    const stamp = { actionId: "act-1", cwd, action: "commit" as const };
    const raw: unknown[] = [];

    const result = await runStackedAction(
      cwd,
      { action: "commit" },
      {
        emit: (progress) => void raw.push({ ...stamp, ...progress }),
        generateMessage: () => Promise.resolve("Add a.md"),
      },
    );

    expect(result.commit.status).toBe("created");
    expect(raw.length).toBeGreaterThan(0);

    const undecodable = raw.filter((event) => Option.isNone(decode(event)));
    expect(undecodable).toEqual([]);

    // And the kinds the UI keys off actually showed up.
    const kinds = new Set(raw.map((e) => (e as { kind: string }).kind));
    expect(kinds).toContain("action_started");
    expect(kinds).toContain("phase_started");
    expect(kinds).toContain("hook_started");
    expect(kinds).toContain("hook_output");
    expect(kinds).toContain("hook_finished");
  });

  it("produces a result the contract accepts, toast included", async () => {
    const cwd = await repoWithHook();
    const { runStackedAction: handler } = await import("./git.ts");
    const globals = globalThis as { window?: Window & typeof globalThis };
    const hadWindow = globals.window !== undefined;
    globals.window ??= globals as unknown as Window & typeof globalThis;
    const previous = window.loop;

    // The full path: the handler's stream, fed by the real shell runner.
    let listener: ((event: never) => void) | null = null;
    window.loop = {
      call: () => Promise.reject(new Error("not used")),
      onEvent: () => () => {},
      anchorCwd: () => Promise.resolve(undefined),
      git: {
        refs: () =>
          Promise.resolve({ refs: [], isRepo: true, hasPrimaryRemote: false, totalCount: 0 }),
        status: () => Promise.reject(new Error("not used")),
        runStackedAction: async (input) => {
          try {
            const value = await runStackedAction(
              input.cwd,
              { action: input.action, commitMessage: input.commitMessage },
              {
                emit: (progress) =>
                  (listener as ((e: unknown) => void) | null)?.({
                    actionId: input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    ...progress,
                  }),
              },
            );
            return { ok: true as const, value };
          } catch (error) {
            return { ok: false as const, error: (error as Error).message };
          }
        },
        onActionProgress: (fn) => {
          listener = fn as never;
          return () => {
            listener = null;
          };
        },
      },
    };

    try {
      const Stream = await import("effect/Stream");
      const events = await Effect.runPromise(
        Stream.runCollect(
          handler({ actionId: "act-2", cwd, action: "commit", commitMessage: "Add a.md" }),
        ),
      );
      const finished = [...events].at(-1);
      if (finished?.kind !== "action_finished") throw new Error(`got ${finished?.kind}`);
      expect(finished.result.commit.subject).toBe("Add a.md");
      expect(finished.result.toast.title).toBe("Committed");
    } finally {
      if (previous === undefined) delete window.loop;
      else window.loop = previous;
      if (!hadWindow) delete globals.window;
    }
  });
});
