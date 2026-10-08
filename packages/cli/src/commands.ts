import { brandEnv, envName, REPO_SLUG, PRODUCT_NAME } from "@notshekhar/loop-core";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    getActiveProvider,
    getCatalog,
    getSetting,
    isLoopbackHost,
    lanAddresses,
    listAuthorizedProviders,
    loginApiKey,
    loginXaiOAuth,
    logout,
    SERVE_DEFAULT_PORT,
    SessionManager,
    type SessionScope,
    startSocketServer,
    startStdioServer,
    startWebServer,
    stopSocketServer,
    tailnetIdentity,
    terminalQr,
} from "@notshekhar/loop-core";
import type { ProviderId } from "@notshekhar/loop-core";
import { readStdinAll, readStdinLine, type Args } from "./args";
import type { OutputFormat } from "./spec";
import { runPrint } from "./print";
import { openBrowser } from "./open-browser";

declare const __APP_VERSION__: string;
/** Same source as `loop --version` (cli.ts): injected at build, "0.0.0" from source. */
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

const UPGRADE_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh`;
const UPGRADE_URL_PS1 = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1`;
const RELEASES_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;

type InstallMethod = "binary" | "source";

// Identify how the running `loop` was installed so `loop upgrade` uses the
// matching upgrade path. The installer writes `.install-method` next to
// the binary; default to "binary" otherwise.
function detectInstallMethod(): InstallMethod {
    const execDir = dirname(process.execPath);
    const markerFile = join(execDir, ".install-method");
    if (existsSync(markerFile)) {
        const v = readFileSync(markerFile, "utf8").trim();
        if (v === "binary" || v === "source") return v;
    }
    return "binary";
}

/**
 * Is release `a` newer than `b`? Either may carry a leading `v`, as git tags do.
 *
 * `Bun.semver` knows the rules a split-on-dots comparison cannot: a release
 * outranks its own prerelease (`1.0.0` > `1.0.0-beta.1`), prerelease numbers
 * compare numerically rather than as text (`beta.10` > `beta.2`), and build
 * metadata never affects precedence. None of that is reachable today —
 * bump-version only emits `x.y.z` and GitHub's "latest release" skips
 * prereleases — so this is insurance for the first tag that isn't, not a fix
 * for anything currently observable.
 *
 * The catch is load-bearing. `Bun.semver.order` THROWS on anything it cannot
 * parse, where the old hand-rolled comparison quietly read it as `0.0.0`, and
 * `a` is a tag name straight out of the GitHub API — a repo tagged `nightly`
 * would hand us one. The startup check calls this without awaiting
 * (`startup.ts`), so a throw would surface as an unhandled rejection at launch
 * instead of the honest answer, which is that an unreadable tag is not a newer
 * version.
 */
export function semverGt(a: string, b: string): boolean {
    try {
        return Bun.semver.order(a, b) === 1;
    } catch {
        return false;
    }
}

async function fetchLatestTag(): Promise<string | null> {
    // The releases/latest redirect isn't subject to the anonymous GitHub API
    // rate limit (60 req/h/IP) that bites CI and shared networks.
    try {
        const r = await fetch(`https://github.com/${REPO_SLUG}/releases/latest`, {
            method: "HEAD",
            redirect: "follow",
        });
        const tag = r.url.split("/").pop() ?? "";
        if (/^v\d/.test(tag)) return tag;
    } catch {}
    try {
        const r = await fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json" } });
        if (!r.ok) return null;
        const j = (await r.json()) as { tag_name?: string };
        return j.tag_name ?? null;
    } catch {
        return null;
    }
}

/** Newer release tag (e.g. "v0.0.3") if one exists, else null. */
export async function resolveAvailableUpdate(version: string): Promise<string | null> {
    const latest = await fetchLatestTag();
    if (latest && semverGt(latest, `v${version}`)) return latest;
    return null;
}

// Silent startup check — like resolveAvailableUpdate, but network/parse
// failures resolve to null so startup is never blocked or noisy.
// Set LOOP_SKIP_VERSION_CHECK to disable.
export async function checkForUpdate(version: string): Promise<string | null> {
    if (brandEnv("SKIP_VERSION_CHECK")) return null;
    return resolveAvailableUpdate(version);
}

export function printHelp(version: string): void {
    console.log(`${PRODUCT_NAME}/agent — terminal coding agent (v${version})

Usage:
  ${PRODUCT_NAME}                     Start interactive TUI
  ${PRODUCT_NAME} run <prompt|->      Run a single prompt and exit (- reads the prompt from stdin)
  ${PRODUCT_NAME} login [provider]    Configure provider auth
  ${PRODUCT_NAME} logout [provider]   Remove auth
  ${PRODUCT_NAME} sessions [--archived|--all] List sessions in current cwd
  ${PRODUCT_NAME} archive <id>        Archive a session (hides it from the lists)
  ${PRODUCT_NAME} unarchive <id>      Restore an archived session
  ${PRODUCT_NAME} goals <cmd>         Manage background tasks (list, add, rm, run, tick, daemon…)
  ${PRODUCT_NAME} artifacts [export <id>] List pages the agent wrote, or save one out
  ${PRODUCT_NAME} models              List available models
  ${PRODUCT_NAME} whoami              Show active provider + auth status
  ${PRODUCT_NAME} cost audit          Verify the cost ledger reconciles (self-audit)
  ${PRODUCT_NAME} rpc [--socket|stop] Start JSON-RPC server (stop: end the socket daemon)
  ${PRODUCT_NAME} serve [--host|--port|--terminal] Web UI + WebSocket RPC (opt-in via /settings; token-locked)
  ${PRODUCT_NAME} gateways [status|stop] Run remote chat gateway daemons (set up in /gateways)
  ${PRODUCT_NAME} mcp <cmd>           Manage MCP servers (add, list, remove, login…)
  ${PRODUCT_NAME} man                 Open the manual (--install writes it to the manpath)
  ${PRODUCT_NAME} completion <shell>  Print a tab-completion script (bash, zsh, fish)
  ${PRODUCT_NAME} upgrade             Pull latest and rebuild
  ${PRODUCT_NAME} version | -v        Print version
  ${PRODUCT_NAME} help | -h           Show this help

Extensions:
  ${PRODUCT_NAME} install <spec>      Install an extension
  ${PRODUCT_NAME} link <path>         Link a local extension for development
  ${PRODUCT_NAME} remove <name>       Remove an installed extension
  ${PRODUCT_NAME} extensions          List installed extensions
  ${PRODUCT_NAME} enable <name>       Enable an extension
  ${PRODUCT_NAME} disable <name>      Disable an extension

Flags:
  --model <provider/id>    Override default model
  --provider <id>          Override active provider
  --cwd <path>             Working directory
  --session <id>           Resume session by id
  --max-steps <n>          Cap agent steps in run mode (default: maxSteps setting)
  --output-format <fmt>    run mode output: text (default), json, stream-json
  --                       End flag parsing (a prompt may then start with -)

In run mode, text puts the reply on stdout and activity on stderr; json prints
one result object when the run ends; stream-json prints one JSON event per line
as it happens. Both JSON formats keep stdout free of anything but JSON, and
report the session id so a follow-up can pass --session.

Unknown commands and flags are refused rather than guessed at; each command
accepts only its own flags (${PRODUCT_NAME} completion <shell> teaches your shell which).`);
}

export async function runUpgrade(version: string, opts: { force?: boolean } = {}): Promise<void> {
    console.log(`▶ Checking for updates (current v${version})…`);
    const latest = await fetchLatestTag();
    if (!opts.force && latest) {
        if (!semverGt(latest, `v${version}`)) {
            console.log(`Up to date (latest ${latest})`);
            return;
        }
        console.log(`▶ Upgrading ${version} → ${latest}`);
    } else if (!latest) {
        console.log("▶ Could not query latest release; running installer anyway.");
    }

    const method = detectInstallMethod();
    console.log(`▶ Install method: ${method}`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.force) env[envName("FORCE")] = "1";
    if (method === "source") env[envName("FROM_SOURCE")] = "1";

    // Windows: invoke PowerShell installer. Mac/Linux: bash.
    const isWin = process.platform === "win32";
    let shell: string;
    let args: string[];
    if (isWin) {
        shell = "powershell";
        args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${UPGRADE_URL_PS1} | iex`];
    } else {
        shell = "bash";
        args = ["-c", `curl -fsSL ${UPGRADE_URL} | bash`];
    }

    const r = spawnSync(shell, args, { stdio: "inherit", env });
    process.exit(r.status ?? 1);
}

export async function cmdLogin(provider?: string): Promise<void> {
    const p = (provider ?? "xai") as ProviderId;
    if (p === "xai") {
        const mode = await readStdinLine("xAI: [1] OAuth subscription  [2] API key  > ");
        if (mode === "2") {
            const key = await readStdinLine("XAI_API_KEY: ");
            loginApiKey("xai", key);
            console.log("xAI API key saved.");
        } else {
            await loginXaiOAuth(({ url, instructions }) => {
                console.log(instructions);
                console.log(url);
                const opened = openBrowser(url);
                console.log(opened ? "(opened in browser)" : "(open this URL in a browser)");
            });
            console.log("xAI OAuth login complete.");
        }
        return;
    }
    const key = await readStdinLine(`${p.toUpperCase()}_API_KEY: `);
    loginApiKey(p, key);
    console.log(`${p} API key saved.`);
}

export async function cmdLogout(target?: ProviderId): Promise<void> {
    await logout(target);
    console.log(target ? `Logged out of ${target}.` : "Logged out of all providers.");
}

/**
 * `loop sessions [--archived|--all]` — the sessions in this folder.
 *
 * Archived ones are hidden by default, which is the point of archiving. The
 * flags exist because hiding them here without a way to see them again would
 * make the desktop app's Archive a ONE-WAY DOOR for anyone working in the
 * terminal: `manager.list` is what both this and the TUI's `/sessions` picker
 * read, so an archived session would vanish from every terminal surface with
 * no id left to resume by. `loop unarchive <id>` brings one back.
 */
export async function cmdSessions(args?: Args): Promise<void> {
    const mgr = new SessionManager();
    const scope: SessionScope = args?.flags.all ? "all" : args?.flags.archived ? "archived" : "active";
    const sessions = mgr.list(process.cwd(), scope);
    if (sessions.length === 0) {
        console.log(scope === "archived" ? "No archived sessions in this cwd." : "No sessions in this cwd.");
        return;
    }
    for (const s of sessions) {
        // Named sessions (background runs are always "background: <text>") show the name —
        // it identifies the session far better than the first prompt line.
        const preview = s.name ?? s.firstUserMessage?.split("\n")[0] ?? "";
        // Only in a listing that mixes both — in `--archived` every row is one.
        const mark = scope === "all" && s.archivedAt ? "  [archived]" : "";
        console.log(`${s.id}  ${s.model}  ${new Date(s.mtime).toISOString()}  ${preview}${mark}`);
    }
}

/**
 * `loop archive <id>` / `loop unarchive <id>` — put a session away, or take it
 * back. The counterpart to the desktop app's Archive, so neither surface can
 * strand a conversation the other can no longer reach.
 */
export async function cmdArchive(args: Args, archived: boolean): Promise<void> {
    const id = args.positional[0];
    if (!id) {
        console.error(`Usage: ${PRODUCT_NAME} ${archived ? "archive" : "unarchive"} <session-id>`);
        process.exitCode = 1;
        return;
    }
    const ok = new SessionManager().setArchived(id, archived);
    if (!ok) {
        console.error(`No such session: ${id}`);
        process.exitCode = 1;
        return;
    }
    console.log(archived ? `Archived ${id}.` : `Restored ${id}.`);
}

export function cmdRpc(args: Args): void {
    const sub = args.positional[0];
    if (sub === "stop") {
        const r = stopSocketServer();
        console.log(r.stopped ? `Stopped ${PRODUCT_NAME} RPC daemon (pid ${r.pid}).` : "No RPC daemon running.");
        return;
    }
    if (args.flags.socket) {
        try {
            const { socketPath } = startSocketServer();
            console.log(`${PRODUCT_NAME} RPC daemon listening on ${socketPath}`);
        } catch (err) {
            console.error((err as Error).message);
            process.exitCode = 1;
        }
        return;
    }
    startStdioServer();
}

export function cmdServe(args: Args): void {
    // Opt-in gate: this is remote code execution by design — whoever has the
    // URL runs the agent (and therefore shell commands) as this user.
    if (!getSetting("serve")) {
        console.error(
            `${PRODUCT_NAME} serve is off. It exposes this machine to anyone with the URL — enable it\n` +
                `deliberately: open ${PRODUCT_NAME}, run /settings, and turn on the serve entry.`,
        );
        process.exitCode = 1;
        return;
    }
    // Default to all interfaces: the point of serve is reaching the UI from
    // another device (phone, laptop) — the token is the lock either way.
    // `--host 127.0.0.1` restores a loopback-only bind.
    const host = typeof args.flags.host === "string" ? args.flags.host : "0.0.0.0";
    const port = typeof args.flags.port === "string" ? Number(args.flags.port) : SERVE_DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`Invalid --port: ${args.flags.port}`);
        process.exitCode = 1;
        return;
    }
    let url: string;
    let hostname: string;
    let networkUrls: string[];
    let boundPort: number;
    let token: string;
    let stop: () => void;
    try {
        ({ url, hostname, networkUrls, port: boundPort, token, stop } = startWebServer({ host, port, remoteTerminal: Boolean(args.flags.terminal), version: APP_VERSION }));
    } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
    }
    // "Ctrl+C to stop" was the whole exit path: the default signal disposition
    // ends the process without unwinding, so a background shell a remote client
    // started outlived the server that started it, unreachable. Stopping the
    // handle disposes the RPC server, which kills them.
    let leaving = false;
    const leave = () => {
        if (leaving) return;
        leaving = true;
        stop();
        process.exit(0);
    };
    process.on("SIGINT", leave);
    process.on("SIGTERM", leave);
    console.log(`${PRODUCT_NAME} serve — web UI + WebSocket RPC\n`);
    console.log(`  local     ${url}`);
    if (networkUrls.length) {
        for (const u of networkUrls) console.log(`  network   ${u}`);
    } else if (isLoopbackHost(hostname)) {
        // Loopback bind (--host 127.0.0.1): show the full LAN URL (token
        // included) so it can be copied now — but it only answers on a
        // network bind, so say so.
        const lan = lanAddresses()[0];
        if (lan) {
            console.log(`  network   http://${lan}:${boundPort}/?token=${token}`);
            console.log(`            (not reachable yet — restart without --host to expose)`);
        }
    }
    // The tailnet name works from anywhere the phone is, not just this Wi-Fi —
    // but only when the bind faces more than loopback.
    const tailnet = isLoopbackHost(hostname) ? null : tailnetIdentity();
    const tailnetUrl = tailnet?.dnsName ? `http://${tailnet.dnsName}:${boundPort}/?token=${token}` : null;
    if (tailnetUrl) console.log(`  tailnet   ${tailnetUrl}`);
    // The link a phone pairs with (apps/mobile): scan this, or paste the URL.
    const pairingUrl = tailnetUrl ?? networkUrls[0] ?? url;
    console.log(`\nPair a phone — scan with the loop app (${tailnetUrl ? "tailnet" : networkUrls[0] ? "LAN" : "this machine only"}):\n`);
    console.log(terminalQr(pairingUrl));
    console.log(``);
    console.log(`WARNING: anyone with this URL fully controls this machine (the agent runs`);
    console.log(`shell commands as you). The token is the only lock — do not share or log it.`);
    if (isLoopbackHost(hostname)) {
        console.log(`Bound to ${hostname} — for remote access bring your own network`);
        console.log(`(Tailscale, ssh -L, cloudflared), which also provides TLS.`);
    } else {
        console.log(`Bound to ${hostname} — reachable from your network, over plain HTTP.`);
        console.log(`Use --host 127.0.0.1 for a loopback-only bind.`);
    }
    console.log(`\nCtrl+C to stop.`);
}

/**
 * `loop gateways` — manage/run remote chat gateway daemons. Each gateway runs
 * as its own process; setup (tokens, pairing) is done in the TUI: /gateways.
 *
 *   loop gateways            spawn detached daemons for all enabled gateways
 *   loop gateways <id>       run that gateway in the FOREGROUND (the daemon body)
 *   loop gateways status     show each gateway's config/enabled/running state
 *   loop gateways stop [id]  stop all gateway daemons, or just one
 *
 * `onlyId` is set by the `loop telegram` alias (→ run telegram foreground).
 */
export async function cmdGateways(args: Args, onlyId?: string): Promise<void> {
    const { listGateways, getGateway, listEnabledGateways, liveGatewayOwner, stopGatewayDaemon } =
        await import("@notshekhar/loop-core");
    const { spawnGatewayDaemon, runGatewayForeground } = await import("./gateway-daemon");

    const sub = onlyId ?? args.positional[0];

    if (!onlyId && sub === "status") {
        for (const gw of listGateways()) {
            const st = gw.status();
            const owner = liveGatewayOwner(gw.id);
            console.log(`${gw.displayName} (${gw.id})`);
            console.log(`  configured  ${st.configured ? "yes" : "no"}`);
            console.log(`  enabled     ${st.enabled ? "yes" : "no"}`);
            console.log(
                `  running     ${
                    owner
                        ? `yes (pid ${owner.pid}, ${owner.mode === "in-process" ? `inside ${PRODUCT_NAME}` : "daemon"})`
                        : "no"
                }`,
            );
            for (const line of st.detail) console.log(`  ${line}`);
        }
        return;
    }

    if (!onlyId && sub === "stop") {
        const target = args.positional[1];
        const gws = target ? [getGateway(target)].filter(Boolean) : listGateways();
        if (target && !gws.length) {
            console.error(`unknown gateway: ${target}`);
            process.exitCode = 1;
            return;
        }
        for (const gw of gws) {
            const r = stopGatewayDaemon(gw!.id);
            if (r.refusedInProcess) {
                // That pid is a whole loop, not a gateway daemon — signalling it
                // would kill the user's session to turn off a chat bridge.
                console.log(
                    `${gw!.id} is running inside ${PRODUCT_NAME} (pid ${r.pid}) — ` +
                        `turn it off there with /gateways, or quit that ${PRODUCT_NAME}`,
                );
            } else {
                console.log(r.stopped ? `stopped ${gw!.id} daemon (pid ${r.pid})` : `${gw!.id} not running`);
            }
        }
        return;
    }

    // A gateway id → run it in the foreground. This IS the daemon body (what the
    // detached spawn invokes, and what `loop telegram` maps to).
    const named = sub ? getGateway(sub) : undefined;
    if (named) {
        if (!named.isConfigured()) {
            console.error(
                `${named.displayName} is not configured. Open ${PRODUCT_NAME}, run /gateways → ${named.displayName},\n` +
                    `set it up, then re-run: ${PRODUCT_NAME} gateways ${named.id}`,
            );
            process.exitCode = 1;
            return;
        }
        if (!named.isEnabled()) named.setEnabled(true); // running the daemon implies enabling
        console.log(`${PRODUCT_NAME} gateways — ${named.displayName} daemon`);
        console.log(`WARNING: whoever controls the paired chat runs shell commands as you.\n`);
        try {
            await runGatewayForeground(named.id, {
                cwd: (args.flags.cwd as string) || process.cwd(),
                log: (line) => console.log(`  ${line}`),
            });
        } catch (err) {
            console.error((err as Error).message);
            process.exitCode = 1;
        }
        return;
    }

    if (sub) {
        console.error(`unknown gateway or subcommand: ${sub}`);
        process.exitCode = 1;
        return;
    }

    // No args → spawn detached daemons for all enabled gateways.
    const enabled = listEnabledGateways();
    if (!enabled.length) {
        console.error(`no gateways enabled. Open ${PRODUCT_NAME}, run /gateways to set one up.`);
        process.exitCode = 1;
        return;
    }
    for (const gw of enabled) {
        const r = spawnGatewayDaemon(gw.id);
        console.log(
            `${gw.id}: ${r === "spawned" ? "daemon started" : r === "already-running" ? "already running" : "failed to start"}`,
        );
    }
    console.log(`\nRunning independently. Stop with: ${PRODUCT_NAME} gateways stop`);
}

export async function cmdRun(args: Args): Promise<void> {
    let prompt = args.positional.join(" ");
    // `loop run -` (or piped stdin with no prompt argument) reads the prompt
    // from stdin — CI callers pipe long prompts instead of shell-quoting them.
    if (prompt === "-" || (!prompt && !process.stdin.isTTY)) {
        prompt = (await readStdinAll()).trim();
    }
    if (!prompt) {
        console.error(`Usage: ${PRODUCT_NAME} run "<prompt>"   (or: echo "<prompt>" | ${PRODUCT_NAME} run -)`);
        process.exitCode = 1;
        return;
    }
    const maxSteps = Number(args.flags["max-steps"]) || undefined;
    await runPrint({
        prompt,
        modelId: (args.flags.model as string) || undefined,
        cwd: (args.flags.cwd as string) || undefined,
        sessionId: (args.flags.session as string) || undefined,
        maxSteps,
        // parseArgs has already rejected any value outside the set.
        outputFormat: (args.flags["output-format"] as OutputFormat) || undefined,
    });
}

/**
 * `loop artifacts` — the pages the agent wrote, one per line.
 *
 * Prints the file:// URL rather than opening anything: this is the scriptable
 * surface, and the interactive picker (`/artifacts` in the TUI) is where
 * "open it" lives. An artifact the agent reserved but never wrote is listed
 * too, marked, rather than hidden — otherwise it looks like it was lost.
 */
export async function cmdArtifacts(args?: Args): Promise<void> {
    const { getSetting, listArtifacts, artifactFilePath, exportArtifact } = await import("@notshekhar/loop-core");
    // `loop artifacts export <id> [dir]` — the scriptable half of the picker's
    // Download action, sharing its implementation so both name the file alike.
    if (args?.positional[0] === "export") {
        const id = args.positional[1];
        if (!id) {
            console.error(`Usage: ${PRODUCT_NAME} artifacts export <id> [dir]`);
            process.exitCode = 1;
            return;
        }
        try {
            console.log(exportArtifact(id, args.positional[2]));
        } catch (err) {
            console.error((err as Error).message);
            process.exitCode = 1;
        }
        return;
    }
    if (getSetting("artifacts") !== true) {
        console.error(`Artifacts are off. Enable them in ${PRODUCT_NAME} → /settings → artifacts.`);
        process.exitCode = 1;
        return;
    }
    const artifacts = listArtifacts();
    if (artifacts.length === 0) {
        console.log("No artifacts yet.");
        return;
    }
    const { pathToFileURL } = await import("node:url");
    for (const a of artifacts) {
        const where = a.written ? pathToFileURL(artifactFilePath(a)).href : "(not written yet)";
        console.log(`${a.id}  ${new Date(a.updatedAt).toISOString()}  ${a.title}\t${where}`);
    }
}

export async function cmdModels(): Promise<void> {
    const cat = await getCatalog();
    for (const m of Object.values(cat)) {
        console.log(`${m.id}\tctx:${m.contextWindow}\t$${m.cost.input}/$${m.cost.output}`);
    }
}

export function cmdWhoami(): void {
    console.log(`Active provider: ${getActiveProvider() ?? "none"}`);
    console.log(`Authorized: ${listAuthorizedProviders().join(", ") || "none"}`);
}

/** `loop cost audit` — reconcile the cost ledger against itself and the transcripts. */
export async function cmdCostAudit(): Promise<void> {
    const { auditLedger, closeDb } = await import("@notshekhar/loop-core");
    const audit = auditLedger();
    console.log(`Ledger rows: ${audit.rows}`);
    if (audit.priceViolations.length === 0) {
        console.log("Every priced row recomputes to its recorded usd (qty × snapshot price).");
    } else {
        console.log(`${audit.priceViolations.length} row(s) fail the price reconciliation:`);
        for (const v of audit.priceViolations.slice(0, 20)) {
            console.log(
                `  row ${v.id} (${v.model}): recorded $${v.usd.toFixed(6)}, recomputed $${v.computed.toFixed(6)}`,
            );
        }
    }
    if (audit.sessionMismatches.length === 0) {
        console.log("Ledger token sums match the transcripts for every session.");
    } else {
        console.log(`${audit.sessionMismatches.length} session(s) disagree with their transcripts:`);
        for (const m of audit.sessionMismatches.slice(0, 20)) {
            console.log(
                `  ${m.sessionPub}: ledger in/out ${m.ledgerInput}/${m.ledgerOutput}, entries ${m.entriesInput}/${m.entriesOutput}`,
            );
        }
    }
    closeDb();
    if (audit.priceViolations.length > 0 || audit.sessionMismatches.length > 0) process.exitCode = 1;
}
