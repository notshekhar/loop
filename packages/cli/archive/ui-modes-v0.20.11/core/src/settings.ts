/**
 * Typed access to ~/.loop/settings.json. One place declares every key and its
 * type — call sites get autocomplete and lose the `as X | undefined` casts.
 * Unknown/extra keys in the file are preserved untouched.
 */
import { settingsStore } from "./auth/storage";
import type { ThinkingLevel } from "./agent/thinking";
import type { HooksConfig } from "./agent/hooks";
import type { McpServerConfig } from "./mcp/config";
import type { BashDenyEntry } from "./tools/utils/command-deny";
import type { PermissionsSetting } from "./tools/utils/permission-rules";

export interface AppSettings {
    defaultModel?: string;
    /** Models Ctrl+P cycles through (full provider/model ids). Managed via /scoped-models. */
    scopedModels?: string[];
    theme?: string;
    /** Active UI mode ("experience"). Builtins: "noir" (default) and "loop"; extensions can register more. */
    uiMode?: string;
    /** Theme per UI mode, keyed by mode id (e.g. { grok: "night" }). Loop's theme stays on the legacy `theme` key. */
    uiThemes?: Record<string, string>;
    /**
     * Start in the active mode's LIVE variant — the transcript holds the
     * keyboard and runs of tool calls fold into one line. Only meaningful for
     * modes that define one (noir does; loop does not). ctrl+e flips between
     * the two at any time; this only chooses which you start in.
     */
    uiLive?: boolean;
    /**
     * How much of a finished tool call the transcript shows, for modes that
     * fold their output away (noir does; loop shows a preview regardless).
     *
     * - `compact` — the call and nothing else, one row each.
     * - `normal` (default) — plus a receipt saying what came back, and a few
     *   lines of the output itself.
     * - `full` — plus every call's output expanded.
     *
     * `d` cycles it inside transcript navigation. It is a density preference,
     * not a mode: it can only ever take away what the active mode already
     * offers, so a mode that shows no receipt is unaffected by `compact`.
     */
    toolDetail?: "compact" | "normal" | "full";
    /**
     * Pin the prompt to the last rows of the screen. The transcript then
     * scrolls in its own window above it, and the wheel moves only that
     * window — the prompt, the status line and the panels stay put.
     *
     * OFF (default): the prompt sits directly under the last message, the
     * way a shell prompt follows a command's output, and sinks to the bottom
     * as the conversation grows. Scrolling back moves the whole page.
     * Either way the chat is on the alternate screen and nothing is written
     * into the terminal until exit. Applies live from /settings.
     */
    pinnedInput?: boolean;
    /**
     * Interface chimes, and the terminal bell that rides along with them.
     *
     * - `off` — silent, bell included.
     * - `on` — the state changes you asked to be told about: a turn that
     *   finished or failed, the agent waiting on you, startup, a cancel.
     * - `max` — also the incidental ones (the slash menu opening, the input
     *   clearing), for people who like a keyboard that talks back.
     *
     * Defaults to `on` on macOS, which is the only platform with a player
     * (`afplay`); elsewhere the fallback is the terminal bell and sound stays
     * off until you ask for it. `/sound [on|off|max]` flips it live, and
     * `LOOP_SOUND` overrides it for one run without touching this file.
     */
    sound?: "off" | "on" | "max";
    thinkingLevel?: ThinkingLevel;
    maxSteps?: number;
    /**
     * How many times a turn may reopen a stream that died on a transient
     * provider failure (529/overloaded, rate limit, dropped socket) before it
     * reports the error. Only ever resumes between steps, so nothing already
     * shown is repeated. Default 2; 0 disables and restores the old behaviour
     * of ending the turn on the first stream error.
     */
    maxStreamResumes?: number;
    subagentMaxSteps?: number;
    /**
     * Abort a subagent when the PROVIDER goes silent for this many seconds
     * while we're waiting on it (a stalled stream that never errors). Only
     * armed between steps / during generation — never while the subagent's own
     * tools run, so a long build can't false-trip it. Deep-reasoning models
     * that stream nothing while thinking may need this raised. Default 180;
     * 0 disables.
     */
    subagentStallSeconds?: number;
    /** Master switch for the task tool (subagents). Default on. */
    subagents?: boolean;
    /**
     * Default model for subagents (full provider/model id). Precedence:
     * the agent file's `model:` > this setting > inherit the parent's model.
     * Unset = inherit. Validated at spawn time; falls back to the parent
     * model (with a visible warning) if unknown or unavailable.
     */
    subagentModel?: string;
    /**
     * How many subagents may stream from the provider at once when the model
     * fans out several task calls in one step. Excess runs queue (visibly) and
     * start as slots free up. Default 4; 0 = unlimited.
     */
    subagentMaxParallel?: number;
    /** Post-turn recap under responses that wrote/edited files. Default off. */
    recap?: boolean;
    /** Let the agent pause mid-turn to ask multiple-choice questions (ask
     * tool). Default OFF; interactive TUI only — never offered in print mode. */
    askUser?: boolean;
    /** Websearch tool backed by DuckDuckGo's HTML endpoint — no API key, but
     * unofficial: may rate-limit or break on markup changes. Default OFF. */
    webSearch?: boolean;
    /** `loop serve` — WebSocket RPC server + web UI. Remote code execution by
     * design: anyone with the URL+token controls this machine. Default OFF. */
    serve?: boolean;
    /** Todo tool: a visible checklist the agent maintains during multi-step
     * turns, pinned above the editor. Default OFF. */
    todos?: boolean;
    /** Artifacts: let the agent publish a document it wrote as a standalone
     * page under ~/.loop/artifacts, listed in the app and openable in a
     * browser. Default OFF — until it is on, the artifact tool is not offered
     * to the model at all. */
    artifacts?: boolean;
    /** Background shells: bash's `run_in_background`, the `shells` tool, and
     * promoting a foreground command that outruns its timeout instead of
     * killing it. Default OFF — until it is on, bash is strictly bounded and
     * nothing the agent runs can outlive its own tool call. Set true to let it
     * start servers, watchers and tails that keep going. */
    backgroundShells?: boolean;
    /** Live date + hh:mm:ss clock in the footer. Default off. */
    clock?: boolean;
    /** Fire /reminder alerts. Default on; set false to mute reminders entirely. */
    reminders?: boolean;
    autoCompactThreshold?: number;
    workspaceContext?: boolean;
    /** Agent memory: per-project markdown facts under ~/.loop/agent/memory/,
     * saved by the agent with its normal write tool and recalled via an
     * index-only prompt block. Default ON; set false to disable entirely. */
    memory?: boolean;
    /** Report agent state (working/blocked/idle + session) to herdr's socket
     * API when running inside a herdr pane. Only ever does anything under
     * herdr (HERDR_ENV). Default ON; set false to disable reporting. */
    herdr?: boolean;

    /** Mirror lifecycle events into cmux's Feed — and let cmux answer loop's
     * approval and ask prompts — when running inside a cmux pane. Only ever
     * does anything under cmux (CMUX_SURFACE_ID). Default ON; set false to
     * disable both the reporting and the remote answering. */
    cmux?: boolean;

    /** Report agent state (working/blocked/idle + session) to the notch app's
     * socket so a blocked pane is visible on the MacBook notch from any app.
     * Gated on the socket existing, so it does nothing unless the notch app is
     * running. Default ON; set false to disable reporting. */
    notch?: boolean;
    skills?: boolean;
    agent?: string;
    /** User-defined command aliases: name → expansion ("/model gpt …"). Managed via /alias. */
    aliases?: Record<string, string>;
    lastChangelogVersion?: string;
    // projectModels / projectProviderModels moved to the projects table
    // (sessions/projects.ts); the retired v0.9.0 store migration deleted the
    // keys from settings.json.
    /** Pull in hooks from ~/.claude (settings + plugins) and project .claude.
     * Default OFF — set true to opt in. */
    importClaudeHooks?: boolean;
    claudeHooksFilter?: string[];
    hooks?: HooksConfig;
    /** Master switch for MCP servers. Default ON — set false to disable entirely
     * (hides /mcp and skips auto-connect). Toggle via /settings. */
    mcp?: boolean;
    /** Connected MCP servers, keyed by display name. */
    mcpServers?: Record<string, McpServerConfig>;
    /**
     * Tool search for large MCP setups. Every MCP tool's name, description and
     * input schema rides EVERY request, so a couple of verbose servers can cost
     * more context than loop's entire builtin toolset before the model has read
     * a single file. Above the threshold, the individual tools stop being
     * advertised and the model reaches them through one `mcp_tools` tool that
     * searches and calls them instead.
     *
     * Number = the threshold in tools. `false` = never (always advertise
     * everything). `true` = always. Default: 50.
     */
    mcpToolSearch?: boolean | number;
    /**
     * Bash commands the agent is refused (a guardrail, not a sandbox). Entries
     * match by command name, optionally + subcommand ("git commit"). Omit the
     * key to use DEFAULT_BASH_DENY; set it (even to []) to take full control.
     */
    bashDeny?: BashDenyEntry[];
    /**
     * Permission rules layered over the tools: deny always wins, ask forces a
     * prompt, allow skips the bashApprove prompt. Rule strings use the
     * Claude-settings shape ("Bash(git *)", "Read(src/**)", bare "Read", "*").
     * Trusted projects add rules via <project>/CONFIG_DIR/settings.json under
     * the same key. See tools/utils/permission-rules.ts for matching semantics.
     */
    permissions?: PermissionsSetting;
    /**
     * Ask before every bash command (deny / allow once / always allow), like a
     * permission prompt. Default OFF — opt in via /settings for an extra
     * safeguard. Only active in interactive mode (needs the UI bridge); print
     * mode and RPC run unprompted as before.
     */
    bashApprove?: boolean;
    /**
     * Commands pre-approved for the bashApprove prompt ("always allow").
     * Same pattern shape as bashDeny: command name, optionally + subcommand
     * ("git status"). A command runs unprompted only when EVERY segment of the
     * command line matches an entry. Ignored while bashApprove is off.
     */
    bashAllow?: BashDenyEntry[];
    /**
     * OS-level sandbox for the bash tool (Seatbelt on macOS, bubblewrap on
     * Linux). Off unless `enabled`. Fail-open: if it can't be enforced the
     * command still runs, with a warning. Network is "deny" by default; a
     * per-domain allowlist is supported (see `network` below).
     */
    sandbox?: {
        enabled?: boolean;
        /**
         * Network policy. "allow" = full network, "deny" = none (default when
         * enabled), or a per-domain allowlist: `{ allow: ["*.github.com"],
         * deny?: ["*"] }` enforced by host-side proxies.
         */
        network?: "allow" | "deny" | { allow: string[]; deny?: string[] };
        /** Extra writable paths beyond defaults + the command's cwd. */
        allowWrite?: string[];
        /** Paths to deny writing even within writable regions. */
        denyWrite?: string[];
        /** Broad regions to deny reading. */
        denyRead?: string[];
        /** Re-allow reads within denied regions. */
        allowRead?: string[];
        /** Allow writes to .git/config (default false; .git/hooks always denied). */
        allowGitConfig?: boolean;
    };
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return settingsStore.get(key) as AppSettings[K];
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    settingsStore.set(key, value);
}
