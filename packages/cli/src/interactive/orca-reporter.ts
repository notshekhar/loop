/**
 * Orca integration — mirrors this pane's agent activity into Orca
 * (https://orca.dev), the app that runs coding agents side by side in their
 * own worktrees. Orca shows each pane's state on its workspace card, pings the
 * phone app when an agent needs you, and restarts the agent's session when a
 * sleeping workspace wakes.
 *
 * Orca gives every pane it starts a hook endpoint in the environment
 * (ORCA_AGENT_HOOK_PORT / _TOKEN, the pane's ORCA_PANE_KEY) and expects each
 * agent to POST its lifecycle events to `/hook/<agent>`. Most agents need an
 * installed hook file for that; loop already emits Claude Code–shaped hook
 * events on its own bus, so this is a pipe: each one goes to `/hook/loop`
 * with Claude's field names, which Orca reads with its Claude-compatible
 * normalizer. Nothing to install.
 *
 * Orca rewrites the file named by ORCA_AGENT_HOOK_ENDPOINT when it restarts
 * its listener, so the port and token are read from it on every post (and only
 * fall back to the env) — the same order Orca's own Pi extension uses.
 *
 * Hard-gated on the env Orca injects; outside Orca nothing is ever sent.
 * Fire-and-forget with a short timeout: a slow or closed Orca must never add
 * latency to a turn. Events are posted in order, one at a time.
 */
import { readFileSync } from "node:fs";
import { hookBus, type HookPayload } from "@notshekhar/loop-core";
import type { AgentStatusBus } from "./agent-status";
import { bounded } from "./bounded-json";

/** The hook route Orca reads loop's events on. */
const HOOK_PATH = "/hook/loop";
/** A status update is not worth waiting on. */
const POST_TIMEOUT_MS = 1_000;
/** Backlog cap: Orca being slow must not become loop's memory leak. */
const MAX_QUEUED = 64;

export interface OrcaReporter {
    readonly active: boolean;
    /** Stop reporting and let queued events land. Bounded-time. */
    release(): Promise<void>;
}

export interface OrcaReporterOptions {
    /** The live session id, read at send time — Orca resumes it by this id. */
    getSessionId: () => string | undefined;
    cwd: () => string;
    /** Test seams — default to process.env and the real fetch. */
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
}

const INERT: OrcaReporter = { active: false, release: () => Promise.resolve() };

interface HookCoords {
    port?: string;
    token?: string;
    env: string;
    version: string;
}

/** KEY=VALUE lines (or Windows `set KEY=VALUE`) from Orca's endpoint file. */
function readEndpointFile(path: string | undefined): Record<string, string> {
    if (!path) return {};
    try {
        const out: Record<string, string> = {};
        for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
            const m = /^(?:set\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
            if (m) out[m[1]] = m[2];
        }
        return out;
    } catch {
        return {};
    }
}

function resolveCoords(env: NodeJS.ProcessEnv): HookCoords {
    const file = readEndpointFile(env.ORCA_AGENT_HOOK_ENDPOINT);
    return {
        port: file.ORCA_AGENT_HOOK_PORT || env.ORCA_AGENT_HOOK_PORT,
        token: file.ORCA_AGENT_HOOK_TOKEN || env.ORCA_AGENT_HOOK_TOKEN,
        env: file.ORCA_AGENT_HOOK_ENV || env.ORCA_AGENT_HOOK_ENV || "",
        version: file.ORCA_AGENT_HOOK_VERSION || env.ORCA_AGENT_HOOK_VERSION || "",
    };
}

/** loop's hook payload in Claude Code's field names. */
export function toClaudePayload(payload: HookPayload, sessionId: string | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = { hook_event_name: payload.hook_event_name, cwd: payload.cwd };
    if (sessionId) out.session_id = sessionId;
    switch (payload.hook_event_name) {
        case "SessionStart":
            // Orca settles a pane to idle only on a known start source.
            out.source = typeof payload.source === "string" ? payload.source : "startup";
            break;
        case "UserPromptSubmit":
            out.prompt = bounded(typeof payload.prompt === "string" ? payload.prompt : "");
            break;
        case "PreToolUse":
        case "PostToolUse":
            out.tool_name = payload.tool_name;
            out.tool_input = bounded(payload.tool_input);
            if (payload.hook_event_name === "PostToolUse") out.tool_response = bounded(payload.tool_output);
            break;
        case "Stop":
            if (typeof payload.last_assistant_message === "string") {
                out.last_assistant_message = bounded(payload.last_assistant_message, 2_000);
            }
            out.stop_hook_active = payload.stop_hook_active === true;
            break;
        case "SessionEnd":
            out.reason = payload.reason;
            break;
        default:
            break;
    }
    return out;
}

export function attachOrcaReporter(bus: AgentStatusBus | null, opts: OrcaReporterOptions): OrcaReporter {
    const env = opts.env ?? process.env;
    const paneKey = env.ORCA_PANE_KEY;
    const reachable = !!env.ORCA_AGENT_HOOK_PORT || !!env.ORCA_AGENT_HOOK_ENDPOINT;
    if (!paneKey || !reachable) return INERT;
    const doFetch = opts.fetch ?? fetch;

    let released = false;
    const queue: Record<string, unknown>[] = [];
    let draining: Promise<void> | null = null;

    async function postOnce(payload: Record<string, unknown>): Promise<void> {
        const coords = resolveCoords(env);
        if (!coords.port || !coords.token) return;
        const body = JSON.stringify({
            paneKey,
            launchToken: env.ORCA_AGENT_LAUNCH_TOKEN || "",
            tabId: env.ORCA_TAB_ID || "",
            worktreeId: env.ORCA_WORKTREE_ID || "",
            env: coords.env,
            version: coords.version,
            payload,
        });
        await doFetch(`http://127.0.0.1:${coords.port}${HOOK_PATH}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Orca-Agent-Hook-Token": coords.token },
            body,
            signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
    }

    async function drain(): Promise<void> {
        while (queue.length > 0) {
            try {
                await postOnce(queue.shift()!);
            } catch {
                // Orca closed or slow: this row is lost, the next one still goes.
            }
        }
        draining = null;
    }

    function post(payload: Record<string, unknown>): void {
        if (released) return;
        if (queue.length >= MAX_QUEUED) queue.shift();
        queue.push(payload);
        draining ??= drain();
    }

    const onHookEvent = (payload: HookPayload): void => {
        try {
            post(toClaudePayload(payload, opts.getSessionId()));
        } catch {
            // A watcher that throws must not reach the agent's turn.
        }
    };
    hookBus.on("event", onHookEvent);

    // An approval or question open in the TUI is what Orca calls "needs you":
    // it raises the workspace card and pings the phone. Claude reports it as
    // PermissionRequest; the next tool event or Stop moves the pane on again.
    bus?.on((e) => {
        if (e.status !== "blocked") return;
        post({
            hook_event_name: "PermissionRequest",
            session_id: opts.getSessionId(),
            cwd: opts.cwd(),
            tool_name: e.label ?? "approval",
        });
    });

    return {
        active: true,
        release() {
            if (released) return Promise.resolve();
            released = true;
            hookBus.off("event", onHookEvent);
            return draining ?? Promise.resolve();
        },
    };
}
