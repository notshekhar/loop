/**
 * Getting the first frame out: the startup notices, the startup block above
 * the transcript, starting the screen, and the background work that follows.
 */
import { getCatalog, playCue, type Session } from "@notshekhar/loop-core";
import { probeSystemScheme } from "../ui/system-scheme";
import { applyCanvasWash } from "../ui/canvas-wash";
import { renderSessionBranch } from "../replay";
import { runStartupTrustAndHooks, showWhatsNew, showWorkspaceBanners, startUpdateCheck } from "../startup";
import { startEnabledGateways } from "../gateway-process";
import { showWelcomeBanner } from "../welcome";
import { listUsableProviders } from "../provider-availability";
import type { AppDeps } from "../deps";
import { warn } from "../ui/text";
import type { AppCore } from "./context";
import type { Editor } from "@notshekhar/loop-tui";

/** loop is up and the first frame is about to go out. */
export function announceStartup(core: AppCore): void {
    const { opts, history } = core;
    playCue("bloom");
    showWhatsNew(history, opts.version, Boolean(opts.sessionId));
    // Routes its result to the welcome banner (top), not chat history; safe to
    // kick off before the banner exists — the notice is remembered and applied.
    startUpdateCheck(opts.version);
    refreshCatalogThenStatusLine(core);
}

/**
 * Force a catalog availability refresh on every startup — provider model
 * lists drift (new releases, deprecations, gating) and the cached list is
 * good for up to 1h otherwise. Fire-and-forget; mergedCache rebuilds when
 * this lands so the /model picker reflects today's reality.
 */
function refreshCatalogThenStatusLine(core: AppCore): void {
    void getCatalog({ refresh: true })
        .catch(() => {})
        .then(() => {
            // The catalog (including custom-provider models) resolves
            // asynchronously, and the status line booted before it landed. A
            // model that is not resolvable synchronously — a custom-provider or
            // gateway id — came up with reasoning unknown, which hid the
            // thinking level, AND with a context window of zero, which is what
            // made `loop --session <id>` show an empty context gauge while
            // /resume inside a session showed the real one: by then the catalog
            // had long been warm. The whole status line is re-applied rather
            // than the model alone, so anything else computed from the model
            // (the ctx meter, the cost row, the plan flag) lands with it.
            core.statusLine.setModel(core.state.modelId);
            core.statusLineRefresher.refreshStatusLine();
        });
}

/**
 * The startup block (workspace context, skills, extensions, the no-model
 * hint) goes in BEFORE the transcript, not after it.
 *
 * Both awaits used to run after the replay, which put the header's own
 * status lines underneath the entire resumed conversation — `loop --session
 * <id>` opened on a screen whose last lines were "workspace context: none"
 * and "extensions: …" instead of the end of the chat. Nothing is painted
 * until the screen starts, so paying for these two awaits here costs the
 * first frame nothing.
 */
export async function showStartupBlock(core: AppCore, deps: AppDeps, initialSession: Session | null): Promise<void> {
    const { history, state } = core;
    showWelcomeBanner(history, state, deps);
    await showWorkspaceBanners(history, state.cwd);
    if (!state.modelId) await showNoModelGuidance(core);
    // A session opened via --session replays its transcript like /resume does
    // — reopening a conversation without its history looked like data loss.
    // After the banner and its status block: the conversation goes below both.
    if (initialSession) renderSessionBranch(initialSession, history, state.modelId, core.todoPanel);
}

/**
 * No model is selected at startup. Point the user at the right next step: if
 * they have no usable provider at all, they must /login; if a provider is
 * available (logged in or a detected ollama) they just need to pick one with
 * /provider (or /login into another).
 */
async function showNoModelGuidance(core: AppCore): Promise<void> {
    const providers = await listUsableProviders();
    if (providers.length === 0) {
        core.history.addSystem(warn("No model selected and no provider available. Run /login to get started."));
    } else {
        core.history.addSystem(
            warn(`No model selected. Run /provider to pick one (${providers.join(", ")}), or /login to add another.`),
        );
    }
    core.tui.requestRender();
}

export function startScreen(core: AppCore, editor: Editor): void {
    const { tui } = core;
    tui.setFocus(editor);
    tui.start();
    // After start: terminal.start() cleanses stale modes (incl. OSC 111
    // background reset), so the mode's wash must be applied after it.
    applyCanvasWash();
    // noir's `system` theme has no canvas of its own — it needs to know what
    // the terminal's background IS. One probe, in the background, and only
    // when that theme is what's rendering.
    probeSystemScheme(tui);
    tui.requestRender();
}

export function startBackgroundWork(core: AppCore, deps: AppDeps): void {
    const { state } = core;
    // Catalog warm-up: models change between releases — kick the
    // stale-while-revalidate refresh now (background; serves cache instantly)
    // so the model list and availability are fresh for this session.
    void getCatalog().catch(() => {});

    // Trust prompt + SessionStart hooks; the first turn awaits this so
    // hook-injected context isn't lost to a fast first prompt.
    state.startupHooksDone = runStartupTrustAndHooks(state, deps);

    // Gateways: bring up each enabled gateway (Telegram, …) inside this
    // process, stopped again by cleanExit. Fire-and-forget, never blocks the UI.
    startEnabledGateways(state, deps);
}
