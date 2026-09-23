/**
 * Settings & reload: /settings, /reload.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    CommandRegistry,
    CONFIG_DIR_NAME,
    DEFAULT_AGENT_NAME,
    agentExists,
    bustCatalogCache,
    canonicalProjectDir,
    closeAllPools,
    getCatalog,
    getMcpManager,
    getExtensionHost,
    getProjectBashAllow,
    playCue,
    PRODUCT_NAME,
    refreshConfigStores,
    registerBuiltins,
    settingsStore,
    soundLevel,
    type CommandContext,
    type SoundLevel,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { startMcpServers } from "../startup";
import { availableThemes, initTheme, initThemeFromSettings, theme } from "../ui/theme";
import { getToolDetail, setToolDetail, type ToolDetail } from "../ui/tool-detail";
import { applyCanvasWash } from "../ui/canvas-wash";
import { probeSystemScheme } from "../ui/system-scheme";
import { currentBashAllow, currentBashDeny, runBashAllowManager, runBashDenyManager } from "./bashdeny-handlers";
import { runPermissionsManager } from "./permission-handlers";
import { gatewaysStatusLabel, runGatewaysManager } from "./gateway-handlers";

/** Total rule count across the three actions, for the settings row label. */
function countPermissionRules(): number {
    const p = settingsStore.get("permissions") as { allow?: string[]; ask?: string[]; deny?: string[] } | undefined;
    return (p?.allow?.length ?? 0) + (p?.ask?.length ?? 0) + (p?.deny?.length ?? 0);
}

type SettingsHandlers = Pick<CommandContext, "openSettings" | "reload" | "switchTheme">;

export function createSettingsHandlers(state: AppState, deps: AppDeps): SettingsHandlers {
    const {
        tui,
        history,
        statusLine,
        commands,
        showWorking,
        hideWorking,
        selectOnce,
        searchOnce,
        promptOnce,
        refreshCommands,
    } = deps;

    // Boolean settings toggle in place; unset falls back to the default here.
    const BOOLEAN_DEFAULTS: Record<string, boolean> = {
        subagents: true,
        memory: true,
        recap: false,
        askUser: false,
        webSearch: false,
        serve: false,
        todos: false,
        artifacts: false,
        backgroundShells: false,
        clock: false,
        reminders: true,
        mcp: true,
        bashApprove: false,
        herdr: true,
        cmux: true,
        notch: true,
        pinnedInput: false,
    };
    const boolSetting = (key: string): boolean =>
        (settingsStore.get(key) as boolean | undefined) ?? BOOLEAN_DEFAULTS[key];

    /** Every theme that can be picked: what loop ships, what extensions
     * contribute, and the user's own files. */
    const themeNames = (): string[] => {
        const customDir = join(process.env.HOME ?? "", CONFIG_DIR_NAME, "agent", "themes");
        const custom = existsSync(customDir)
            ? readdirSync(customDir)
                  .filter((f) => f.endsWith(".json"))
                  .map((f) => f.replace(/\.json$/, ""))
            : [];
        return [...availableThemes().map((t) => t.name), ...custom];
    };

    /** Apply a theme and persist the choice. Unknown names are refused rather
     * than silently resolving to the fallback, which looks like a typo working. */
    const applyTheme = (name: string): boolean => {
        if (!themeNames().includes(name)) return false;
        settingsStore.set("theme", name);
        initTheme(name);
        applyCanvasWash();
        // `system` asks the terminal what it is, in the background, repainting
        // itself when the answer lands.
        probeSystemScheme(tui);
        tui.invalidate();
        history.addSystem(`theme → ${name}`);
        tui.requestRender(true);
        return true;
    };

    /** The picker both `/theme` and the `/settings` row open. */
    const pickTheme = async (): Promise<void> => {
        // What's actually rendering right now — not a settings-key
        // reconstruction (that's how the row label bug happened).
        const cur = theme.name;
        const items: SelectItem[] = themeNames().map((n) => ({
            value: n,
            label: n,
            description: n === cur ? "(current)" : "",
        }));
        const pick = await searchOnce(items, "Theme (type to filter)");
        if (pick) applyTheme(pick.value);
    };

    return {
        switchTheme(args) {
            const name = (args ?? "").trim();
            if (!name) {
                void pickTheme();
                return;
            }
            if (!applyTheme(name)) {
                history.addError(`unknown theme: ${name} (have: ${themeNames().join(", ")})`);
                tui.requestRender();
            }
        },
        async openSettings() {
            // Loop so Esc on the value prompt returns to the settings picker
            // instead of bailing out of /settings entirely. `lastIndex` re-opens
            // the picker on the row the user just acted on (toggles, value edits)
            // instead of snapping back to the top.
            let lastIndex = 0;
            while (true) {
                const items: SelectItem[] = [
                    // The ACTIVE theme's name — what is rendering right now,
                    // not a settings-key reconstruction (which is how the row
                    // label went wrong last time).
                    { value: "theme", label: `theme: ${theme.name}` },
                    { value: "toolDetail", label: `toolDetail: ${getToolDetail()}` },
                    {
                        value: "pinnedInput",
                        label: `pinned input: ${boolSetting("pinnedInput") ? "on" : "off"}`,
                        description:
                            "hold the prompt on the last rows; the transcript scrolls in its own window above it. off: the prompt follows the last message",
                    },
                    {
                        value: "sound",
                        label: `sound: ${soundLevel()}`,
                        description:
                            "chimes on a finished turn and when the agent needs you. max adds the incidental ones (menus, clearing the input)",
                    },
                    {
                        value: "maxSteps",
                        label: `maxSteps: ${(settingsStore.get("maxSteps") as number) || "unlimited"}`,
                    },
                    {
                        value: "autoCompactThreshold",
                        label: `autoCompactThreshold: ${settingsStore.get("autoCompactThreshold") ?? 0.8}`,
                    },
                    {
                        value: "workspaceContext",
                        label: `workspaceContext: ${settingsStore.get("workspaceContext") ?? true}`,
                    },
                    {
                        value: "subagents",
                        label: `subagents (task tool): ${boolSetting("subagents") ? "on" : "off"}`,
                        description: "let agents delegate work to subagents via the task tool",
                    },
                    {
                        value: "subagentModel",
                        label: `subagentModel: ${(settingsStore.get("subagentModel") as string) ?? "inherit"}`,
                        description:
                            "default model for subagents (an agent's own model: wins) — inherit = parent's model",
                    },
                    {
                        value: "subagentMaxParallel",
                        label: `subagentMaxParallel: ${(settingsStore.get("subagentMaxParallel") as number) ?? 4}`,
                        description: "concurrent subagent streams when tasks fan out (0 = unlimited)",
                    },
                    {
                        value: "memory",
                        label: `memory: ${boolSetting("memory") ? "on" : "off"}`,
                        description: `agent saves per-project facts across sessions (~/${CONFIG_DIR_NAME}/agent/memory)`,
                    },
                    {
                        value: "recap",
                        label: `recap: ${boolSetting("recap") ? "on" : "off"}`,
                        description: "short AI-generated recap under responses that changed files",
                    },
                    {
                        value: "askUser",
                        label: `ask user (questions tool): ${boolSetting("askUser") ? "on" : "off"}`,
                        description: "let the agent pause mid-turn to ask you multiple-choice questions",
                    },
                    {
                        value: "webSearch",
                        label: `websearch (DuckDuckGo): ${boolSetting("webSearch") ? "on" : "off"}`,
                        description:
                            "give the agent a websearch tool (scrapes DuckDuckGo — no API key, may rate-limit)",
                    },
                    {
                        value: "backgroundShells",
                        label: `background shells: ${boolSetting("backgroundShells") ? "on" : "off"}`,
                        description:
                            "let bash start servers/watchers that keep running (shells tool + panel); off bounds every command to its own call",
                    },
                    {
                        value: "serve",
                        label: `serve (web UI): ${boolSetting("serve") ? "on" : "off"}`,
                        description: `allow "${PRODUCT_NAME} serve" — token-locked web UI; anyone with the URL controls this machine`,
                    },
                    {
                        value: "todos",
                        label: `todos: ${boolSetting("todos") ? "on" : "off"}`,
                        description: "pinned checklist the agent maintains during multi-step tasks",
                    },
                    {
                        value: "artifacts",
                        label: `artifacts: ${boolSetting("artifacts") ? "on" : "off"}`,
                        description: "let the agent publish documents it writes as pages under ~/.loop/artifacts",
                    },
                    {
                        value: "clock",
                        label: `clock: ${boolSetting("clock") ? "on" : "off"}`,
                        description: "live date + hh:mm:ss in the status line",
                    },
                    {
                        value: "reminders",
                        label: `reminders: ${boolSetting("reminders") ? "on" : "off"}`,
                        description: "fire /reminder alerts; off mutes them without deleting any",
                    },
                    {
                        value: "mcp",
                        label: `mcp servers: ${boolSetting("mcp") ? "on" : "off"}`,
                        description: "connect configured MCP servers and expose their tools (/mcp to manage)",
                    },
                    {
                        value: "herdr",
                        label: `herdr reporting: ${boolSetting("herdr") ? "on" : "off"}`,
                        description:
                            "report working/blocked/idle to herdr panes (no-op outside herdr; applies next launch)",
                    },
                    {
                        value: "cmux",
                        label: `cmux integration: ${boolSetting("cmux") ? "on" : "off"}`,
                        description:
                            "mirror activity into cmux's Feed and let it answer approvals (no-op outside cmux; applies next launch)",
                    },
                    {
                        value: "notch",
                        label: `notch reporting: ${boolSetting("notch") ? "on" : "off"}`,
                        description:
                            "show working/blocked/idle on the MacBook notch (no-op unless the notch app is running; applies next launch)",
                    },
                    {
                        value: "bashDeny",
                        label: `bash denylist: ${currentBashDeny().length} blocked`,
                        description: "add/remove bash commands the agent is refused (guardrail)",
                    },
                    {
                        value: "permissions",
                        label: `permission rules: ${countPermissionRules()}`,
                        description: "allow/ask/deny rules over the tools (Bash(git *), Read(secrets/**), …)",
                    },
                    {
                        value: "bashApprove",
                        label: `bash approval: ${boolSetting("bashApprove") ? "on" : "off"}`,
                        description: "ask before every bash command — deny / allow once / always allow",
                    },
                    {
                        value: "bashAllow",
                        label: `bash allowlist: ${getProjectBashAllow(canonicalProjectDir(state.cwd)).length + currentBashAllow().length} always-allowed`,
                        description: "commands the approval prompt skips (“always allow” entries)",
                    },
                    {
                        value: "gateways",
                        label: `gateways: ${gatewaysStatusLabel()}`,
                        description:
                            "set up remote chat control — each gateway runs as its own daemon; a paired chat controls this machine",
                    },
                ];
                const pick = await searchOnce(items, "Settings (type to filter, Esc to close)", {
                    initialIndex: lastIndex,
                });
                if (!pick) return;
                lastIndex = Math.max(
                    0,
                    items.findIndex((i) => i.value === pick.value),
                );
                // Sub-flow: open the denylist manager, then return to settings.
                if (pick.value === "bashDeny") {
                    await runBashDenyManager(deps);
                    continue;
                }
                if (pick.value === "permissions") {
                    await runPermissionsManager(deps);
                    continue;
                }
                if (pick.value === "bashAllow") {
                    await runBashAllowManager(deps, state.cwd);
                    continue;
                }
                if (pick.value === "gateways") {
                    await runGatewaysManager(state, deps);
                    continue;
                }
                // Default subagent model: cross-provider picker (subagents may
                // run on a different provider than the session) + "inherit".
                // An agent file's own `model:` still wins over this setting.
                if (pick.value === "subagentModel") {
                    const INHERIT = "\x00inherit";
                    const cat = await getCatalog();
                    const cur = settingsStore.get("subagentModel") as string | undefined;
                    const modelItems: SelectItem[] = [
                        {
                            value: INHERIT,
                            label: "inherit (parent's model)",
                            description: cur ? "clear the override" : "(current)",
                        },
                        ...Object.values(cat)
                            .filter((m) => m.available)
                            .sort((a, b) => a.id.localeCompare(b.id))
                            .map((m) => ({
                                value: m.id,
                                label: m.id + (m.id === cur ? "  (current)" : ""),
                                description: `${m.name}  ·  ctx ${m.contextWindow.toLocaleString()}  ·  $${m.cost.input}/$${m.cost.output}`,
                            })),
                    ];
                    const mPick = await searchOnce(modelItems, "Subagent model (type to filter)");
                    if (!mPick) continue;
                    const chosen = mPick.value === INHERIT ? undefined : mPick.value;
                    settingsStore.set("subagentModel", chosen);
                    history.addSystem(`subagentModel → ${chosen ?? "inherit"}`);
                    tui.requestRender();
                    continue;
                }
                if (pick.value in BOOLEAN_DEFAULTS) {
                    const next = !boolSetting(pick.value);
                    settingsStore.set(pick.value, next);
                    // Clock starts/stops the 1s pulse; reminders are REGISTERED
                    // with Bun.cron rather than re-checked on it, so muting has
                    // to reach the scheduler or they keep firing while off.
                    deps.syncTicker();
                    history.addSystem(`${pick.value} → ${next ? "on" : "off"}`);
                    // MCP toggle connects/tears down servers live so the change
                    // takes effect this session without a /reload. startMcpServers
                    // re-checks the (now-updated) setting + trust itself.
                    if (pick.value === "mcp") {
                        if (next) startMcpServers(state, deps);
                        else void getMcpManager().close();
                    }
                    // Pinning is a layout swap: it moves the prompt and changes
                    // what the wheel does, so it applies on the spot — waiting
                    // for a relaunch would read as the toggle doing nothing.
                    if (pick.value === "pinnedInput") deps.applyPinnedInput(next);
                    tui.requestRender();
                    continue;
                }
                // Theme gets a picker (built-ins + contributed + the user's
                // ~/.loop/agent/themes/*.json) and applies live — the global
                // theme proxy makes themed components re-resolve colours on
                // the next render.
                if (pick.value === "sound") {
                    const cur = soundLevel();
                    const here = (v: string) => (v === cur ? "(current)" : "");
                    const macos = process.platform === "darwin";
                    // Off macOS there is no player, so every cue is the
                    // terminal bell — say so rather than promising chimes.
                    const how = macos ? "" : " (terminal bell — chimes need macOS)";
                    const sPick = await selectOnce(
                        [
                            { value: "off", label: "off", description: here("off") || "silent, bell included" },
                            {
                                value: "on",
                                label: "on",
                                description: here("on") || `a turn that ended, the agent waiting on you, startup, a cancel${how}`,
                            },
                            {
                                value: "max",
                                label: "max",
                                description: here("max") || `plus the incidental ones: the slash menu, clearing the input${how}`,
                            },
                        ],
                        "Interface chimes",
                    );
                    if (!sPick) continue;
                    const next = sPick.value as SoundLevel;
                    settingsStore.set("sound", next);
                    // Confirm by ear, which is the only way to judge it.
                    if (next !== "off") playCue("click");
                    continue;
                }
                // How much of a finished tool call the transcript shows. `d`
                // cycles the same setting inside transcript navigation.
                if (pick.value === "toolDetail") {
                    const cur = getToolDetail();
                    const here = (v: string) => (v === cur ? "(current)" : "");
                    const dPick = await selectOnce(
                        [
                            {
                                value: "compact",
                                label: "compact",
                                description: here("compact") || "the call and nothing else, one row each",
                            },
                            {
                                value: "normal",
                                label: "normal",
                                description: here("normal") || "plus what it returned, and a few lines of the output",
                            },
                            {
                                value: "full",
                                label: "full",
                                description: here("full") || "plus every call's output expanded",
                            },
                        ],
                        "How much of a tool call to show?",
                    );
                    if (!dPick) continue;
                    const next = dPick.value as ToolDetail;
                    settingsStore.set("toolDetail", next);
                    setToolDetail(next);
                    deps.history.setToolsExpanded(next === "full");
                    deps.history.invalidate();
                    deps.tui.requestRender();
                    continue;
                }
                if (pick.value === "theme") {
                    await pickTheme();
                    continue;
                }
                history.addSystem(`enter new value for ${pick.value}: (Esc to go back)`);
                tui.requestRender();
                const v = await promptOnce("");
                if (!v) continue;
                const key = pick.value;
                const cur = settingsStore.get(key);
                // Numeric settings stay numeric even when currently unset
                // (typeof undefined check alone would store the string).
                const NUMERIC_KEYS = new Set(["maxSteps", "autoCompactThreshold", "subagentMaxParallel"]);
                const parsed =
                    typeof cur === "number" || NUMERIC_KEYS.has(key)
                        ? Number(v)
                        : typeof cur === "boolean"
                          ? v === "true"
                          : v;
                settingsStore.set(key, parsed);
                history.addSystem(`${key} → ${parsed}`);
                tui.requestRender();
            }
        },
        async reload() {
            // Hard reload: every config surface re-read from disk, models
            // re-fetched from the network (blocking, so the result is real).
            showWorking("Reloading");
            tui.requestRender();
            try {
                // Drop the cached config files so every read below (theme, hooks,
                // mcp gating, mcpServers, custom providers, datasources) sees the
                // on-disk values. Without this the "hard reload" silently served
                // stale cached config.
                refreshConfigStores();
                // Datasource pools are cached per connectionId, so an edited
                // host/password would keep dialing the old one. Drop them; the
                // next sql query reconnects from the fresh config.
                await closeAllPools();

                // Theme + density (settings may have changed on disk). Both
                // are read at render time, so a repaint is the whole of it —
                // no transcript rebuild, because nothing about a theme is
                // baked into a component when it is constructed.
                initThemeFromSettings();
                applyCanvasWash();

                // Extensions: re-run from disk BEFORE the command registry is
                // rebuilt, so the commands re-registered below are the fresh
                // ones. This is what makes an edited Lua script take effect on
                // /reload — its file is as much a config surface as any other.
                await getExtensionHost().reloadAll();

                // Commands: prompts, skills, agents — rebuilt from disk.
                const fresh = new CommandRegistry();
                await registerBuiltins(fresh, { cwd: state.cwd });
                // Re-apply extension command contributions so /reload keeps them
                // (no-op when no extensions are loaded).
                getExtensionHost().applyCommands(fresh);
                (commands as unknown as { commands: Map<string, unknown> }).commands = (
                    fresh as unknown as { commands: Map<string, unknown> }
                ).commands;
                refreshCommands();

                // Active agent may have been deleted on disk meanwhile.
                if (!agentExists(state.agent)) {
                    state.agent = DEFAULT_AGENT_NAME;
                    settingsStore.set("agent", DEFAULT_AGENT_NAME);
                }
                statusLine.setAgent(state.agent);

                // Models: force-refresh availability + model definitions.
                bustCatalogCache();
                const cat = await getCatalog({ refresh: true });
                const available = Object.values(cat).filter((m) => m.available).length;

                // MCP: tear down and reconnect so added/removed/edited servers in
                // settings.json take effect. close() resets the manager's
                // `initialized` flag (init() is otherwise a no-op once connected);
                // startMcpServers re-gates on the now-fresh mcp toggle + trust and
                // reconnects in the background.
                await getMcpManager().close();
                startMcpServers(state, deps);

                tui.invalidate();
                history.addSystem(
                    `reloaded — settings, auth, datasources, theme, commands, agents, extensions, hooks config, models (${available}/${Object.keys(cat).length} available)`,
                );
            } catch (err) {
                history.addError(`reload failed: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                hideWorking();
            }
            tui.requestRender(true);
        },
    };
}
