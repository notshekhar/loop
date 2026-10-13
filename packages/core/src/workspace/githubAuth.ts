/**
 * Signing `gh` in from a loop client, so pull requests work without a terminal.
 *
 * Two ways, both ending in `gh`'s own credential store (the system keyring) —
 * loop never keeps a token of its own:
 *
 *  - Browser: `gh auth login --web` prints a one-time code and waits while the
 *    user enters it at github.com/login/device. The code and URL are handed to
 *    the client, which opens the page on whatever device it runs on — a phone
 *    paired with a remote host signs that host in. `GH_BROWSER=true` stops `gh`
 *    from also opening a browser on the host, which may be headless or someone
 *    else's screen.
 *  - Token: a personal access token piped into `gh auth login --with-token`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

const HOST = "github.com";
/** GitHub's device codes expire after 15 minutes; give up a little later. */
const LOGIN_TIMEOUT_MS = 16 * 60_000;
/** How long to wait for `gh` to print its code before calling the start failed. */
const CODE_TIMEOUT_MS = 20_000;

interface PendingLogin {
    readonly child: ChildProcess;
    readonly done: Promise<{ readonly ok: boolean; readonly output: string }>;
    readonly timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingLogin>();

function ghEnv(): NodeJS.ProcessEnv {
    // GH_TOKEN would win over whatever this login stores, and make it pointless.
    const { GH_TOKEN: _token, GITHUB_TOKEN: _github, ...env } = process.env;
    return { ...env, GH_BROWSER: "true", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" };
}

/** `! First copy your one-time code: ABCD-1234` → `ABCD-1234`. Exported for tests. */
export function parseDeviceCode(output: string): { code: string; url: string } | null {
    const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1];
    if (!code) return null;
    const url = /(https:\/\/\S+\/login\/device)\b/.exec(output)?.[1] ?? `https://${HOST}/login/device`;
    return { code: code.toUpperCase(), url };
}

function spawnGh(args: readonly string[]): ChildProcess {
    try {
        return spawn("gh", [...args], { env: ghEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch {
        throw new Error("The GitHub CLI (gh) is not installed or not on PATH.");
    }
}

/** Start a browser sign-in; resolves once `gh` has a code to show. */
export async function startGithubLogin(): Promise<{ id: string; code: string; url: string }> {
    const child = spawnGh([
        "auth",
        "login",
        "--hostname",
        HOST,
        "--git-protocol",
        "https",
        "--web",
        "--skip-ssh-key",
    ]);
    let output = "";
    const done = new Promise<{ ok: boolean; output: string }>((resolve) => {
        child.on("error", (error) => {
            const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
            output += missing ? "The GitHub CLI (gh) is not installed or not on PATH." : String(error);
            resolve({ ok: false, output });
        });
        child.on("close", (code) => resolve({ ok: code === 0, output }));
    });
    const onData = (chunk: Buffer) => {
        output += chunk.toString();
        // "Press Enter to open … in your browser" — Enter, so it moves on to polling.
        if (/press enter/i.test(chunk.toString())) child.stdin?.write("\n");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const code = await new Promise<{ code: string; url: string }>((resolve, reject) => {
        const started = Date.now();
        const tick = setInterval(() => {
            const parsed = parseDeviceCode(output);
            if (parsed) {
                clearInterval(tick);
                resolve(parsed);
            } else if (child.exitCode !== null || Date.now() - started > CODE_TIMEOUT_MS) {
                clearInterval(tick);
                child.kill();
                reject(new Error(output.trim() || "gh did not start a sign-in."));
            }
        }, 100);
        void done.then((result) => {
            if (!result.ok && !parseDeviceCode(output)) {
                clearInterval(tick);
                reject(new Error(result.output.trim() || "gh did not start a sign-in."));
            }
        });
    });

    const id = randomUUID();
    const timer = setTimeout(() => cancelGithubLogin(id), LOGIN_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { child, done, timer });
    return { id, ...code };
}

/**
 * Where a browser sign-in stands. The client asks every few seconds while its
 * dialog is open: a sign-in takes minutes, longer than any one request may.
 */
export async function githubLoginStatus(
    id: string,
): Promise<{ readonly state: "pending" | "done" | "failed"; readonly error: string | null }> {
    const login = pending.get(id);
    if (!login) return { state: "failed", error: "This sign-in has expired. Start again." };
    const settled = await Promise.race([login.done, new Promise<null>((r) => setTimeout(() => r(null), 0))]);
    if (settled === null) return { state: "pending", error: null };
    clearTimeout(login.timer);
    pending.delete(id);
    if (settled.ok) return { state: "done", error: null };
    const detail = settled.output
        .split("\n")
        .filter((l) => /error|fail|expired|denied/i.test(l))
        .join(" ")
        .trim();
    return { state: "failed", error: detail || "Sign-in did not complete." };
}

export function cancelGithubLogin(id: string): { readonly ok: true } {
    const login = pending.get(id);
    if (login) {
        login.child.kill();
        clearTimeout(login.timer);
        pending.delete(id);
    }
    return { ok: true };
}

/** Sign in with a personal access token; `gh` checks it and stores it in the keyring. */
export async function loginGithubWithToken(token: string): Promise<{ readonly ok: true }> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Paste a token first.");
    const child = spawnGh(["auth", "login", "--hostname", HOST, "--git-protocol", "https", "--with-token"]);
    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString()));
    const ok = await new Promise<boolean>((resolve) => {
        child.on("error", (error) => {
            const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
            output += missing ? "The GitHub CLI (gh) is not installed or not on PATH." : String(error);
            resolve(false);
        });
        child.on("close", (code) => resolve(code === 0));
        child.stdin?.end(`${trimmed}\n`);
    });
    if (!ok) throw new Error(output.trim() || "gh rejected the token.");
    return { ok: true };
}
