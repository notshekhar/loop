/**
 * Other machines in the TUI: `/hosts` and `/rc`.
 *
 * `/hosts` is the switcher the phone and the desktop already have. Pair
 * another machine running `loop serve` (or `/rc` in its loop), pick it, pick
 * one of its sessions, and that session opens here as a slot like any other:
 * Ctrl+S lists it, and typing into it sends to that machine. The turn RUNS
 * there. This side renders the host's event stream through the same
 * `wireTurnEmitter` a local turn uses, so a remote transcript looks the same as
 * a local one.
 *
 * `/rc` is the other direction: it makes this machine pairable (the same
 * server `loop serve` runs), prints the link and a QR code for the phone, and
 * `/rc off` stops it.
 *
 * A remote session runs no local commands. The ones that move you somewhere
 * else (/hosts, /new, /resume) work. Everything that would act on THIS machine
 * (/model, `!cmd`, …) is refused, rather than silently changing a local
 * session nobody is looking at.
 */
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { basename } from "node:path";
import {
    asTurnEmitter,
    getSetting,
    isLoopbackHost,
    lanAddresses,
    listRemoteHosts,
    pairRemoteHost,
    parsePairingLink,
    probeRemoteHost,
    PRODUCT_NAME,
    RemoteHostClient,
    removeRemoteHost,
    SERVE_DEFAULT_PORT,
    setSetting,
    startWebServer,
    remoteTerminalFor,
    tailnetIdentity,
    terminalQr,
    TURN_EVENT_NAMES,
    CostTracker,
    type AskAnswer,
    type AskQuestion,
    type CommandRegistry,
    type CommandContext,
    type LiveSessionProvider,
    type Entry,
    type RemoteHostRecord,
    type RemoteSessionEvent,
    type ServeHandle,
} from "@notshekhar/loop-core";
import type { SelectItem, TUI } from "@notshekhar/loop-tui";
import { ChatHistory } from "./components/chat-history";
import { TodoPanel } from "./components/todo-panel";
import type { AppDeps } from "./deps";
import { describeTurnFailure } from "./turn-runner";
import { formatError } from "./format-error";
import { renderBranchEntries } from "./replay";
import { formatAge, type SessionRoster } from "./session-roster";
import type { RemoteLink, SessionSlot, SlotManager } from "./slots";
import { createSubagentStream } from "./subagent-stream";
import { wireTurnEmitter } from "./turn-emitter";
import { accent, dim, err, ok, warn } from "./ui/text";

/** Sessions per page in a host's list. */
const HOST_PAGE = 50;

/** Commands that make sense while another machine's session is on screen. */
const REMOTE_OK = new Set(["hosts", "rc", "help", "exit", "quit", "hotkeys", "theme", "copy"]);
/** Commands that leave for a session on this machine first, then run. */
const GO_LOCAL = new Set(["new", "clear", "resume", "sessions"]);

/** A row of a host's `session.list`. */
interface RemoteSessionRow {
    id: string;
    cwd: string;
    model?: string;
    lastModel?: string;
    name?: string;
    firstUserMessage?: string;
    mtime: number;
    running?: boolean;
}

interface RemoteHistory {
    entries: Entry[];
    model: string;
    name?: string;
    seq: number;
    running: boolean;
    info: { cwd: string };
}

function providerOf(modelId: string): string {
    const slash = modelId.indexOf("/");
    return slash > 0 ? modelId.slice(0, slash) : "";
}

export interface RemoteSessionsHost {
    slots: SlotManager;
    roster: SessionRoster;
    /** The app's deps (act on the foreground). */
    deps: AppDeps;
    ctx: CommandContext;
    commands: CommandRegistry;
    tui: TUI;
    /** The TUI's own question UI — a remote turn's `ask` opens it here. */
    ask: (questions: AskQuestion[], opts?: { signal?: AbortSignal }) => Promise<AskAnswer[]>;
    version?: string;
}

export interface RemoteSessions {
    manageHosts(args: string): Promise<void>;
    remoteControl(args: string): Promise<void>;
    /** Close every socket and stop `/rc`. */
    dispose(): void;
}

export function createRemoteSessions(host: RemoteSessionsHost): RemoteSessions {
    const { slots, roster, deps, tui } = host;
    const clients = new Map<string, RemoteHostClient>();
    let rc: ServeHandle | null = null;
    /** Whether the running remote control offers paired devices the terminal. */
    let rcTerminal = true;

    const say = (text: string): void => {
        deps.history.addSystem(text);
        tui.requestRender();
    };

    const clientFor = (record: RemoteHostRecord): RemoteHostClient => {
        const existing = clients.get(record.id);
        // Re-paired with a new address or token: the old socket is stale.
        if (existing && existing.host.url === record.url && existing.host.token === record.token) return existing;
        existing?.close();
        const client = new RemoteHostClient(record);
        let wasOpen = false;
        client.onStatus((status) => {
            const mine = slots.all().filter((s) => s.remote?.client === client);
            if (status === "reconnecting" && wasOpen) {
                for (const slot of mine) slot.history.addSystem(warn(`lost ${record.label} — reconnecting…`));
                tui.requestRender();
            }
            if (status === "open") {
                if (wasOpen) for (const slot of mine) void reattach(slot);
                wasOpen = true;
            }
        });
        clients.set(record.id, client);
        return client;
    };

    // ── one remote session as a slot ──────────────────────────────────────

    interface TurnState {
        startedAt: number;
        errors: unknown[];
        emitter: ReturnType<typeof asTurnEmitter>;
        signal: AbortSignal;
        dispose(): void;
    }
    const turns = new WeakMap<SessionSlot, TurnState>();
    /** Sends this TUI made whose turn has not started yet — so it is not announced as someone else's. */
    const sentHere = new WeakSet<SessionSlot>();

    const beginTurn = (slot: SessionSlot): TurnState => {
        const current = turns.get(slot);
        if (current) return current;
        const link = slot.remote!;
        const d = roster.depsFor(slot);
        if (!sentHere.has(slot)) slot.history.addSystem(dim(`a turn started on ${link.host.label} from another device`));
        sentHere.delete(slot);
        slot.busy = true;
        const provider = providerOf(link.model);
        slot.history.ensureAssistant(provider, link.model);
        const emitter = asTurnEmitter(new EventEmitter());
        const subagentStream = createSubagentStream(slot.history, tui);
        const errors: unknown[] = [];
        wireTurnEmitter(emitter, {
            history: slot.history,
            tui,
            state: roster.viewOf(slot),
            turnProvider: provider,
            subagentStream,
            todoPanel: slot.todoPanel,
            showWorking: d.showWorking,
            refreshStatusLine: d.refreshStatusLine,
            onTurnError: (e) => errors.push(e),
        });
        // Esc / Ctrl+C here cancels the turn THERE.
        const signal = slot.abort.signal;
        const onAbort = () => void link.client.call("session.cancel", { sessionId: link.sessionId }).catch(() => {});
        signal.addEventListener("abort", onAbort, { once: true });
        const turn: TurnState = {
            startedAt: Date.now(),
            errors,
            emitter,
            signal,
            dispose: () => {
                signal.removeEventListener("abort", onAbort);
                subagentStream.dispose();
            },
        };
        turns.set(slot, turn);
        d.showWorking("Generating");
        return turn;
    };

    const endTurn = (slot: SessionSlot): void => {
        const turn = turns.get(slot);
        slot.busy = false;
        if (!turn) return;
        turns.delete(slot);
        turn.dispose();
        const d = roster.depsFor(slot);
        slot.history.finishAssistant();
        if (turn.signal.aborted) slot.history.markPendingToolsInterrupted();
        else {
            const seconds = (Date.now() - turn.startedAt) / 1000;
            if (turn.errors.length > 0) slot.history.addTurnFailed(seconds, describeTurnFailure(turn.errors));
            else slot.history.addTurnSummary(seconds);
        }
        if (!slot.todoPanel.isEmpty()) {
            slot.history.addSystem(slot.todoPanel.retireLine());
            slot.todoPanel.clear();
        }
        d.hideWorking();
        d.settleTurn(turn.errors.length > 0 && !turn.signal.aborted);
        tui.requestRender();
        // Typed while it was busy: the next one goes now.
        const next = slot.queue.shift();
        if (next !== undefined) {
            d.renderPending();
            void roster.runnerFor(slot)(next);
        }
    };

    const answerAsk = async (slot: SessionSlot, data: { askId: string; questions: AskQuestion[] }): Promise<void> => {
        const link = slot.remote!;
        const signal = slot.abort.signal;
        // Same rule as a local ask: it opens when this session is on screen.
        const onScreen = await slots.waitForForeground(slot, "question", signal);
        const answers = onScreen
            ? await host.ask(data.questions, { signal })
            : data.questions.map(() => ({ answers: [], declined: true }));
        await link.client
            .call("session.answer", { sessionId: link.sessionId, askId: data.askId, answers })
            .catch(() => {});
    };

    const TURN_EVENTS = new Set<string>(TURN_EVENT_NAMES);

    const onEvent = (slot: SessionSlot, e: RemoteSessionEvent): void => {
        const link = slot.remote;
        if (!link || e.seq <= link.seq) return;
        link.seq = e.seq;
        const { type, data } = e.part;
        if (type === "session-running") {
            if ((data as { running?: boolean }).running) beginTurn(slot);
            else endTurn(slot);
            return;
        }
        if (type === "ask") {
            void answerAsk(slot, data as { askId: string; questions: AskQuestion[] });
            return;
        }
        if (!TURN_EVENTS.has(type)) return;
        // An event with no turn open (joined mid-turn, or a recap after the
        // end) still renders; it just opens one to render into.
        const turn = turns.get(slot) ?? (type === "data-recap" ? null : beginTurn(slot));
        if (turn) (turn.emitter as unknown as EventEmitter).emit(type, data);
        else if (type === "data-recap") slot.history.addRecap((data as { text: string }).text);
        tui.requestRender();
    };

    const reattach = async (slot: SessionSlot): Promise<void> => {
        const link = slot.remote;
        if (!link) return;
        try {
            const res = await link.client.call<{ seq: number; running: boolean; resync: boolean }>("session.attach", {
                sessionId: link.sessionId,
                afterSeq: link.seq,
            });
            if (res.resync) {
                slot.history.addSystem(
                    warn(`back on ${link.host.label}, but some output was missed — /hosts reopens it in full`),
                );
                link.seq = res.seq;
            } else {
                slot.history.addSystem(dim(`back on ${link.host.label}`));
            }
            if (!res.running && slot.busy) endTurn(slot);
        } catch (e) {
            slot.history.addError(`${link.host.label}: ${formatError(e)}`);
        }
        tui.requestRender();
    };

    const remoteRunner =
        (slot: SessionSlot) =>
        async (raw: string): Promise<void> => {
            const link = slot.remote!;
            const d = roster.depsFor(slot);
            const text = raw.trim();
            if (!text) return;
            const space = text.indexOf(" ");
            const command = text.startsWith("/") ? (space < 0 ? text.slice(1) : text.slice(1, space)) : null;
            const isCommand = command !== null && host.commands.has(command);

            if (slot.busy && !(isCommand && (GO_LOCAL.has(command!) || command === "hosts"))) {
                slot.queue.push(text);
                d.renderPending();
                tui.requestRender();
                return;
            }
            if (text.startsWith("!")) {
                slot.history.addSystem(warn(`! runs on this machine — this session is on ${link.host.label}`));
                tui.requestRender();
                return;
            }
            if (isCommand) {
                slot.history.addCommand(text);
                if (GO_LOCAL.has(command!)) {
                    // A fresh local session to land in; /resume then fills it.
                    await deps.sessions.openNew();
                    if (command === "new" || command === "clear") return;
                } else if (!REMOTE_OK.has(command!)) {
                    slot.history.addSystem(
                        warn(`/${command} acts on this machine — this session is on ${link.host.label}. `) +
                            dim("/hosts → This machine to go back."),
                    );
                    tui.requestRender();
                    return;
                }
                try {
                    await host.commands.run(text, host.ctx);
                } catch (e) {
                    deps.history.addError(formatError(e));
                }
                tui.requestRender();
                return;
            }

            slot.history.addUser(text);
            d.scrollTranscriptToEnd();
            if (!link.title) link.title = text.split("\n")[0]!.slice(0, 80);
            sentHere.add(slot);
            beginTurn(slot);
            tui.requestRender();
            try {
                await link.client.call("session.send", { sessionId: link.sessionId, input: text, model: link.model });
            } catch (e) {
                const turn = turns.get(slot);
                turn?.errors.push(e);
                endTurn(slot);
            }
        };
    roster.setRemoteRunner(remoteRunner);

    /** Open (or go to) one of a host's sessions. */
    const openRemote = async (
        record: RemoteHostRecord,
        client: RemoteHostClient,
        sessionId: string,
    ): Promise<void> => {
        const live = slots.all().find((s) => s.remote?.host.id === record.id && s.remote.sessionId === sessionId);
        if (live) {
            slots.switchTo(live);
            return;
        }
        let history: RemoteHistory;
        try {
            history = await client.call<RemoteHistory>("session.history", { sessionId });
        } catch (e) {
            say(err(`${record.label}: ${formatError(e)}`));
            return;
        }
        const cwd = history.info.cwd;
        const chat = new ChatHistory(tui, cwd);
        const todoPanel = new TodoPanel();
        let unsubscribe = () => {};
        const link: RemoteLink = {
            host: record,
            client,
            sessionId,
            title: history.name || firstUserText(history.entries),
            model: history.model,
            seq: history.seq,
            dispose: () => unsubscribe(),
        };
        const template = slots.foreground;
        const slot = slots.add({
            cwd,
            modelId: history.model,
            provider: providerOf(history.model) as never,
            thinkingLevel: template.thinkingLevel,
            agent: template.agent,
            oneShotAgent: null,
            session: null,
            latestContextTokens: 0,
            busy: false,
            abort: new AbortController(),
            pendingInjection: null,
            startupHooksDone: null,
            pendingPlan: null,
            planModeViaCycle: false,
            history: chat,
            todoPanel,
            tracker: new CostTracker(),
            remote: link,
        });
        chat.addSystem(accent(`${record.label}`) + dim(` · ${cwd} · session ${sessionId}`));
        renderBranchEntries(history.entries, sessionId, chat, history.model, todoPanel);
        unsubscribe = client.onSessionEvent(sessionId, (e) => onEvent(slot, e));
        slots.switchTo(slot);
        try {
            const res = await client.call<{ running: boolean; resync: boolean; seq: number }>("session.attach", {
                sessionId,
                afterSeq: history.seq,
            });
            if (res.running && !slot.busy) {
                sentHere.add(slot); // not news: it was running when opened
                beginTurn(slot);
            }
        } catch (e) {
            chat.addError(`${record.label}: ${formatError(e)}`);
        }
        tui.requestRender();
    };

    /** A new session on `record`, in the folder and on the model it last used. */
    const newRemote = async (record: RemoteHostRecord, client: RemoteHostClient, rows: RemoteSessionRow[]) => {
        const latest = rows[0];
        let model = latest?.lastModel ?? latest?.model ?? "";
        if (!model) {
            model = (await deps.promptOnce(`Model to use on ${record.label} (provider/model)`)).trim();
            if (!model) return;
        }
        let cwd = latest?.cwd;
        const folder = (await deps.promptOnce(`Folder on ${record.label}`, cwd ?? "")).trim();
        if (folder) cwd = folder;
        try {
            const { sessionId } = await client.call<{ sessionId: string }>("session.create", {
                ...(cwd ? { cwd } : {}),
                provider: providerOf(model),
                model,
            });
            await openRemote(record, client, sessionId);
        } catch (e) {
            say(err(`${record.label}: ${formatError(e)}`));
        }
    };

    const showHostSessions = async (record: RemoteHostRecord): Promise<void> => {
        const client = clientFor(record);
        // A page at a time, like /resume; the picker asks for more as you go.
        const page = (offset: number) =>
            client.call<RemoteSessionRow[]>("session.list", { limit: HOST_PAGE, offset });
        let rows: RemoteSessionRow[];
        try {
            rows = await page(0);
        } catch (e) {
            say(err(`${record.label}: ${formatError(e)}`));
            return;
        }
        // A host older than paging ignores `limit` and sends everything.
        let more = rows.length === HOST_PAGE;
        rows.sort((a, b) => b.mtime - a.mtime);
        const NEW = "\x00new";
        const FORGET = "\x00forget";
        const now = Date.now();
        const row = (r: RemoteSessionRow): SelectItem => {
                const live = slots.all().find((s) => s.remote?.host.id === record.id && s.remote.sessionId === r.id);
                const glyph = r.running ? accent("●") : live ? dim("○") : " ";
                const title = r.name || r.firstUserMessage?.replace(/\s+/g, " ").slice(0, 80) || "(no messages)";
                return {
                    value: r.id,
                    label: `${glyph} ${title}`,
                    description: `${live ? "open here · " : ""}${basename(r.cwd)} · ${r.lastModel ?? r.model ?? "?"} · ${formatAge(now - r.mtime)}`,
                };
        };
        // The fixed rows lead: the sessions below keep growing as you scroll.
        const items: SelectItem[] = [
            { value: NEW, label: "+ New session", description: `runs on ${record.label}` },
            { value: FORGET, label: dim("Forget this machine"), description: `remove ${record.label} from /hosts` },
            ...rows.map(row),
        ];
        const pick = await deps.searchOnce(items, `${record.label} · ${rows.length}${more ? "+" : ""} sessions`, {
            loadMore: async () => {
                if (!more) return [];
                const next = await page(rows.length).catch(() => [] as RemoteSessionRow[]);
                more = next.length === HOST_PAGE;
                rows.push(...next);
                return next.map(row);
            },
        });
        if (!pick) return;
        if (pick.value === NEW) return newRemote(record, client, rows);
        if (pick.value === FORGET) return forget(record.id);
        await openRemote(record, client, pick.value);
    };

    const forget = (idOrLabel: string): void => {
        const removed = removeRemoteHost(idOrLabel);
        if (!removed) {
            say(warn(`no paired machine called ${idOrLabel}`));
            return;
        }
        clients.get(removed.id)?.close();
        clients.delete(removed.id);
        say(`forgot ${removed.label}` + dim(" — its open sessions here stay until you leave them"));
    };

    const pair = async (input: string): Promise<void> => {
        const [linkText, tokenText] = input.trim().split(/\s+/);
        let link = parsePairingLink(linkText ?? "", tokenText);
        if (!link && linkText) {
            const token = (await deps.promptOnce(`Token for ${linkText}`)).trim();
            link = parsePairingLink(linkText, token);
        }
        if (!link) {
            say(warn("that is not a pairing link — paste the URL `loop serve` or /rc prints, with its token"));
            return;
        }
        say(dim(`pairing ${link.url}…`));
        try {
            const record = await pairRemoteHost(link);
            say(ok(`paired ${record.label}`) + dim(` (${record.url}) — /hosts to open its sessions`));
        } catch (e) {
            say(err(`could not pair: ${formatError(e)}`));
        }
    };

    /** Back to a session on this machine: the latest local one, else a new one. */
    const goLocal = async (): Promise<void> => {
        if (!slots.foreground.remote) {
            say(dim("already on this machine — /resume lists its sessions"));
            return;
        }
        const local = [...slots.all()].filter((s) => !s.remote).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
        if (local) slots.switchTo(local);
        else await deps.sessions.openNew();
    };

    const manageHosts = async (args: string): Promise<void> => {
        const [sub, ...rest] = args.trim().split(/\s+/);
        const arg = rest.join(" ");
        if (sub === "add" || sub === "pair") {
            const input = arg || (await deps.promptOnce("Pairing link (what `loop serve` or /rc prints there)"));
            if (input.trim()) await pair(input);
            return;
        }
        if (sub === "remove" || sub === "forget") {
            if (!arg) say(warn("/hosts remove <name>"));
            else forget(arg);
            return;
        }
        if (sub && /^(https?:\/\/|[\w.-]+:\d+)/.test(sub)) {
            await pair(args);
            return;
        }

        const hosts = listRemoteHosts();
        // Who is up, asked of every host at once and briefly: a list that
        // waits on the slowest machine is a list nobody opens twice.
        const reach = await Promise.all(
            hosts.map((h) =>
                probeRemoteHost(h.url, { timeoutMs: 1500 }).then(
                    () => true,
                    () => false,
                ),
            ),
        );
        const LOCAL = "\x00local";
        const PAIR = "\x00pair";
        const onScreen = slots.foreground.remote?.host.id;
        const localLive = slots.all().filter((s) => !s.remote).length;
        const items: SelectItem[] = [
            {
                value: LOCAL,
                label: `${onScreen ? " " : accent("●")} This machine`,
                description: `${onScreen ? "" : "here · "}${localLive} live session${localLive === 1 ? "" : "s"}${rc ? " · rc on" : ""}`,
            },
            ...hosts.map((h, i) => {
                const open = slots.all().filter((s) => s.remote?.host.id === h.id).length;
                return {
                    value: h.id,
                    label: `${onScreen === h.id ? accent("●") : reach[i] ? ok("○") : err("○")} ${h.label}`,
                    description: `${onScreen === h.id ? "here · " : ""}${reach[i] ? "online" : "offline"} · ${h.url.replace(/^https?:\/\//, "")}${open ? ` · ${open} open here` : ""}`,
                };
            }),
            { value: PAIR, label: "+ Pair a machine", description: "paste the link `loop serve` or /rc prints there" },
        ];
        const pick = await deps.selectOnce(items, `Machines · ${hosts.length + 1}`);
        if (!pick) return;
        if (pick.value === LOCAL) return goLocal();
        if (pick.value === PAIR) return manageHosts("add");
        const record = hosts.find((h) => h.id === pick.value);
        if (record) await showHostSessions(record);
    };

    // ── /rc: this machine as a host ───────────────────────────────────────

    /**
     * This loop's open sessions, as the `/rc` server sees them: a client's
     * message to one is typed into it here (shown on screen, queued if a turn
     * is running), and its turns stream back out through `deps.live.feed`.
     * One stream, every screen. Sessions not open here the server runs itself.
     */
    const liveSessions: LiveSessionProvider = {
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

    const printReach = (opts: { freshCode?: boolean } = {}): void => {
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
                rcTerminal
                    ? "terminal: offered to paired devices"
                    : "terminal: this machine only — turn on \"terminal for other devices\" in /settings, then /rc off and /rc",
            ),
            warn("Anyone with this link fully controls this machine. ") + dim("/rc off stops it."),
        ];
        say(lines.join("\n"));
    };

    const remoteControl = async (args: string): Promise<void> => {
        const sub = args.trim();
        if (sub === "off" || sub === "stop") {
            if (!rc) say(dim("remote control is not on"));
            else {
                deps.live.feed = null;
                rc.stop();
                rc = null;
                say("remote control off");
            }
            return;
        }
        if (rc) {
            printReach({ freshCode: true });
            return;
        }
        // The same consent `loop serve` asks for, given here instead of in
        // /settings: this exposes the machine to whoever holds the link.
        if (!getSetting("serve")) {
            const pick = await deps.selectOnce(
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
            if (pick?.value !== "on" && pick?.value !== "chat") return;
            setSetting("serve", true);
            if (pick.value === "chat") setSetting("serveTerminal", false);
        }
        // Reachable from the phone means a network bind; the token is the lock.
        const bind = /--local\b/.test(sub) ? "127.0.0.1" : "0.0.0.0";
        rcTerminal = remoteTerminalFor(
            { terminal: /--terminal\b/.test(sub), "no-terminal": /--no-terminal\b/.test(sub) },
            getSetting("serveTerminal"),
        );
        let lastError: unknown;
        for (let port = SERVE_DEFAULT_PORT; port < SERVE_DEFAULT_PORT + 5 && !rc; port++) {
            // macOS lets 127.0.0.1:N bind beside another process's *:N, and
            // then the two answer the same port in turn. Skip a port anything
            // already answers on — usually a `loop serve` started elsewhere.
            if (await portAnswers(port)) continue;
            try {
                rc = startWebServer({
                    host: bind,
                    port,
                    // The app's terminal, for other devices: on unless
                    // /settings turned it off (`/rc --terminal` overrides
                    // that for this run, `/rc --no-terminal` the reverse).
                    remoteTerminal: rcTerminal,
                    ...(host.version ? { version: host.version } : {}),
                    live: liveSessions,
                });
            } catch (e) {
                lastError = e;
            }
        }
        if (!rc) {
            say(err(`could not start remote control: ${formatError(lastError)}`));
            return;
        }
        // From here, every turn in this loop streams to remote clients too.
        deps.live.feed = rc.live;
        if (!lanAddresses().length && bind === "0.0.0.0") say(dim("no network address found — reachable from this machine only"));
        printReach();
    };

    return {
        manageHosts,
        remoteControl,
        dispose: () => {
            for (const c of clients.values()) c.close();
            clients.clear();
            deps.live.feed = null;
            rc?.stop();
            rc = null;
        },
    };
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

/** The first thing the user said in a branch — a title for a session with no name. */
function firstUserText(entries: Entry[]): string {
    for (const e of entries) {
        if (e.type === "message" && e.role === "user") return String(e.content ?? "").split("\n")[0]!.slice(0, 80);
    }
    return "";
}
