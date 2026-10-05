/**
 * cmux integration — mirrors this pane's agent activity into cmux's Feed and
 * lets cmux answer the prompts loop would otherwise only ask in the TUI
 * (https://cmux.com). cmux is a terminal that watches the agents running
 * inside it; without a report it sees loop as an anonymous shell process, so
 * the sidebar shows nothing and its approval cards never appear.
 *
 * The bridge is cmux's `feed.push` verb over its unix socket, and the frames
 * it carries are Claude Code–shaped hook payloads — the exact shape loop's own
 * hooks already emit. So this file is mostly a pipe: `hookBus` reports every
 * dispatched lifecycle event (configured hook commands or not), and each one
 * goes out as a feed event under `_source: "loop"`. No hook commands to
 * install, no cmux-side install step, nothing to keep in sync but the socket.
 *
 * Two request kinds are more than telemetry. An event pushed with a request id
 * PARKS the connection: cmux shows an actionable card (permission / question /
 * plan), and answering it in the sidebar — or in the notification's inline
 * buttons — sends the decision back down that same connection. Approvals then
 * race: whichever of cmux and the TUI answers first wins, and the loser is
 * closed. Without a request id the push is telemetry and acks immediately.
 * Measured contract, per card kind:
 *
 *   → {method:"feed.push", params:{event, wait_timeout_seconds}}
 *   ← {ok:true, result:{status:"acknowledged"}}                     // telemetry
 *   ← {ok:true, result:{status:"resolved", decision:{kind:"permission", mode}}}
 *   ← {ok:true, result:{status:"resolved", decision:{kind:"question", selections}}}
 *   ← {ok:true, result:{status:"resolved", decision:{kind:"exit_plan", mode, feedback?}}}
 *
 * Hard-gated on the env cmux injects into every pane (CMUX_SURFACE_ID plus a
 * socket path): outside cmux nothing subscribes and no socket is ever opened.
 * Telemetry is fire-and-forget over short-lived connections with a hard
 * timeout — a dead or restarted cmux must never add latency to a turn — and
 * rides a queue so events reach the Feed in the order they happened.
 *
 * The Feed is only half of it. What you actually SEE in cmux — the agent
 * status chip in the sidebar, and the notification when a turn finishes — is
 * driven by a different, older channel: line-delimited V1 commands on the same
 * socket, `set_status` / `notify_target`, each line prefixed with the
 * capability cmux exports into its own panes. That channel is not enum-gated,
 * so loop appears there under its own name. The states, icons and colours
 * below are the ones cmux's built-in agent hooks use, so a loop pane reads
 * identically to a Claude Code pane.
 *
 * One thing still needs a change on cmux's side (docs/cmux-upstream.md): its
 * feed `source` is a closed enum, so Feed ROWS are stored under the default
 * `claude` label even though the events stream keeps `_source: "loop"`. The
 * status chip, the notifications and the cards themselves are unaffected.
 */
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookBus, type HookPayload } from "@notshekhar/loop-core";
import type { AgentStatusBus, AgentStatusEvent } from "./agent-status";

/** How loop names itself to cmux. */
const SOURCE = "loop";
/** cmux's documented default; panes get CMUX_SOCKET_PATH instead. */
const DEFAULT_SOCKET = join(homedir(), ".config", "cmux", "cmux.sock");
/** cmux parks a card for at most ~120s (its docs/feed.md), then answers
 * nothing and expects the agent to fall back to its own prompt — which for
 * loop means the TUI menu that was showing the whole time anyway. */
const DECISION_WAIT_SECONDS = 120;
/** Telemetry is not worth waiting on: ack or give up. */
const ACK_TIMEOUT_MS = 500;
/** Cap on any single serialized field — cmux stores what we send. */
const MAX_FIELD_BYTES = 8_000;
/** Backlog cap: cmux being slow must not become loop's memory leak. */
const MAX_QUEUED = 64;

/** The key our status entry lives under in the pane's sidebar. */
const STATUS_KEY = SOURCE;
/** Prefix that authenticates a V1 line, using the capability cmux exports. */
const CAPABILITY_PREFIX = "_cmux_capability_v1";

/**
 * How each agent state looks in the sidebar. Same SF Symbols and colours as
 * cmux's own agent hooks, so loop sits beside Claude Code without looking
 * like a different species. `priority` floats a waiting agent to the top,
 * which is what makes "this one needs you" findable across many panes.
 */
const STATUS_STYLE: Record<AgentStatusEvent["status"], { icon: string; color: string; priority?: number }> = {
    working: { icon: "bolt.fill", color: "#4C8DFF" },
    blocked: { icon: "bell.fill", color: "#4C8DFF", priority: 100 },
    idle: { icon: "pause.circle.fill", color: "#8E8E93" },
};

export type CmuxPermissionMode = "once" | "always" | "all" | "bypass" | "deny";

export interface CmuxPermissionDecision {
    kind: "permission";
    mode: CmuxPermissionMode;
}

export interface CmuxQuestionDecision {
    kind: "question";
    selections: string[];
}

export interface CmuxExitPlanDecision {
    kind: "exit_plan";
    /** manual | autoAccept | bypassPermissions | deny | ultraplan */
    mode: string;
    feedback?: string;
}

export type CmuxDecision = CmuxPermissionDecision | CmuxQuestionDecision | CmuxExitPlanDecision;

export interface CmuxSessionRef {
    id: string;
    path: string | null;
}

/** One approval, in cmux's terms rather than the TUI's. */
export interface CmuxApprovalRequest {
    /** "exit-plan" becomes an ExitPlanMode card; everything else a permission card. */
    kind: "bash" | "path" | "plan" | "exit-plan";
    /** Tool the approval is for ("bash", "write", …) — the card's title. */
    toolName: string;
    /** The command / path / plan the user is being asked about. */
    body: string;
    /** Extra context line (the tool's own title, when it has one). */
    title?: string;
    /** Patterns an "always" decision would remember. */
    patterns?: string[];
}

export interface CmuxQuestion {
    header: string;
    question: string;
    multiSelect?: boolean;
    options: { label: string; description?: string }[];
}

export interface CmuxReporter {
    /** True when running inside a cmux pane with reporting enabled. */
    readonly active: boolean;
    /** Ask cmux to decide an approval. Resolves null when it doesn't (not
     * running under cmux, nobody answered, the caller aborted). */
    requestApproval(
        req: CmuxApprovalRequest,
        signal?: AbortSignal,
    ): Promise<CmuxPermissionDecision | CmuxExitPlanDecision | null>;
    /** Ask cmux to answer the ask tool's questions; null when it doesn't. */
    requestQuestions(questions: CmuxQuestion[], signal?: AbortSignal): Promise<string[] | null>;
    /** Clear the status chip and flush pending telemetry. Bounded-time. */
    release(): Promise<void>;
}

export interface CmuxReporterOptions {
    /** Read the live session lazily — called at send time, never cached. */
    getSession: () => CmuxSessionRef | null;
    /** The pane's working directory, read at send time — /cd moves it. */
    cwd: () => string;
    /** The `cmux` setting turned the integration off. */
    disabled?: boolean;
    /** Test seams — default to process.env and production timings. */
    env?: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
    decisionWaitSeconds?: number;
}

/** An inert reporter — what everything outside cmux gets. */
const INERT: CmuxReporter = {
    active: false,
    requestApproval: () => Promise.resolve(null),
    requestQuestions: () => Promise.resolve(null),
    release: () => Promise.resolve(),
};

/** The pane-wide reporter, for the seams that can't be handed one (the
 * approval and ask bridges are built before it exists). */
let current: CmuxReporter = INERT;
export function setCmuxReporter(reporter: CmuxReporter): void {
    current = reporter;
}
export function cmux(): CmuxReporter {
    return current;
}

/** JSON-safe, and small enough that a 3MB tool result can't ride the socket. */
function bounded(value: unknown, maxBytes = MAX_FIELD_BYTES): unknown {
    if (value === undefined || value === null) return value;
    let json: string;
    try {
        json = JSON.stringify(value) ?? "";
    } catch {
        return undefined; // circular / unserializable — the field is optional
    }
    if (json.length <= maxBytes) return value;
    if (typeof value === "string") return `${value.slice(0, maxBytes)}… [truncated by ${SOURCE}]`;
    return { truncated: true, bytes: json.length, preview: `${json.slice(0, 1_000)}…` };
}

export function attachCmuxReporter(bus: AgentStatusBus | null, opts: CmuxReporterOptions): CmuxReporter {
    const env = opts.env ?? process.env;
    const surfaceId = env.CMUX_SURFACE_ID;
    const workspaceId = env.CMUX_WORKSPACE_ID;
    const socketPath = env.CMUX_SOCKET_PATH || (surfaceId ? DEFAULT_SOCKET : undefined);
    // CMUX_SURFACE_ID is the pane identity cmux injects; without it we are not
    // in a cmux terminal, whatever else the environment inherited.
    const active = !opts.disabled && !!surfaceId && !!socketPath;
    if (!active) return INERT;

    const connectTimeoutMs = opts.connectTimeoutMs ?? 2_000;
    const waitSeconds = opts.decisionWaitSeconds ?? DECISION_WAIT_SECONDS;

    let seq = 0;
    const nextRequestId = (kind: string): string => `${SOURCE}-${kind}-${Date.now()}-${++seq}`;

    /**
     * One request per connection: cmux answers a parked card on the same
     * socket it was pushed over, so a decision cannot outlive its connection
     * — and a telemetry push has nothing to keep one open for.
     */
    function push(
        event: Record<string, unknown>,
        wait: { requestId: string; seconds: number; signal?: AbortSignal } | null,
    ): Promise<CmuxDecision | null> {
        return new Promise((resolve) => {
            let settled = false;
            let buffer = "";
            const finish = (decision: CmuxDecision | null): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                wait?.signal?.removeEventListener("abort", onAbort);
                socket.destroy();
                resolve(decision);
            };
            const onAbort = (): void => finish(null);

            const frame = {
                id: `${SOURCE}-${wait?.requestId ?? `t${++seq}`}`,
                method: "feed.push",
                params: { event, wait_timeout_seconds: wait ? wait.seconds : 0 },
            };

            const socket = createConnection(socketPath!);
            socket.setEncoding("utf8");
            socket.on("error", () => finish(null));
            socket.on("close", () => finish(null));
            socket.on("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
            socket.on("data", (chunk: string | Buffer) => {
                buffer += chunk.toString();
                let nl: number;
                while ((nl = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, nl);
                    buffer = buffer.slice(nl + 1);
                    if (!line.trim()) continue;
                    let msg: { result?: { status?: string; decision?: CmuxDecision } } | undefined;
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        continue; // a frame we don't understand is not a reason to hang
                    }
                    if (msg?.result?.status === "resolved") {
                        finish(msg?.result?.decision ?? null);
                        return;
                    }
                    // Anything else ends a telemetry push (that ack is all it
                    // was waiting for) but not a parked one: a card cmux acks
                    // first and resolves later must still be answerable.
                    if (!wait) {
                        finish(null);
                        return;
                    }
                }
            });

            // Timeouts are the contract, not a safety net: cmux answers a card
            // it has no decision for by simply never answering.
            const timer = setTimeout(
                () => finish(null),
                wait ? wait.seconds * 1_000 + connectTimeoutMs : ACK_TIMEOUT_MS,
            );
            timer.unref?.();
            wait?.signal?.addEventListener("abort", onAbort);
        });
    }

    /**
     * One V1 command: a single line on the same socket, carrying the pane
     * capability cmux exported into this process. Fire-and-forget — the reply
     * is "OK" or an "ERROR: …" string nobody can act on mid-turn, and a status
     * update must never be something a turn waits for.
     */
    let released = false;
    const capability = env.CMUX_SOCKET_CAPABILITY;
    function v1(command: string): void {
        const line = capability ? `${CAPABILITY_PREFIX} ${capability} ${command}` : command;
        const socket = createConnection(socketPath!);
        const done = (): void => {
            socket.destroy();
        };
        socket.on("error", done);
        socket.on("data", done);
        socket.on("connect", () => socket.write(`${line}\n`));
        const timer = setTimeout(done, connectTimeoutMs);
        timer.unref?.();
    }

    /** Which pane the command is about. cmux calls a workspace a tab here. */
    const paneTarget = `--tab=${workspaceId ?? ""}${surfaceId ? ` --panel=${surfaceId}` : ""}`;

    /**
     * Safe on both wires: the V1 socket is line-delimited and notify's payload
     * is |-delimited, so a newline or a pipe would truncate the command. `--`
     * would be read as the start of a flag.
     */
    function wireText(value: string, max: number): string {
        const flat = value.replace(/\s+/g, " ").replace(/\|/g, "/").replace(/--/g, "—").trim();
        return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    }

    /** The chip in the pane's sidebar: what loop is doing, right now. */
    function reportStatus(e: AgentStatusEvent): void {
        if (released) return;
        const style = STATUS_STYLE[e.status];
        const label =
            e.status === "blocked"
                ? wireText(e.label ?? "needs input", 60)
                : e.status === "working"
                  ? "Working"
                  : "Idle";
        const priority = style.priority ? ` --priority=${style.priority}` : "";
        v1(`set_status ${STATUS_KEY} ${label} --icon=${style.icon} --color=${style.color}${priority} ${paneTarget}`);
    }

    /**
     * A native cmux notification, in the same categories its own agents use —
     * so the user's Settings > Notifications switches (turn complete, needs
     * permission) govern loop's exactly as they govern Claude Code's.
     */
    function notify(category: "turn-complete" | "needs-permission", body: string, opts_: { pending: boolean }): void {
        if (released || !workspaceId || !surfaceId) return;
        const subtitle = wireText(opts.cwd().split("/").pop() ?? "", 40);
        // EXACTLY `c=<category>;p=<0|1>`, and nothing else. cmux only treats
        // the 4th field as metadata when it parses as that whole grammar —
        // anything it cannot parse is folded back into the BODY, where the
        // user reads it as "…what are we building?|c=turn-complete;p=0".
        // Newer cmux accepts an `;a=<agent>` tail; shipped builds do not, and
        // the tail is only a hint for their notification hooks, so it is not
        // worth showing punctuation to everyone on an older build.
        const meta = `c=${category};p=${opts_.pending ? 1 : 0}`;
        v1(`notify_target ${workspaceId} ${surfaceId} ${SOURCE}|${subtitle}|${wireText(body, 240)}|${meta}`);
    }

    // Telemetry queue: one connection in flight, order preserved. Bounded, so
    // a cmux that stops accepting connections costs a few dropped rows in its
    // own sidebar rather than growing this process.
    const queue: (() => Promise<void>)[] = [];
    let draining = false;
    async function drain(): Promise<void> {
        draining = true;
        try {
            while (queue.length > 0) await queue.shift()!();
        } finally {
            draining = false;
        }
    }
    function enqueue(job: () => Promise<void>): void {
        if (queue.length >= MAX_QUEUED) queue.shift();
        queue.push(job);
        if (!draining) void drain();
    }

    /** cmux groups a pane's rows by session_id and expects the source's own
     * prefix on it (claude-<uuid>, opencode-<id>); ours reads loop-<uuid>. */
    const sessionId = (): string | undefined => {
        const s = opts.getSession();
        return s ? `${SOURCE}-${s.id}` : undefined;
    };

    /** What the user last asked for — cmux shows it as the card's context, so
     * an approval that arrives on a phone screen says what it is FOR. */
    let lastUserMessage: string | undefined;

    function baseEvent(): Record<string, unknown> {
        const event: Record<string, unknown> = {
            session_id: sessionId() ?? `${SOURCE}-${surfaceId}`,
            _source: SOURCE,
            _ppid: process.pid,
            cwd: opts.cwd(),
        };
        if (workspaceId) event.workspace_id = workspaceId;
        if (surfaceId) event.surface_id = surfaceId;
        if (lastUserMessage) event.context = { lastUserMessage };
        return event;
    }

    // ---- telemetry: loop's own hook events, forwarded verbatim ------------

    function forward(payload: HookPayload): void {
        const event = baseEvent();
        event.hook_event_name = payload.hook_event_name;
        // cwd travels per event: /cd moves the agent mid-session.
        if (typeof payload.cwd === "string") event.cwd = payload.cwd;

        switch (payload.hook_event_name) {
            case "UserPromptSubmit": {
                const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
                lastUserMessage = prompt.slice(0, 1_000);
                event.context = { lastUserMessage };
                event.tool_input = { prompt: bounded(prompt) };
                break;
            }
            case "PreToolUse":
            case "PostToolUse": {
                event.tool_name = payload.tool_name;
                event.tool_input = bounded(payload.tool_input);
                if (payload.hook_event_name === "PostToolUse") event.tool_result = bounded(payload.tool_output);
                break;
            }
            case "Notification": {
                event.message = bounded(payload.message, 1_000);
                break;
            }
            case "Stop": {
                // What the agent said, straight off the Stop payload: cmux
                // titles its turn-complete notification with it.
                const said = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
                if (said) event.last_assistant_message = bounded(said, 2_000);
                event.stop_hook_active = payload.stop_hook_active === true;
                // The turn ended — the notification the user is waiting for
                // when they have looked away. A stop-hook continuation is not
                // the end of anything, so it stays quiet.
                if (payload.stop_hook_active !== true) {
                    notify("turn-complete", said || "Turn finished", { pending: false });
                }
                break;
            }
            case "SessionEnd": {
                event.reason = payload.reason;
                break;
            }
            default:
                break;
        }
        enqueue(async () => {
            await push(event, null);
        });

        // The todo tool IS cmux's TodoWrite: the same list, under the name its
        // Feed already renders as a checklist. Sent alongside the tool row
        // rather than instead of it — the row is the activity, this is state.
        if (payload.hook_event_name === "PostToolUse" && payload.tool_name === "todo") {
            const todos = (payload.tool_input as { todos?: unknown })?.todos;
            if (Array.isArray(todos)) {
                const todoEvent = baseEvent();
                todoEvent.hook_event_name = "TodoWrite";
                todoEvent.tool_name = "TodoWrite";
                todoEvent.tool_input = bounded({ todos });
                enqueue(async () => {
                    await push(todoEvent, null);
                });
            }
        }
    }

    /**
     * Events that happened before this launch had a session to file them
     * under. loop creates its session on the first turn, but SessionStart
     * fires at boot — reporting that against the pane id would open a second,
     * near-empty workstream in cmux beside the real one, every launch. They
     * wait here instead and are replayed the moment a session exists, so a
     * launch is one workstream, the way it is for an agent whose session id
     * exists from the start. Bounded: a launch that never starts a turn has
     * nothing worth showing, and drops them at exit.
     */
    const pending: HookPayload[] = [];
    const MAX_PENDING = 32;

    const onHookEvent = (payload: HookPayload): void => {
        try {
            if (sessionId() === undefined) {
                if (pending.length < MAX_PENDING) pending.push(payload);
                return;
            }
            // A session appeared: everything held back belongs to it.
            if (pending.length > 0) {
                const held = pending.splice(0, pending.length);
                for (const p of held) forward(p);
            }
            forward(payload);
        } catch {
            // A watcher that throws must not reach the agent's turn.
        }
    };

    hookBus.on("event", onHookEvent);

    // The visible half: the sidebar chip follows the same working / blocked /
    // idle bus the herdr reporter reads, and a prompt the agent is stuck on
    // also raises a notification — the two things a cmux user expects to see
    // without looking at the terminal.
    if (bus) {
        bus.on((e) => {
            reportStatus(e);
            if (e.status === "blocked") {
                notify("needs-permission", e.label ?? "waiting for you", { pending: true });
            }
        });
        // Announce presence right away: the pane shows loop from launch
        // instead of staying blank until the first transition.
        reportStatus(bus.current());
    }

    // ---- actionable cards --------------------------------------------------

    async function requestDecision(
        event: Record<string, unknown>,
        kind: string,
        signal?: AbortSignal,
    ): Promise<CmuxDecision | null> {
        if (released || signal?.aborted) return null;
        const requestId = nextRequestId(kind);
        // The request id is what cmux keys the parked card by — and the field
        // name is a leftover from its first integration, not a typo.
        event._opencode_request_id = requestId;
        return await push(event, { requestId, seconds: waitSeconds, signal });
    }

    return {
        active,

        async requestApproval(req, signal) {
            const event = baseEvent();
            if (req.kind === "exit-plan") {
                event.hook_event_name = "ExitPlanMode";
                event.tool_name = "exit_plan_mode";
                event.tool_input = { plan: bounded(req.body, 32_000) };
                event.context = { ...(event.context as object), permissionMode: "plan" };
                const decision = await requestDecision(event, "plan", signal);
                return decision?.kind === "exit_plan" ? decision : null;
            }
            event.hook_event_name = "PermissionRequest";
            event.tool_name = req.toolName;
            event.tool_input = bounded({
                command: req.body,
                title: req.title,
                permission: req.kind,
                patterns: req.patterns ?? [],
            });
            const decision = await requestDecision(event, "permission", signal);
            return decision?.kind === "permission" ? decision : null;
        },

        async requestQuestions(questions, signal) {
            const event = baseEvent();
            event.hook_event_name = "AskUserQuestion";
            event.tool_name = "ask";
            event.tool_input = bounded({
                questions: questions.map((q, i) => ({
                    id: `q${i}`,
                    header: q.header,
                    question: q.question,
                    multiSelect: q.multiSelect === true,
                    options: q.options.map((o, oi) => ({
                        id: `opt${oi}`,
                        label: o.label,
                        description: o.description,
                    })),
                })),
            });
            const decision = await requestDecision(event, "question", signal);
            return decision?.kind === "question" && Array.isArray(decision.selections) ? decision.selections : null;
        },

        release() {
            if (released) return Promise.resolve();
            released = true;
            hookBus.off("event", onHookEvent);
            // Leave no stale chip behind: the pane is a plain terminal again.
            v1(`clear_status ${STATUS_KEY} ${paneTarget}`);
            // Let the queue land the SessionEnd row that exit just pushed.
            return new Promise((resolve) => {
                enqueue(async () => resolve());
            });
        },
    };
}
