export interface CommandContext {
    emit(event: string, data?: unknown): void;
    setModel(modelId: string): Promise<void> | void;
    setProvider(p?: string): Promise<void> | void;
    newSession(): Promise<void>;
    /** `focus` steers what the summary keeps (`/compact <focus>`). */
    manualCompact(focus?: string): Promise<void>;
    setThinking(level?: string): Promise<void> | void;
    showCost(): void;
    /** /context — context-window usage breakdown (grid + categories). */
    showContext(): Promise<void>;
    manageShells(args: string): void;
    /**
     * /notes — this session's notes: pick one to submit or delete, add one,
     * or remove them all. `/notes <text>` (also `/note <text>`) adds a note.
     */
    manageNotes(args: string): Promise<void> | void;
    /** /steak — GitHub-style token-usage heatmap; arg is an optional year. */
    showSteak(args: string): void;
    showSessions(): Promise<void>;
    /** /hosts — other machines running loop: switch to one, pair (`add <link>`), `remove <name>`. */
    manageHosts(args: string): Promise<void> | void;
    /** /rc — let other devices control this loop (`/rc off` stops). */
    remoteControl(args: string): Promise<void> | void;
    /**
     * /team — the thread team this session is in (teams/): every thread, its
     * state and cost, jump to one; `stop` stops them all; `lead` (also
     * `/lead`) goes back to the thread that started this one. Optional:
     * surfaces without a screen to jump around on leave it out.
     */
    manageTeam?(args: string): Promise<void> | void;
    /**
     * `/btw <question>` asks it in a side thread (a copy of this session)
     * while this one carries on; `/btw` alone lists the side threads asked
     * here, and `/btw back` returns from a side thread to where it was asked. Optional, like manageTeam: it needs a host that runs sessions in
     * the background.
     */
    askBtw?(question: string): Promise<void> | void;
    exit(): void;
    cwd: string;
    setCwd(p: string): void;
    startLogin(provider?: string): Promise<void>;
    startLogout(provider?: string): Promise<void> | void;
    openSettings(): Promise<void>;
    openModelPicker(): Promise<void>;
    showSessionInfo(): void;
    showHotkeys(): void;
    /** /theme — show the picker, or switch straight to a named theme. */
    switchTheme(args: string): void;
    copyLastAssistant(): Promise<void>;
    setSessionName(name: string): void;
    attachImage(path?: string): Promise<void> | void;
    exportSession(target?: string): Promise<void>;
    importSession(path: string): Promise<void>;
    reload(): Promise<void>;
    showChangelog(): void;
    manageAgents(): Promise<void>;
    manageHooks(): Promise<void>;
    /** /bashdeny — add/remove bash commands the agent is refused. */
    manageBashDeny(): Promise<void>;
    /** /permissions — manage allow/ask/deny permission rules. */
    managePermissions(): Promise<void>;
    /** /mcp — list servers, or `reconnect [name]` to (re)connect. */
    manageMcp(args: string): Promise<void> | void;
    /** /extensions — panel; `install <spec>` non-interactive shortcut (also /install). */
    manageExtensions(args: string): Promise<void> | void;
    /** /datasource — manage database connections for the data-analyst agent. */
    manageDatasources(): Promise<void> | void;
    /** With message: run that one message under this agent's prompt (one-shot). */
    useAgent(name: string, message?: string): Promise<void> | void;
    /** /plan — toggle plan mode (read-only until a plan is approved). With a
     * message: enter plan mode AND submit that message in one step. */
    togglePlanMode(args: string): Promise<void> | void;
    stub(name: string): void;
    clearScreen(): void;
    /** /fork — pick a previous user message, branch it into a new session. */
    forkFromMessage(): void;
    /** /clone — duplicate the current branch into a new session. */
    cloneSession(): Promise<void> | void;
    /** /tree — navigate the session tree (switch branches). */
    showTree(): void;
    /** /update — self-update to the latest release (exits on success). */
    updateApp(): Promise<void>;
    /** /timer — set ("1h30m"), show (""), or cancel ("off") the countdown. */
    setTimer(args: string): void;
    /** /reminder — open the reminder manager (create/edit/delete). */
    openReminders(): Promise<void>;
    /** /background — manager panel (no args) or quick-add a background task (`/background <text>`). */
    manageBackground(args: string): Promise<void> | void;
    /** /daemon — background-task scheduler: toggle panel (no args) or on|off|status. */
    manageDaemon(args: string): Promise<void> | void;
    /** /goal — goal mode: `/goal <objective>` works autonomously until verified
     * done; subcommands pause | resume | status | clear. */
    manageGoalMode(args: string): Promise<void> | void;
    /** /recap — generate the post-turn recap on demand (ignores the recap setting). */
    generateRecap(): Promise<void>;
    /** /memory — pick an AGENTS.md location and open it in $EDITOR. */
    openMemory(): Promise<void>;
    /** /doctor — read-only diagnostics of the installation and settings. */
    runDoctor(): Promise<void>;
    /** /share — upload the session as a secret GitHub gist via the gh CLI. */
    shareSession(): Promise<void>;
    /** /scoped-models — toggle panel (no args) or `add <id>` / `rm <id>` / bare list. */
    manageScopedModels(args: string): Promise<void> | void;
    /** /gateways — manage remote chat gateways (Telegram now, more later);
     * each runs as its own daemon process. */
    manageGateways(): Promise<void> | void;
    /** /artifacts — list the pages the agent wrote, and open one. */
    manageArtifacts(): Promise<void> | void;
    /** /trace — write the session's timing-and-cost trace as HTML and open
     * it in the browser (or at `path` when given). */
    openTrace(path?: string): Promise<void> | void;
    /** /recipe — extract, edit and run reusable workflows with named inputs. */
    manageRecipes(args: string): Promise<void>;
    /** /handoff [focus] — reviewed brief into a fresh session, model and agent. */
    manageHandoff(args: string): Promise<void>;
}

export interface SlashCommand {
    name: string;
    description: string;
    handler: (ctx: CommandContext, rawArgs: string) => Promise<void> | void;
}

export class CommandRegistry {
    private commands = new Map<string, SlashCommand>();

    register(cmd: SlashCommand): void {
        this.commands.set(cmd.name, cmd);
    }

    unregister(name: string): boolean {
        return this.commands.delete(name);
    }

    has(name: string): boolean {
        return this.commands.has(name);
    }

    get(name: string): SlashCommand | undefined {
        return this.commands.get(name);
    }

    list(): SlashCommand[] {
        return [...this.commands.values()];
    }

    async run(input: string, ctx: CommandContext): Promise<boolean> {
        if (!input.startsWith("/")) return false;
        const space = input.indexOf(" ");
        const name = (space < 0 ? input.slice(1) : input.slice(1, space)).trim();
        const args = space < 0 ? "" : input.slice(space + 1).trim();
        const cmd = this.commands.get(name);
        if (!cmd) return false;
        await cmd.handler(ctx, args);
        return true;
    }
}
