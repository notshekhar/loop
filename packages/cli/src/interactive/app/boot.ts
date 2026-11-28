/**
 * Startup state: which model and session loop opens on, the command set
 * (extensions included), and the slot manager every later step reads through.
 */
import type { TuiAltScreen } from "@notshekhar/loop-tui";
import {
    CommandRegistry,
    CostTracker,
    SessionManager,
    registerBuiltins,
    getActiveProvider,
    settingsStore,
    getCatalog,
    parseModelId,
    getExtensionHost,
    agentExists,
    isBuiltinAgent,
    isHiddenAgent,
    DEFAULT_AGENT_NAME,
    resolveSavedAgent,
    getProjectModel,
    latestTodos,
    type ThinkingLevel,
    type ProviderId,
    type Session,
} from "@notshekhar/loop-core";
import { initThemeFromSettings } from "../ui/theme";
import { ChatHistory } from "../components/chat-history";
import { StatusLine } from "../components/status-line";
import { TodoPanel } from "../components/todo-panel";
import { ShellsPanel } from "../components/shells-panel";
import { forwardTo, makeStateView, SlotManager, type SharedState } from "../slots";
import type { AppState } from "../state";
import { createStatusLineRefresher } from "../status-line-refresh";
import { openBrowser } from "../../open-browser";
import type { AppCore, InteractiveOptions } from "./context";

export interface StartupSession {
    manager: SessionManager;
    session: Session | null;
    modelId: string;
    provider: ProviderId;
    tracker: CostTracker;
    /** Context size restored from a resumed transcript (0 for a fresh one). */
    ctxTokens: number;
}

export async function openStartupSession(opts: InteractiveOptions): Promise<StartupSession> {
    // Model precedence: CLI flag > this folder's last pick > global default.
    // No silent provider fallback — if the user never picked a model we leave
    // it empty and guide them to /login or /provider instead of defaulting to
    // some provider they may not even be authenticated for.
    let modelId =
        opts.modelId ?? getProjectModel(opts.cwd) ?? (settingsStore.get("defaultModel") as string | undefined) ?? "";

    const manager = new SessionManager();
    const session: Session | null = opts.sessionId ? await manager.open(opts.sessionId) : null;
    const resumedModel = session?.lastModel();
    if (resumedModel) modelId = resumedModel;

    const tracker = new CostTracker();
    // Resumed sessions restore their cost/usage/ctx from the transcript's
    // usage entries instead of showing zeros until the next message.
    const ctxTokens = session ? tracker.seedFromSession(session).ctxTokens : 0;
    return { manager, session, modelId, provider: providerFor(opts, modelId), tracker, ctxTokens };
}

/**
 * Provider follows the restored model (project/session picks carry it);
 * otherwise the active provider, if any.
 */
function providerFor(opts: InteractiveOptions, modelId: string): ProviderId {
    const fallback = (opts.provider ?? getActiveProvider() ?? "") as ProviderId;
    if (!modelId) return fallback;
    try {
        return parseModelId(modelId).provider as ProviderId;
    } catch {
        // unparseable id — keep the active provider
        return fallback;
    }
}

export async function loadCommands(cwd: string): Promise<CommandRegistry> {
    // Load extensions BEFORE building commands so registerBuiltins (which lists
    // agents) sees extension-registered agents and gives them /<name> commands.
    // With nothing installed this is a no-op, so the command set is exactly the
    // builtins.
    // Give extensions a browser opener before activate() runs. The interactive
    // `ui` bridge is injected later, once the TUI selector helpers exist.
    // `interactive` goes in before init() so an extension that shows a widget or
    // binds a key during activation is queued until the TUI exists, rather than
    // silently getting nothing (the screen is built further down).
    getExtensionHost().setServices({ openExternal: (url) => openBrowser(url), interactive: true });
    await getExtensionHost().init();
    // Extensions may contribute palettes, and one of them may be the theme
    // settings names — so the host is up (above) before the theme resolves.
    initThemeFromSettings();
    const commands = new CommandRegistry();
    await registerBuiltins(commands, { cwd });
    getExtensionHost().applyCommands(commands);
    return commands;
}

/** The first session's panels, the status line seeded from the startup session, and the slots that own them. */
export function createAppCore(
    opts: InteractiveOptions,
    tui: TuiAltScreen,
    boot: StartupSession,
    commands: CommandRegistry,
): AppCore {
    const firstHistory = new ChatHistory(tui, opts.cwd);
    const statusLine = new StatusLine();
    const firstTodoPanel = new TodoPanel();
    const shellsPanel = new ShellsPanel();
    // A resumed session restores its branch's latest checklist immediately.
    if (boot.session) firstTodoPanel.setItems(latestTodos(boot.session.getBranch()) ?? []);
    const thinkingLevel: ThinkingLevel = (settingsStore.get("thinkingLevel") as ThinkingLevel | undefined) ?? "off";
    seedStatusLine(statusLine, opts, boot, thinkingLevel);

    const { slots, shared } = createSlots(opts, boot, thinkingLevel, firstHistory, firstTodoPanel);
    const state: AppState = makeStateView(shared, () => slots.foreground);
    statusLine.setAgent(state.agent);
    const tracker = forwardTo(() => slots.foreground.tracker);
    return {
        opts,
        tui,
        commands,
        manager: boot.manager,
        slots,
        shared,
        state,
        history: forwardTo(() => slots.foreground.history),
        todoPanel: forwardTo(() => slots.foreground.todoPanel),
        tracker,
        queuedMessages: forwardTo(() => slots.foreground.queue),
        statusLine,
        shellsPanel,
        statusLineRefresher: createStatusLineRefresher(statusLine, tracker, tui, state),
        late: { roster: null, remoteSessions: null, teamSessions: null, syncTicker: () => {} },
    };
}

function seedStatusLine(
    statusLine: StatusLine,
    opts: InteractiveOptions,
    boot: StartupSession,
    thinkingLevel: ThinkingLevel,
): void {
    statusLine.setModel(boot.modelId);
    statusLine.setSession(boot.session?.id ?? "unsaved");
    statusLine.setCost(boot.tracker.format());
    statusLine.setCostData(boot.tracker.sessionBreakdown());
    statusLine.setCwd(opts.cwd);
    statusLine.setThinking(thinkingLevel);
}

function createSlots(
    opts: InteractiveOptions,
    boot: StartupSession,
    thinkingLevel: ThinkingLevel,
    history: ChatHistory,
    todoPanel: TodoPanel,
): { slots: SlotManager; shared: SharedState } {
    // Plan is a per-session mode, not a sticky preference: a new loop always
    // boots in the default agent even if the last session ended in plan.
    const savedAgent = resolveSavedAgent(settingsStore.get("agent") as string | undefined) ?? DEFAULT_AGENT_NAME;
    // One slot per live session (slots.ts). This is the first; `/new` while
    // a turn runs and the Ctrl+S switcher add more. Everything below that was
    // written for one session — `state`, `history`, `todoPanel`, `tracker`,
    // the queue — follows whichever slot is on screen.
    const slots = new SlotManager({
        cwd: opts.cwd,
        modelId: boot.modelId,
        provider: boot.provider,
        thinkingLevel,
        agent: agentExists(savedAgent) ? savedAgent : DEFAULT_AGENT_NAME,
        oneShotAgent: null,
        session: boot.session,
        latestContextTokens: boot.ctxTokens,
        busy: false,
        abort: new AbortController(),
        pendingInjection: null,
        startupHooksDone: null,
        pendingPlan: null,
        planModeViaCycle: false,
        history,
        todoPanel,
        tracker: boot.tracker,
    });
    const shared: SharedState = {
        cycleCustomAgent:
            agentExists(savedAgent) && (!isBuiltinAgent(savedAgent) || isHiddenAgent(savedAgent)) ? savedAgent : null,
        scrollbackFocus: false,
        pinnedInput: Boolean(settingsStore.get("pinnedInput")),
        lastQuitPressAt: 0,
        timerEndsAt: null,
        timerLabel: "",
    };
    return { slots, shared };
}

export async function resolveModelId(input: string, state: AppState): Promise<string | null> {
    const cat = await getCatalog();
    if (cat[input]) return input;
    if (!input.includes("/")) {
        const active = (getActiveProvider() ?? state.provider) as ProviderId;
        const candidate = `${active}/${input}`;
        if (cat[candidate]) return candidate;
        const matches = Object.keys(cat).filter((k) => k.endsWith(`/${input}`));
        if (matches.length === 1) return matches[0];
    }
    try {
        parseModelId(input);
        return input;
    } catch {
        return null;
    }
}
