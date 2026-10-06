/**
 * Everything the workspace host answers.
 *
 * These are the capabilities the shell provides and loop's RPC does not — git,
 * terminals, the filesystem — and until now they ran in the main process,
 * beside loop's core. That was the problem: `uv_spawn` blocks the thread it is
 * called on, so a diff fanning out across a workspace, or a shell pumping a
 * build log, stalled the agent turn sharing that thread. None of these modules
 * imports `electron`, which is what makes moving them a relocation rather than
 * a rewrite.
 *
 * Split from `host.ts` for the same reason `coreDirect.ts` is split from
 * `coreHost.ts`: a table of functions can be driven by a test, a `parentPort`
 * cannot.
 *
 * **Each entry returns exactly what its `ipcMain` handler used to return**,
 * envelopes included. The renderer's contract is unchanged by this move, and
 * the surest way to keep it that way is for the values to be identical rather
 * than merely equivalent.
 */
import { discoverSourceControl } from "./discovery";
import { diffPreview as gitDiffPreview, init as gitInit, listRefs, status as gitStatus } from "./git";
import { conflictStages, fileAtRevision, discardChanges, stageContent, stageFiles, unstageFiles } from "./staging";
import {
    runStackedAction as gitRunStackedAction,
    type GitStackedAction,
    type GitStackedActionResult,
} from "./gitActions";
import { HOST_CALLBACKS, HOST_CHANNELS } from "./channels";
import { launch, revealCommand, whichCommands } from "./launcher";
import { cloneRepository, lookupRepository, publishRepository } from "./sourceControl";
import { TerminalManager, type PtySpawner } from "./terminals";
import {
    browseFilesystem,
    createDirectory,
    listWorkspaceEntries,
    readWorkspaceAsset,
    readWorkspaceFile,
    writeWorkspaceFile,
} from "./workspaceFiles";

export type HostHandler = (params: Record<string, unknown>) => unknown;

export interface HostServices {
    /** Emit to a renderer channel, via main. */
    readonly notify: (channel: string, payload: unknown) => void;
    /** Ask main for something only it has. See HOST_CALLBACKS. */
    readonly callback: (method: string, params: unknown) => Promise<unknown>;
    /**
     * Start a shell on a pseudo-terminal. Injected because the right PTY depends
     * on the runtime: node-pty under Electron's Node, loop's own openpty(3) under
     * Bun, where node-pty's callbacks never fire.
     */
    readonly spawnPty: PtySpawner;
}

/** Failure as a value, exactly as main's `ipcResult` did. */
async function envelope<T>(work: () => Promise<T>) {
    try {
        return { ok: true as const, value: await work() };
    } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
}

export interface HostTable {
    readonly handlers: Record<string, HostHandler>;
    /** Killed when the window goes away; see `closeAll`. */
    readonly terminals: TerminalManager;
}

export function createHostHandlers(services: HostServices): HostTable {
    const terminals = new TerminalManager(services.spawnPty);
    terminals.on("output", (event) => services.notify(HOST_CHANNELS.terminal, event));

    const handlers: Record<string, HostHandler> = {
        // ─── the filesystem ───────────────────────────────────────────────────
        "fs.list": (p) => listWorkspaceEntries(p["cwd"] as string),
        "fs.read": (p) => readWorkspaceFile(p["cwd"] as string, p["relativePath"] as string),
        "fs.write": (p) => writeWorkspaceFile(p["cwd"] as string, p["relativePath"] as string, p["contents"] as string),
        "fs.readAsset": (p) => readWorkspaceAsset(p["absolutePath"] as string),
        "fs.browse": (p) => browseFilesystem(p["partialPath"] as string, p["cwd"] as string | undefined),
        "fs.createDirectory": (p) => createDirectory(p["path"] as string),

        // ─── git, read-only ───────────────────────────────────────────────────
        "git.discover": () => discoverSourceControl(),
        "git.refs": (p) => listRefs(p["cwd"] as string),
        "git.status": (p) => gitStatus(p["cwd"] as string),
        "git.init": (p) => gitInit(p["cwd"] as string),
        /**
         * The index writes. Each returns the fresh status rather than nothing, so
         * the panel repaints from what git actually did instead of predicting it —
         * staging one file can change another's state (a rename is two paths), and
         * a guess that disagrees with the repository is worse than a round trip.
         */
        "git.stage": async (p) => {
            await stageFiles(p["cwd"] as string, p["paths"] as string[]);
            return gitStatus(p["cwd"] as string);
        },
        "git.unstage": async (p) => {
            await unstageFiles(p["cwd"] as string, p["paths"] as string[]);
            return gitStatus(p["cwd"] as string);
        },
        "git.discard": async (p) => {
            await discardChanges(p["cwd"] as string, {
                tracked: (p["tracked"] as string[] | undefined) ?? [],
                untracked: (p["untracked"] as string[] | undefined) ?? [],
            });
            return gitStatus(p["cwd"] as string);
        },
        /** Partial staging: the caller computed the content; see staging.ts. */
        "git.stageContent": async (p) => {
            await stageContent(p["cwd"] as string, p["path"] as string, p["content"] as string);
            return gitStatus(p["cwd"] as string);
        },
        "git.fileAtRevision": (p) =>
            fileAtRevision(p["cwd"] as string, p["revision"] as "HEAD" | "index", p["path"] as string),
        "git.conflictStages": (p) => conflictStages(p["cwd"] as string, p["path"] as string),
        "git.diffPreview": (p) =>
            gitDiffPreview(p["cwd"] as string, {
                ...(p["baseRef"] === undefined ? {} : { baseRef: p["baseRef"] as string }),
                ...(p["ignoreWhitespace"] === undefined ? {} : { ignoreWhitespace: p["ignoreWhitespace"] as boolean }),
                ...(p["contextLines"] === undefined ? {} : { contextLines: p["contextLines"] as number }),
            }),

        /**
         * Commit / push / open a PR.
         *
         * Progress goes out as a notification rather than in the reply, because the
         * point of it is to arrive *during* the action — a pre-commit hook running
         * a test suite has two minutes of output the toast should be showing.
         *
         * The commit message is the one thing here the host cannot produce: loop
         * owns the models and core lives in main, so it asks. A message it cannot
         * get back is handled by the runner's own fallback subject.
         */
        "git.runStackedAction": (
            p,
        ): Promise<{ ok: true; value: GitStackedActionResult } | { ok: false; error: string }> => {
            const stamp = { actionId: p["actionId"], cwd: p["cwd"], action: p["action"] };
            return envelope(() =>
                gitRunStackedAction(
                    p["cwd"] as string,
                    {
                        action: p["action"] as GitStackedAction,
                        commitMessage: p["commitMessage"] as string | undefined,
                        featureBranch: p["featureBranch"] as boolean | undefined,
                        filePaths: p["filePaths"] as string[] | undefined,
                    },
                    {
                        emit: (progress) => services.notify(HOST_CHANNELS.gitAction, { ...stamp, ...progress }),
                        generateMessage: async ({ diff, branch }) => {
                            const reply = (await services.callback(HOST_CALLBACKS.commitMessage, {
                                diff,
                                cwd: p["cwd"],
                                ...(branch ? { branch } : {}),
                            })) as { message?: unknown } | null;
                            return typeof reply?.message === "string" ? reply.message : "";
                        },
                    },
                ),
            );
        },

        // ─── GitHub, through the gh CLI ───────────────────────────────────────
        "sc.lookup": (p) => envelope(() => lookupRepository(p["repository"] as string)),
        "sc.clone": (p) => envelope(() => cloneRepository(p as unknown as Parameters<typeof cloneRepository>[0])),
        "sc.publish": (p) => envelope(() => publishRepository(p as unknown as Parameters<typeof publishRepository>[0])),

        // ─── launching an editor, or the OS file manager ──────────────────────
        "shell.which": (p) => whichCommands(p["commands"] as string[]),
        "shell.launch": async (p) => {
            // A null command means the OS file manager — the one "editor" that is not
            // a binary the user installed.
            const reveal = revealCommand();
            const requested = p["command"] as string | null;
            const command = requested ?? reveal.command;
            const args = requested ? (p["args"] as string[]) : [...reveal.args, p["target"] as string];
            try {
                await launch(command, args);
                return { ok: true as const };
            } catch (error) {
                return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
            }
        },

        // ─── PTYs ─────────────────────────────────────────────────────────────
        "pty.open": (p) => terminals.open(p as unknown as Parameters<TerminalManager["open"]>[0]),
        "pty.snapshot": (p) => terminals.snapshot(p["threadId"] as string, p["terminalId"] as string),
        "pty.list": () => terminals.list(),
        "pty.write": (p) => {
            terminals.write(p["threadId"] as string, p["terminalId"] as string, p["data"] as string);
        },
        "pty.resize": (p) => {
            terminals.resize(
                p["threadId"] as string,
                p["terminalId"] as string,
                p["cols"] as number,
                p["rows"] as number,
            );
        },
        "pty.clear": (p) => {
            terminals.clear(p["threadId"] as string, p["terminalId"] as string);
        },
        "pty.close": (p) => {
            terminals.close(p["threadId"] as string, p["terminalId"] as string | undefined);
        },
        /** The window went away; nothing should outlive it. */
        "pty.closeAll": () => {
            terminals.closeAll();
        },
    };

    return { handlers, terminals };
}
