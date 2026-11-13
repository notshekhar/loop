/**
 * cmux session restore — after cmux restarts (a quit, an update, a reboot) a
 * pane that was running loop comes back running `loop --session <id>`, the
 * way a Claude Code pane comes back running `claude --resume`.
 *
 * Two frames on cmux's socket, both what cmux's own agent hooks send:
 *
 *   - `surface.resume.set` (V2) — the command that restores this pane, with
 *     `auto_resume` so cmux re-runs it without asking. Rewritten whenever the
 *     live session changes (/new, /resume, a fork).
 *   - `set_agent_pid loop.<session> <pid>` (V1) — proof the session is still
 *     running in this pane. Without it cmux's process scan, which only knows
 *     agents by their hook files or a session id in argv, sees a fresh `loop`
 *     as gone and demotes the binding to manual within seconds.
 *
 * A clean exit (/exit, ctrl+d) clears the binding: that session is finished.
 * A killed loop (cmux quitting sends SIGHUP) never gets here, so its binding
 * survives — which is the whole point.
 */

/** cmux's name for what loop is, in the binding and the PID key. */
const KIND = "loop";

/** Flags worth keeping on restore: they decide WHICH agent comes back.
 * Prompts, session selectors and anything secret-shaped are dropped — a
 * restore must resume the session, not start a task. */
const KEEP_WITH_VALUE = new Set(["--model", "--provider", "--cwd"]);

/** The two wires the reporter already owns, so this file never opens a socket. */
export interface CmuxSocketWriter {
    /** One V1 command line, e.g. `set_agent_pid …`. */
    command(line: string): void;
    /** One V2 JSON-RPC request, e.g. `surface.resume.set`. */
    request(method: string, params: Record<string, unknown>): void;
}

/** How this process was started — the seam tests replace. */
export interface LoopLaunch {
    execPath: string;
    /** process.argv: [runtime, entry?, ...args]. */
    argv: string[];
    /** Bun.main — the entry script when running from source. */
    main?: string;
    pid: number;
}

export interface CmuxResumeOptions {
    writer: CmuxSocketWriter;
    workspaceId?: string;
    surfaceId: string;
    /** The live session id, read at sync time. */
    sessionId: () => string | undefined;
    cwd: () => string;
    launch?: LoopLaunch;
}

export interface CmuxResume {
    /** Point cmux at the live session, if it changed since the last call. */
    sync(): void;
    /** Clean exit: this session is not coming back. */
    end(): void;
}

function currentLaunch(): LoopLaunch {
    return { execPath: process.execPath, argv: process.argv, main: Bun.main, pid: process.pid };
}

/** The argv that brings session `id` back with the same model and provider. */
export function resumeArgv(id: string, launch: LoopLaunch): string[] | null {
    const kept = keptFlags(launch.argv.slice(1));
    // Under `bun <entry>` the entry script has to lead; inside a compiled
    // binary it must NOT (its entry is a virtual bunfs path that reads as a
    // command word) — the same split the gateway daemons make.
    const underBun = /^bun/i.test(launch.execPath.split("/").pop() ?? "");
    if (!underBun) return [launch.execPath, "--session", id, ...kept];
    const entry = launch.main ?? launch.argv[1];
    return entry ? [launch.execPath, entry, "--session", id, ...kept] : null;
}

function keptFlags(args: string[]): string[] {
    const kept: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (KEEP_WITH_VALUE.has(arg) && i + 1 < args.length) {
            kept.push(arg, args[++i]);
        } else if ([...KEEP_WITH_VALUE].some((flag) => arg.startsWith(`${flag}=`))) {
            kept.push(arg);
        }
    }
    return kept;
}

/** cmux runs the binding's command through the pane's shell. */
export function shellCommand(argv: string[]): string {
    return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

export function attachCmuxResume(opts: CmuxResumeOptions): CmuxResume {
    const launch = opts.launch ?? currentLaunch();
    const pane = opts.workspaceId ? { workspace_id: opts.workspaceId, surface_id: opts.surfaceId } : { surface_id: opts.surfaceId };
    const paneFlags = `--tab=${opts.workspaceId ?? ""} --panel=${opts.surfaceId}`;
    let bound: string | undefined;

    function bind(id: string): void {
        const argv = resumeArgv(id, launch);
        if (!argv) return;
        opts.writer.request("surface.resume.set", {
            ...pane,
            name: KIND,
            kind: KIND,
            checkpoint_id: id,
            source: "agent-hook",
            command: shellCommand(argv),
            cwd: opts.cwd(),
            auto_resume: true,
        });
        opts.writer.command(`set_agent_pid ${KIND}.${id} ${launch.pid} ${paneFlags}`);
    }

    return {
        sync() {
            const id = opts.sessionId();
            if (!id || id === bound) return;
            bound = id;
            bind(id);
        },
        end() {
            if (!bound) return;
            opts.writer.request("surface.resume.clear", {
                surface_id: opts.surfaceId,
                source: "agent-hook",
                checkpoint_id: bound,
                agent_session_ended: true,
            });
            bound = undefined;
        },
    };
}
