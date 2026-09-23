/**
 * The public extension SDK surface — the single `api` object an extension's
 * `activate(api)` receives. This is the stable contract third-party extensions
 * compile against; keep it additive. Authoring is pure Bun/TypeScript — no build
 * step (the host transpiles the entry on import) and no Node compat layer.
 */
import { EXTENSION_MANIFEST_KEYS } from "../brand";
import type { Tool } from "ai";
import type { LanguageModel } from "ai";
import type { SlashCommand } from "../commands";
import type { AppSettings } from "../settings";
import type { Entry, ModelInfo } from "../types";
import type { ContextPolicy } from "../agent/context-policy";

/**
 * Current extension API version — bumped on breaking changes to this surface.
 *
 * 0.3.1 added `api.context` (policy/boundary/budget/branch), `TurnContext`'s
 * context fields and `onAdditionalContext`. All additive: an extension written
 * against 0.3.0 only ever READS TurnContext, so it keeps working. A minor bump
 * would have been wrong here — while the API is 0.x the minor must match, so
 * 0.4.0 would have stopped every installed `^0.3` extension from loading for a
 * change that breaks none of them.
 */
export const EXTENSION_API_VERSION = "0.3.1";

/** The live context budget, as `api.context.read()` reports it. */
export interface ContextBudget {
    /** Estimated tokens in context, including system prompt and tool schemas. */
    used: number;
    /** The model's context window. */
    window: number;
    /** Where core's compaction/rollover line sits (window × autoCompactThreshold). */
    rolloverAt: number;
    /** False when the window is too small to hold a handoff plus working room. */
    supported: boolean;
}

/** The product-named section of an extension's package.json (see EXTENSION_MANIFEST_KEYS). */
export interface ExtensionManifestSection {
    /** Override the entry the host imports. */
    entry?: string;
    /** Friendly name for the /extensions panel. */
    displayName?: string;
    /** Required host API range, semver, keyed by the product name (e.g. { loop: "^0.3" }; while the API is 0.x, minor must match). */
    engines?: Record<string, string>;
    /** Declared capabilities, shown to the user (advisory in v1). */
    permissions?: string[];
}

/** An extension's package.json: the npm fields we read plus its product-named section. */
export interface ExtensionManifest {
    /** npm package name (the extension's identity). */
    name: string;
    version?: string;
    description?: string;
    /** ESM/main entry (TS allowed). Falls back to `module` → `main` → index.ts. */
    module?: string;
    main?: string;
    /** The product-named manifest section lives under any key in EXTENSION_MANIFEST_KEYS. */
    [key: string]: unknown;
}

/**
 * The extension's manifest section, found under the current product name (or a
 * legacy name, so published extensions survive a product rename).
 */
export function manifestSection(manifest: ExtensionManifest): ExtensionManifestSection | undefined {
    for (const key of EXTENSION_MANIFEST_KEYS) {
        const section = manifest[key];
        if (section && typeof section === "object") return section as ExtensionManifestSection;
    }
    return undefined;
}

/** The host-API range the manifest asks for, under any accepted product name. */
export function requiredApiRange(manifest: ExtensionManifest): string | undefined {
    const engines = manifestSection(manifest)?.engines;
    if (!engines) return undefined;
    for (const key of EXTENSION_MANIFEST_KEYS) {
        if (engines[key]) return engines[key];
    }
    return undefined;
}

/**
 * What is running right now — handed to turn/tool hooks so an extension can scope
 * its behavior (which agent, model, tool, step). Built once per turn in runTurn.
 */
export interface TurnContext {
    sessionId: string;
    transcriptPath: string;
    cwd: string;
    /** "default" | "plan" | a custom/extension agent. */
    agent: string;
    modelId: string;
    provider: string;
    model: string;
    /** Tool names available this turn (after agent filter + extensions). */
    tools: string[];
    /** True inside a task subagent run. */
    isSubagent: boolean;
    /** The model's context window in tokens; 0 when the catalog doesn't know it. */
    contextWindow: number;
    /**
     * Estimated tokens in context, INCLUDING the system prompt and tool schemas.
     *
     * Undefined for seams that run before the overhead is known — which is every
     * seam up to and including `onSystemPrompt`, because the estimate needs the
     * final system prompt that `onSystemPrompt` itself produces. Reading a
     * number here earlier would undercount by the whole system block (10-20k
     * tokens with workspace context and skills loaded). Only
     * `onAdditionalContext` sees it populated.
     */
    contextUsed?: number;
}

/** TurnContext plus the live tool call, for tool-level hooks. */
export interface ToolCallContext extends TurnContext {
    toolName: string;
    toolCallId?: string;
    input: unknown;
    signal?: AbortSignal;
}

/**
 * Runs before a matched tool executes — intercept or rewrite its arguments, or
 * block the call. Return a replacement input object to rewrite the call, `false`
 * to block it (the model gets an error result and can react), or void/undefined
 * to leave the input unchanged. Runs after Claude-compatible PreToolUse hooks,
 * so the two compose. Targets a specific tool via the `match` argument (e.g.
 * `onCall("bash", …)`); `ctx.toolName` is also available.
 */
export type ToolCallMiddleware = (
    input: unknown,
    ctx: ToolCallContext,
) => unknown | false | void | Promise<unknown | false | void>;

/**
 * Runs after a tool executes; can append to or transform its text result.
 * Return new text to replace the result, or void/undefined to leave it as-is.
 * This is the seam LSP/linters/formatters/test-runners hook (e.g. append a
 * `<diagnostics>` block after `write`/`edit`). The ctx tells the extension which
 * agent/model/tool produced the result.
 */
export type ToolResultMiddleware = (result: string, ctx: ToolCallContext) => string | void | Promise<string | void>;

/**
 * The active color theme, as an extension sees it. Structural on purpose: the
 * real implementation lives in the CLI, and core must not depend on it. Slot
 * names are the theme's colour keys (`toolTitle`, `muted`, `success`,
 * `error`, `warning`, `accent`, `toolOutput`, …); an unknown slot returns the
 * text unstyled rather than throwing, so a renderer can't break the UI.
 */
export interface ExtensionTheme {
    /** Active theme name, e.g. "dark" / "noir-day". */
    readonly name: string;
    fg(slot: string, text: string): string;
    bg(slot: string, text: string): string;
    bold(text: string): string;
    italic(text: string): string;
    underline(text: string): string;
}

/** What the TUI knows about a tool call when it draws the summary line. */
export interface ToolSummaryContext {
    toolName: string;
    cwd: string;
    /**
     * The active UI mode id — "loop" or "noir" today, and whatever a mode
     * extension registers. The two modes have different row grammar, so a
     * renderer that cares should branch on this rather than assume one.
     */
    uiMode: string;
    /** Active theme, so extension output matches the surrounding chrome. */
    theme: ExtensionTheme;
}

/**
 * Renders the one-line summary shown beside a tool call in the TUI — the text
 * after the tool's name. Without one, a tool loop has no built-in knowledge of
 * falls back to truncated JSON of its arguments, which is unreadable. Return a
 * string to use it, or void to accept the default.
 *
 * This is how an extension keeps its own presentation: loop holds the generic
 * seam and knows nothing about any particular tool's arguments. Called on every
 * repaint — keep it cheap and synchronous.
 */
export type ToolSummaryRenderer = (args: Record<string, unknown>, ctx: ToolSummaryContext) => string | void;

/** SDK families loop knows how to drive declaratively (Vercel AI SDK). */
export type ProviderSdk = "openai" | "anthropic" | "google" | "openai-compatible";

/** One model exposed by a provider. Missing fields get sane catalog defaults. */
export interface ProviderModelSpec {
    /** Id within the provider — addressed as `<providerId>/<id>`. */
    id: string;
    name?: string;
    contextWindow?: number;
    maxOutput?: number;
    reasoning?: boolean;
    /** Input modalities, e.g. ["text", "image"]. Defaults to ["text"]. */
    modalities?: string[];
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** How a provider authenticates — drives `loop login` + key resolution. */
export interface ProviderAuth {
    mode: "apikey" | "oauth" | "none";
    /** Fallback env var read when no key is stored/configured. */
    envVar?: string;
    /** Where the user obtains a key (shown in login UI). */
    loginUrl?: string;
}

/** Runtime passed to an imperative provider's getModel. */
export interface ProviderRuntime {
    /** Resolved key (config → loop auth store → env), if any. */
    apiKey?: string;
    fetch: typeof fetch;
}

/**
 * A provider plugin. Two flavors (inspired by pi-mono's `registerProvider`):
 *
 * - **Declarative** — give `sdk` + `baseURL` (+ `apiKey`/`headers`) + `models`,
 *   and loop builds the ai-sdk model with its existing custom-provider machinery.
 *   Covers OpenAI/Anthropic/Google-compatible endpoints.
 * - **Imperative** — supply `getModel` (and optionally `listModels`) for full
 *   control: custom auth, fetch, or a bespoke SDK the extension imports itself.
 *   `getModel`, when present, takes precedence over the declarative fields.
 */
export interface ProviderPlugin {
    /** Provider id — the `<id>` in `<id>/<model>`. Must be unique. */
    id: string;
    name?: string;
    auth?: ProviderAuth;
    // Declarative:
    sdk?: ProviderSdk;
    baseURL?: string;
    /** Literal, or `$ENV` / `${ENV}` interpolation. */
    apiKey?: string;
    headers?: Record<string, string>;
    models?: ProviderModelSpec[];
    // Imperative (overrides declarative when present):
    getModel?(modelId: string, ctx: ProviderRuntime): LanguageModel | Promise<LanguageModel>;
    listModels?(): ProviderModelSpec[] | Promise<ProviderModelSpec[]>;
}

/** An agent plugin: a named system prompt + optional tool allowlist. */
export interface AgentPlugin {
    name: string;
    description?: string;
    prompt: string;
    /** Tool names this agent may use; omit for all. */
    tools?: string[];
}

/**
 * Per-turn middleware seams, mirroring the assembly points in runTurn. Every
 * seam (except onBeforeTurn, which runs before tools are assembled) receives the
 * full `TurnContext`, so middleware can scope by `ctx.agent` / `ctx.model` —
 * e.g. update the system prompt of one specific agent:
 *
 *   onSystemPrompt(prompt, ctx) {
 *     if (ctx.agent === "plan") return prompt + "\n\nExtra rule for plan…";
 *   }
 */
export interface TurnMiddleware {
    /** Inspect the input, or block the turn by returning false. Runs pre-assembly. */
    onBeforeTurn?(ctx: {
        input: string;
        cwd: string;
        sessionId: string;
        agent: string;
        modelId: string;
    }): boolean | void | Promise<boolean | void>;
    /** Transform the assembled system prompt for the running agent (`ctx.agent`). */
    onSystemPrompt?(prompt: string, ctx: TurnContext): string | void | Promise<string | void>;
    /** Add/remove/wrap tools right before the model call. */
    onAssembleTools?(
        tools: Record<string, Tool>,
        ctx: TurnContext,
    ): Record<string, Tool> | void | Promise<Record<string, Tool> | void>;
    /** Tweak provider options (thinking/caching) before the model call. */
    onProviderOptions?(opts: unknown, ctx: TurnContext): unknown | void;
    /**
     * Contribute text to the model-bound copy of this turn only — it rides the
     * last user message and never enters the transcript, the same path
     * SessionStart hook context uses. The seam for anything that must be true
     * *now* rather than for the whole session: a budget reminder, a live
     * status. Runs after the context estimate, so `ctx.contextUsed` is set.
     */
    onAdditionalContext?(ctx: TurnContext): string | void | Promise<string | void>;
    /** Observe turn completion. */
    onAfterTurn?(ctx: TurnContext): void | Promise<void>;
}

/** One row in an interactive menu. Structurally identical to the TUI's SelectItem. */
export interface UiSelectItem {
    /** Returned to the caller when this row is chosen. */
    value: string;
    /** Primary text shown in the list. */
    label: string;
    /** Dimmed secondary text. */
    description?: string;
}

/**
 * Interactive terminal UI — the same menu/prompt primitives the built-in panels
 * (e.g. `/mcp`) use, so an extension can build its own rich panels. Only
 * available in the interactive TUI: every method THROWS in non-interactive
 * (print / `loop -p`) mode, so interactive flows must be gated behind a real
 * user session. `select`/`search`/`prompt` resolve to null/"" when the user
 * cancels (Esc).
 */
export interface ExtensionUI {
    /** Single-choice menu; arrow-key navigation. Resolves null on Esc. */
    select(items: UiSelectItem[], title?: string, opts?: { initialIndex?: number }): Promise<UiSelectItem | null>;
    /** Like select, but type-to-filter. Resolves null on Esc. */
    search(items: UiSelectItem[], title?: string, opts?: { initialIndex?: number }): Promise<UiSelectItem | null>;
    /** Free-text prompt. Resolves "" on empty/Esc. */
    prompt(label?: string, initial?: string): Promise<string>;
    /** Append a dim system line to the chat. */
    note(text: string): void;
    /** Append a red error line to the chat. */
    error(text: string): void;
}

/** Options for {@link ExtensionAuth.loopbackOAuth}. */
export interface LoopbackOAuthOptions {
    /**
     * Build the provider's authorize URL given the loopback `redirect_uri` loop
     * is listening on (a `http://127.0.0.1:<port>/callback`). Set the URL's
     * `redirect_uri` (and `state`/PKCE/etc.) to match.
     */
    buildAuthorizeUrl: (redirectUri: string) => string | Promise<string>;
    /** How long to wait for the browser redirect before failing. Default 180s. */
    timeoutMs?: number;
}

/** Result of a completed {@link ExtensionAuth.loopbackOAuth} round-trip. */
export interface LoopbackOAuthResult {
    /** The authorization code returned on the redirect. */
    code: string;
    /** The `state` echoed back, if the provider returned one. */
    state?: string;
    /** The exact redirect_uri loop listened on (needed for the token exchange). */
    redirectUri: string;
}

/**
 * Credentials + browser/OAuth helpers, so an extension can implement a full
 * remote-auth flow (the part the MCP feature needed). Secrets are namespaced to
 * the extension and persisted outside `settings.json`. Token *exchange* stays in
 * the extension (provider-specific); loop only provides the loopback code-catch.
 */
export interface ExtensionAuth {
    /** Read a secret previously stored by this extension. */
    getSecret(key: string): string | undefined;
    /** Persist a secret for this extension (e.g. an OAuth refresh token). */
    setSecret(key: string, value: string): void;
    /** Delete one of this extension's secrets. */
    deleteSecret(key: string): void;
    /** Open a URL in the user's browser. */
    openExternal(url: string): void;
    /**
     * Run a localhost-loopback OAuth flow: start a callback server, open the
     * browser to the URL from `buildAuthorizeUrl`, and resolve with the returned
     * code once the provider redirects back. The extension then exchanges the
     * code for tokens itself and stores them via {@link setSecret}.
     */
    loopbackOAuth(opts: LoopbackOAuthOptions): Promise<LoopbackOAuthResult>;
}

/**
 * Everything an extension might want to render in the status line, built fresh
 * each repaint. Passed to both contributors and transforms.
 */
export interface StatusLineContext {
    /** "default" | "plan" | a custom/extension agent. */
    agent: string;
    /** Full id, e.g. "xai/composer-2.5". */
    modelId: string;
    /** Parsed halves of modelId. */
    provider: string;
    model: string;
    /** Short session id, or null when the session is unsaved. */
    sessionId: string | null;
    cwd: string;
    cost: { usd: number; inputTokens: number; outputTokens: number; cachedInputTokens: number };
    context: { used: number; max: number };
    /** Thinking level ("off" when none). Only meaningful when `reasoning` is true. */
    thinking: string;
    /** Whether the current model reasons — gate any thinking display on this. */
    reasoning: boolean;
    /** Columns available to the status line. */
    width: number;
}

/** One piece an extension appends to the status line. */
export interface StatusSegment {
    /** Visible text; may contain ANSI color (e.g. from chalk). */
    text: string;
    /**
     * Which row to append to: 0 = identity (agent/model), 1 = usage
     * (session/cost/ctx). A larger number creates an extra row below. Default 1.
     */
    row?: number;
}

/**
 * Contributes extra segment(s) to the status line. Return a segment, an array, a
 * bare string (appended to the usage row), or null/undefined to add nothing.
 * Called on every repaint — keep it cheap and synchronous.
 */
export type StatusLineContributor = (
    ctx: StatusLineContext,
) => StatusSegment | StatusSegment[] | string | null | undefined;

/**
 * Rewrites the fully-rendered status line. Receives the assembled rows (after
 * built-in content + contributor segments) and returns replacement rows, or
 * void to leave them unchanged — full control over the final look.
 */
export type StatusLineTransform = (lines: string[], ctx: StatusLineContext) => string[] | void;

/**
 * A theme palette. `colors` maps slot names to a hex string, a 256-colour
 * index, or a `$var` reference into `vars`; any slot left out inherits from the
 * builtin dark theme, so a partial palette is valid and won't fail at render.
 */
export interface ExtensionThemeJson {
    name: string;
    vars?: Record<string, string | number>;
    colors: Record<string, string | number>;
}

/**
 * A UI mode — a named chat "experience" bundling its own themes and a
 * declarative style spec layered over the builtin `loop` defaults. Registering
 * one makes it selectable (`/uimode`), and its themes become available while
 * it's active.
 *
 * `style` is passed through to the renderer as-is; every knob it omits keeps
 * the loop default. The imperative per-block renderers the builtin modes can
 * use are deliberately NOT part of this surface — they take internal component
 * and theme types that would pin the extension to loop's rendering internals.
 */
export interface ExtensionUiMode {
    /** Unique id, used in settings (`uiMode`) and the picker. */
    id: string;
    /** Picker label; falls back to id. */
    name?: string;
    /** Themes this mode owns; [0] is its default. */
    themes: ExtensionThemeJson[];
    /** Declarative style knobs layered over the loop defaults. */
    style?: Record<string, unknown>;
}

/**
 * A thing that can draw itself into a region of the screen.
 *
 * Deliberately structural rather than the TUI's `Component` type: core cannot
 * import the TUI package, and this is the whole contract anyway — given a
 * width, return lines. Anything satisfying it can be shown, which is what lets
 * a table coming out of a Lua VM be a widget.
 */
/**
 * A mouse event delivered to a widget.
 *
 * `x`/`y` are relative to the widget's own top-left corner; `screenX`/`screenY`
 * are absolute, which is what a drag needs in order to move the widget by the
 * distance the pointer travelled. Both are 0-based.
 *
 * "drag" is motion with a button held, which is the only motion reported unless
 * the terminal is tracking all movement — so a widget can implement dragging
 * from press/drag/release alone.
 */
export interface WidgetMouseEvent {
    type: "press" | "release" | "drag" | "move";
    /** 0 = left, 1 = middle, 2 = right. */
    button: number;
    x: number;
    y: number;
    screenX: number;
    screenY: number;
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
}

export interface WidgetRenderer {
    render(width: number): string[];
    /** Return true to consume the key. Only called while the widget has focus. */
    handleInput?(data: string): boolean;
    /**
     * Return true to consume the event. A widget that declines lets the click
     * through to the terminal's own text selection, so returning false for the
     * events you do not use keeps select-and-copy working over the widget.
     */
    handleMouse?(event: WidgetMouseEvent): boolean;
}

/**
 * Placement for a widget. Sizes and positions take a column/row count or a
 * percentage string like "50%"; `anchor` is one of "center", "top-left",
 * "top-right", "bottom-left", "bottom-right", "top-center", "bottom-center",
 * "left-center", "right-center".
 */
export interface WidgetOptions {
    anchor?: string;
    width?: number | string;
    minWidth?: number;
    maxHeight?: number | string;
    offsetX?: number;
    offsetY?: number;
    row?: number | string;
    col?: number | string;
    /** Don't take keyboard focus — the user keeps typing while it is shown. */
    nonCapturing?: boolean;
}

export interface WidgetHandle {
    hide(): void;
    /**
     * Move the widget to an absolute screen position (0-based row/column).
     * This is what makes a widget draggable: the script updates the position
     * from its own mouse handler.
     */
    setPosition(row: number, col: number): void;
    /** Where it currently is, or undefined before its first paint. */
    getPosition(): { row: number; col: number } | undefined;
    setHidden(hidden: boolean): void;
    isHidden(): boolean;
    focus(): void;
    unfocus(): void;
}

/**
 * A docked panel — VS Code's bottom panel rather than a floating box.
 *
 * The difference from a widget is what it does to the frame: a widget is drawn
 * *over* the chat, while a dock takes rows *from* it, so the transcript gets
 * shorter and nothing is covered up. That also makes it the more dangerous of
 * the two, which is why the host closes every dock before the TUI paints its
 * final frame — see the exit note in the interactive app.
 */
export interface DockOptions {
    /** Only "bottom" today: between the transcript and the input box. */
    side?: "bottom";
    /** Height in rows. The renderer's output is padded or clipped to fit. */
    size?: number;
}

export interface DockHandle {
    close(): void;
    /** Change the height. Takes effect on the next frame. */
    setSize(rows: number): void;
    isOpen(): boolean;
    /** Take keyboard focus, so `handleInput` starts receiving keys. */
    focus(): void;
    unfocus(): void;
    isFocused(): boolean;
}

/** A live terminal: a shell (or any command) with an emulator interpreting it. */
export interface TerminalSpawnOptions {
    /** Defaults to the user's $SHELL. */
    cmd?: string;
    args?: string[];
    cwd?: string;
    rows?: number;
    cols?: number;
    onExit?: (code: number) => void;
    /** The screen changed; repaint. */
    onUpdate?: () => void;
    /** Whether the panel has the keyboard — the cursor is drawn only if so. */
    isFocused?: () => boolean;
}

/**
 * A terminal session. It satisfies {@link WidgetRenderer}, so it can be handed
 * straight to `docks.open` or `widgets.show` and drawn like anything else.
 */
export interface TerminalHandle extends WidgetRenderer {
    /** Always present here: a terminal consumes every key it is given. */
    handleInput(data: string): boolean;
    write(data: string): void;
    resize(rows: number, cols: number): void;
    kill(): void;
    readonly exited: boolean;
}

export interface ExtensionInfo {
    /** The extension's own directory (~/.loop/extensions/<name>). */
    readonly dir: string;
    readonly manifest: ExtensionManifest;
    /** Namespaced logger (prefixes [<name>]). Routed into the chat as a note. */
    readonly log: (...args: unknown[]) => void;
    /**
     * Report a one-line status (e.g. current mode) for the startup banner and
     * `/extensions` panel — so the user can see the extension is active and how.
     * Pass a function; it's read fresh each time. Return undefined to show none.
     */
    readonly setStatus: (fn: () => string | undefined) => void;
}

/**
 * The object handed to `activate(api)`. Every registration is undone
 * automatically when the extension is disabled/uninstalled/reloaded — the host
 * tracks ownership, so an extension never has to clean up its own contributions.
 */
export interface ExtensionAPI {
    readonly extension: ExtensionInfo;
    readonly version: string;

    /** Interactive menus/prompts. Throws in non-interactive (print) mode. */
    readonly ui: ExtensionUI;
    /** Secrets + browser/OAuth helpers. */
    readonly auth: ExtensionAuth;

    commands: {
        register(cmd: SlashCommand): void;
        unregister(name: string): void;
        /** Replace an existing command (override a builtin). */
        override(name: string, cmd: Partial<SlashCommand> & Pick<SlashCommand, "handler">): void;
    };

    tools: {
        add(name: string, tool: Tool): void;
        /** Remove a tool by name (including builtins like `bash`). */
        remove(name: string): void;
        /**
         * Grant a tool to a specific (restricted) agent's allowlist — e.g. let
         * the read-only `plan` agent use a custom tool. `default` already has all
         * tools, so granting to it is a no-op.
         */
        grant(agent: string, tool: string): void;
        /** Intercept/rewrite a matched tool's input, or block it, before it runs. */
        onCall(match: string | string[] | ((name: string) => boolean), mw: ToolCallMiddleware): void;
        onResult(match: string | string[] | ((name: string) => boolean), mw: ToolResultMiddleware): void;
        /**
         * Supply the one-line summary the TUI shows beside a matched tool call,
         * in place of the default JSON dump. An extension that adds a tool owns
         * how that tool reads.
         */
        summary(match: string | string[] | ((name: string) => boolean), fn: ToolSummaryRenderer): void;
    };

    settings: {
        get<K extends keyof AppSettings>(key: K): AppSettings[K];
        set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
        /** The extension's own namespaced settings (the `extensionSettings.<name>` bag in settings.json). */
        getOwn<T = unknown>(key: string, fallback?: T): T;
        setOwn<T = unknown>(key: string, value: T): void;
    };

    /**
     * Chat experiences and palettes. A mode is selectable via `/uimode` and
     * settings `uiMode`; its themes become available while it is active.
     * `addThemes` extends a mode loop already has (e.g. another palette for
     * `noir`) without redefining it.
     */
    uiModes: {
        register(mode: ExtensionUiMode): void;
        addThemes(modeId: string, ...themes: ExtensionThemeJson[]): void;
    };

    providers: { register(provider: ProviderPlugin): void; unregister(id: string): void };
    models: { add(...infos: ModelInfo[]): void };
    agents: { register(agent: AgentPlugin): void };
    skills: { addDir(dir: string): void };
    turn: { use(mw: TurnMiddleware): void };
    /**
     * Own what happens when a turn crosses the context threshold. Core
     * summarizes when no policy is registered, so this is opt-in and
     * single-owner: the first policy wins and later ones are ignored with a
     * warning, because load order silently deciding the boundary is a bug you
     * cannot see.
     */
    context: {
        registerPolicy(policy: ContextPolicy): void;
        /** Request a fresh window; committed after the turn's entries land. */
        requestBoundary(handoff?: string): void;
        /** The live budget, or undefined before the first estimate of a turn. */
        read(): ContextBudget | undefined;
        /**
         * The running turn's session branch — including entries a rollover or
         * compaction removed from the model's context, which is the point: it
         * is how a recovery tool reaches conversation the model can no longer
         * see. Empty outside a turn.
         */
        branch(): readonly Entry[];
    };
    /**
     * The terminal's size in character cells.
     *
     * `render(width)` is told how wide it may draw but never how tall, because
     * for most widgets the height is simply however many lines they return.
     * Anything that fills the screen — a full-height panel, a game — has to
     * know the row count to lay itself out at all. Returns undefined outside
     * interactive mode.
     */
    screen(): { rows: number; cols: number } | undefined;

    /**
     * Floating widgets — a box drawn over the chat at a chosen anchor, which
     * may take keyboard focus or leave the user typing underneath.
     *
     * Interactive only: `show` returns undefined in print mode, so a caller
     * that wants a widget must cope with not getting one.
     */
    widgets: {
        show(renderer: WidgetRenderer, options?: WidgetOptions): WidgetHandle | undefined;
    };

    /**
     * Real terminals — a pty running a shell, with an emulator interpreting its
     * output, ready to be shown in a dock or a widget.
     *
     * `spawn` is async because the pty and emulator are loaded on first use:
     * they are a few megabytes of machinery that a session which never opens a
     * terminal should not pay for at startup.
     */
    terminal: {
        /** False where the platform has no pty support (notably Windows). */
        available(): Promise<boolean>;
        spawn(options?: TerminalSpawnOptions): Promise<TerminalHandle>;
    };

    /**
     * Docked panels — rows taken from the transcript rather than drawn over it,
     * the way VS Code's bottom panel works. Interactive only, like widgets.
     */
    docks: {
        open(renderer: WidgetRenderer, options?: DockOptions): DockHandle | undefined;
    };

    /**
     * Global key bindings, checked before the editor sees the key. `key` is a
     * TUI key id ("ctrl+g", "alt+w"). Returns a disposer; the binding is also
     * dropped automatically when the extension unloads.
     */
    keymap: {
        set(key: string, handler: () => boolean | void): () => void;
    };

    /** Customize the status line under the input box. */
    statusLine: {
        /** Append segment(s) to a row. */
        add(fn: StatusLineContributor): void;
        /** Rewrite the fully-rendered rows. */
        transform(fn: StatusLineTransform): void;
        /**
         * Request a status-line repaint — needed for live fields (a clock, CPU,
         * etc.) that change without any user action. No-op in print mode. Call
         * sparingly (e.g. once a second from your own timer); each call triggers
         * a render.
         */
        refresh(): void;
    };
}

/** The shape an extension's entry module must export (default or named). */
export interface ExtensionModule {
    activate?(api: ExtensionAPI): void | Promise<void>;
    deactivate?(): void | Promise<void>;
}
