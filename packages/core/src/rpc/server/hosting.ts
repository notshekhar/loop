import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, PRODUCT_NAME } from "../../brand";
import type { Transport } from "./active-session";

/** What a host process needs of the RPC server: feed it lines, and shut it down. */
export interface AttachableServer {
    attach(transport: Transport): { feed: (chunk: Buffer | string) => void; close: () => void };
    dispose(): number;
}

/** A transport that writes one JSON message per line. */
function lineTransport(write: (line: string) => void): Transport {
    return {
        send(msg) {
            write(JSON.stringify(msg) + "\n");
        },
    };
}

/** Best-effort removal: the file may already be gone. */
function removeQuietly(path: string): void {
    try {
        unlinkSync(path);
    } catch {}
}

/** Serve `server` over this process's stdin/stdout. */
export function serveStdio(server: AttachableServer): void {
    const { feed } = server.attach(lineTransport((line) => process.stdout.write(line)));
    // Three ways this process ends, and all of them have to reap what bash
    // started. The desktop's LoopProcess.stop() is a plain kill(), so SIGTERM
    // is the common path, not the exotic one.
    let leaving = false;
    const leave = () => {
        if (leaving) return;
        leaving = true;
        server.dispose();
        process.exit(0);
    };
    process.stdin.on("data", feed);
    process.stdin.on("end", leave);
    process.on("SIGTERM", leave);
    process.on("SIGINT", leave);
}

function rpcPaths(): { socketPath: string; pidPath: string } {
    const dir = join(getConfigDir(), "agent");
    mkdirSync(dir, { recursive: true });
    return { socketPath: join(dir, "rpc.sock"), pidPath: join(dir, "rpc.pid") };
}

/** Pid from rpc.pid if that process is still alive, else null (stale/absent). */
function liveDaemonPid(pidPath: string): number | null {
    if (!existsSync(pidPath)) return null;
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        process.kill(pid, 0); // signal 0 = existence check only
        return pid;
    } catch {
        return null;
    }
}

/** Refuse to start a second daemon; clear what a dead one left behind. */
export function claimSocketPaths(): { socketPath: string; pidPath: string } {
    const paths = rpcPaths();
    const alive = liveDaemonPid(paths.pidPath);
    if (alive)
        throw new Error(
            `${PRODUCT_NAME} rpc daemon already running (pid ${alive}); stop it with: ${PRODUCT_NAME} rpc stop`,
        );
    // Any leftover socket belongs to a dead daemon (the pid check above).
    if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath);
    return paths;
}

/** Serve `server` on the daemon's unix socket, recording our pid once listening. */
export function serveSocket(server: AttachableServer, socketPath: string, pidPath: string): Server {
    const net = createServer((socket: Socket) => {
        const { feed, close } = server.attach(lineTransport((line) => socket.write(line)));
        socket.on("data", feed);
        socket.on("close", close);
        socket.on("error", () => socket.destroy());
    });

    net.listen(socketPath, () => {
        writeFileSync(pidPath, String(process.pid));
    });

    // Leave no stale socket/pid behind on a signal exit — the next start would
    // otherwise have to clean up after us.
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // Before the socket goes: a client cannot reconnect to kill a shell
        // whose registry died with this process.
        server.dispose();
        removeQuietly(socketPath);
        removeQuietly(pidPath);
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return net;
}

/**
 * Stop a running socket daemon via its pid file (SIGTERM — the daemon's own
 * handler cleans up its socket/pid). Returns what happened for the CLI to
 * report; stale files from a dead daemon are cleaned up here.
 */
export function stopSocketServer(): { stopped: boolean; pid?: number } {
    const { socketPath, pidPath } = rpcPaths();
    const pid = liveDaemonPid(pidPath);
    if (!pid) {
        removeQuietly(socketPath);
        removeQuietly(pidPath);
        return { stopped: false };
    }
    process.kill(pid, "SIGTERM");
    return { stopped: true, pid };
}
