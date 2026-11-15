/**
 * `/rc`: this machine as a host. Starts the same server `loop serve` runs,
 * prints how to reach it, and hands it this loop's open sessions.
 */
import { createConnection } from "node:net";
import {
    getSetting,
    isLoopbackHost,
    lanAddresses,
    PRODUCT_NAME,
    remoteTerminalFor,
    SERVE_DEFAULT_PORT,
    setSetting,
    startWebServer,
    tailnetIdentity,
    terminalQr,
    type LiveSessionProvider,
    type ServeHandle,
} from "@notshekhar/loop-core";
import { formatError } from "../format-error";
import { accent, dim, err, warn } from "../ui/text";
import { say, type RemoteState } from "./state";

/** Ports tried from SERVE_DEFAULT_PORT up, when the first ones are taken. */
const RC_PORT_ATTEMPTS = 5;

/**
 * This loop's open sessions, as the `/rc` server sees them: a client's
 * message to one is typed into it here (shown on screen, queued if a turn
 * is running), and its turns stream back out through `deps.live.feed`.
 * One stream, every screen. Sessions not open here the server runs itself.
 */
function liveSessions(state: RemoteState): LiveSessionProvider {
    const { slots, roster } = state.host;
    return {
        get(sessionId) {
            const slot = slots.bySessionId(sessionId);
            if (!slot || slot.remote || !slot.session) return undefined;
            return {
                session: slot.session,
                send: (input) => {
                    void roster.runnerFor(slot)(input, { chatOnly: true });
                },
                cancel: () => {
                    if (!slot.busy) return;
                    // What Esc does: abort, and a fresh controller for the next turn.
                    slot.abort.abort();
                    slot.abort = new AbortController();
                },
            };
        },
    };
}

function printReach(state: RemoteState, opts: { freshCode?: boolean } = {}): void {
    const rc = state.rc;
    if (!rc) return;
    // By hand: the address and a six-digit code the app trades for the
    // token. Asking again (`/rc` while on) shows a new code.
    const pairingCode = rc.pairingCode({ fresh: opts.freshCode === true });
    const tailnet = isLoopbackHost(rc.hostname) ? null : tailnetIdentity();
    const tailnetUrl = tailnet?.dnsName ? `http://${tailnet.dnsName}:${rc.port}/?token=${rc.token}` : null;
    const pairing = tailnetUrl ?? rc.networkUrls[0] ?? rc.url;
    // The QR first and the links last: the code is ~20 rows tall, and
    // what sits nearest the prompt is what stays on screen to be copied.
    const lines = [
        accent("remote control on") + dim(` — scan with the ${PRODUCT_NAME} app:`),
        "",
        terminalQr(pairing),
        "",
        `  local     ${rc.url}`,
        ...rc.networkUrls.map((u) => `  network   ${u}`),
        ...(tailnetUrl ? [`  tailnet   ${tailnetUrl}`] : []),
        `  code      ${accent(`${pairingCode.code.slice(0, 3)} ${pairingCode.code.slice(3)}`)}` +
            dim(`  type host ${new URL(pairing).host} and this code in the app (one use, 5 min; /rc for a new one)`),
        dim("or paste a link into another loop's /hosts"),
        dim(
            state.rcTerminal
                ? "terminal: offered to paired devices"
                : 'terminal: this machine only — turn on "terminal for other devices" in /settings, then /rc off and /rc',
        ),
        warn("Anyone with this link fully controls this machine. ") + dim("/rc off stops it."),
    ];
    say(state, lines.join("\n"));
}

function stopRemoteControl(state: RemoteState): void {
    if (!state.rc) say(state, dim("remote control is not on"));
    else {
        state.host.deps.live.feed = null;
        state.rc.stop();
        state.rc = null;
        say(state, "remote control off");
    }
}

/**
 * The same consent `loop serve` asks for, given here instead of in
 * /settings: this exposes the machine to whoever holds the link.
 * Resolves whether remote control may start.
 */
async function confirmServe(state: RemoteState): Promise<boolean> {
    if (getSetting("serve")) return true;
    const pick = await state.host.deps.selectOnce(
        [
            {
                value: "on",
                label: "Turn on remote control",
                description: "anyone with the link controls this machine, terminal included",
            },
            {
                value: "chat",
                label: "Turn on, without the terminal",
                description: "paired devices get chat only, no shell here",
            },
            { value: "no", label: "Cancel" },
        ],
        "Remote control",
    );
    if (pick?.value !== "on" && pick?.value !== "chat") return false;
    setSetting("serve", true);
    if (pick.value === "chat") setSetting("serveTerminal", false);
    return true;
}

/** The server on the first free port from the default, or the last error when none would start. */
async function startServer(state: RemoteState, bind: string): Promise<{ rc: ServeHandle } | { error: unknown }> {
    let lastError: unknown;
    for (let port = SERVE_DEFAULT_PORT; port < SERVE_DEFAULT_PORT + RC_PORT_ATTEMPTS; port++) {
        // macOS lets 127.0.0.1:N bind beside another process's *:N, and
        // then the two answer the same port in turn. Skip a port anything
        // already answers on — usually a `loop serve` started elsewhere.
        if (await portAnswers(port)) continue;
        try {
            const rc = startWebServer({
                host: bind,
                port,
                // The app's terminal, for other devices: on unless
                // /settings turned it off (`/rc --terminal` overrides
                // that for this run, `/rc --no-terminal` the reverse).
                remoteTerminal: state.rcTerminal,
                ...(state.host.version ? { version: state.host.version } : {}),
                live: liveSessions(state),
            });
            return { rc };
        } catch (e) {
            lastError = e;
        }
    }
    return { error: lastError };
}

/** `/rc [off|--local|--terminal|--no-terminal]`. */
export async function remoteControl(state: RemoteState, args: string): Promise<void> {
    const sub = args.trim();
    if (sub === "off" || sub === "stop") {
        stopRemoteControl(state);
        return;
    }
    if (state.rc) {
        printReach(state, { freshCode: true });
        return;
    }
    if (!(await confirmServe(state))) return;
    // Reachable from the phone means a network bind; the token is the lock.
    const bind = /--local\b/.test(sub) ? "127.0.0.1" : "0.0.0.0";
    state.rcTerminal = remoteTerminalFor(
        { terminal: /--terminal\b/.test(sub), "no-terminal": /--no-terminal\b/.test(sub) },
        getSetting("serveTerminal"),
    );
    const started = await startServer(state, bind);
    if (!("rc" in started)) {
        say(state, err(`could not start remote control: ${formatError(started.error)}`));
        return;
    }
    state.rc = started.rc;
    // From here, every turn in this loop streams to remote clients too.
    state.host.deps.live.feed = started.rc.live;
    if (!lanAddresses().length && bind === "0.0.0.0")
        say(state, dim("no network address found — reachable from this machine only"));
    printReach(state);
}

/** Whether something on this machine already accepts connections on `port`. */
function portAnswers(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const done = (answered: boolean) => {
            socket.destroy();
            resolve(answered);
        };
        socket.setTimeout(300, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}
