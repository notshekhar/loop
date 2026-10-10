/**
 * The workspace — files, git, terminals, source-control hosts — over serve's
 * WebSocket, so the browser gets what the desktop app gets.
 *
 * It is the SAME handler table the desktop's utility process hosts
 * (`../workspace`), carried differently: a client calls `workspace.<name>`
 * (`workspace.fs.list`, `workspace.git.status`, …) as an ordinary JSON-RPC
 * request, and what the host emits on its own (terminal output, git action
 * progress) arrives as a `workspace.event { channel, payload }` notification —
 * the channel names are the desktop's, so the renderer handles both shells
 * with one code path.
 */
import { createHostHandlers, HOST_CALLBACKS, type HostTable, type PtyProcess, type PtySpawner } from "../workspace";
import { spawnPty } from "../terminal/pty";
import type { RpcServer } from "./server";

export const WORKSPACE_PREFIX = "workspace.";
export const WORKSPACE_EVENT = "workspace.event";

/** loop's own openpty(3) PTY: under Bun, node-pty spawns but never calls back. */
const spawnBunPty: PtySpawner = (input): PtyProcess => {
    const pty = spawnPty({
        cmd: input.shell,
        args: [...input.args],
        cwd: input.cwd,
        env: input.env,
        rows: input.rows,
        cols: input.cols,
    });
    return {
        pid: pty.pid,
        onData: (listener) => pty.onData(listener),
        onExit: (listener) => pty.onExit((exitCode) => listener({ exitCode })),
        write: (data) => pty.write(data),
        // The workspace speaks cols×rows, loop's pty rows×cols.
        resize: (cols, rows) => pty.resize(rows, cols),
        kill: () => pty.kill(),
    };
};

export interface ServeWorkspace {
    /**
     * Answer one `workspace.*` request. `canUseTerminal` is false for a client
     * the terminal is not offered to (see startWebServer); its `pty.*` calls
     * are refused rather than ignored.
     */
    call(method: string, params: Record<string, unknown>, canUseTerminal: boolean): Promise<unknown>;
    /** Kill every shell the workspace started. */
    dispose(): void;
}

export function createServeWorkspace(
    rpc: RpcServer,
    notify: (channel: string, payload: unknown) => void,
): ServeWorkspace {
    const table: HostTable = createHostHandlers({
        notify,
        // The one thing the handlers ask their host for. The desktop's main
        // answers it from core over RPC; here core is in-process.
        callback: (method, params) => {
            if (method === HOST_CALLBACKS.commitMessage) {
                return rpc.call("git.commitMessage", (params ?? {}) as Record<string, unknown>);
            }
            return Promise.reject(new Error(`unknown workspace callback: ${method}`));
        },
        spawnPty: spawnBunPty,
    });

    return {
        async call(method, params, canUseTerminal) {
            const name = method.slice(WORKSPACE_PREFIX.length);
            const handler = table.handlers[name];
            if (!handler) throw new Error(`Method not found: ${method}`);
            if (name.startsWith("pty.") && !canUseTerminal) {
                throw new Error(
                    "The terminal is turned off for other devices on that computer. Turn \"terminal for other devices\" back on in its /settings (or start loop serve without --no-terminal), then reconnect.",
                );
            }
            return await handler(params);
        },
        dispose() {
            table.terminals.closeAll();
        },
    };
}
