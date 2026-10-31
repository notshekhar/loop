/**
 * Builds + shows the startup welcome banner and keeps a single live instance so
 * a late-arriving update notice lands on the banner currently on screen.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import { DEFAULT_AGENT_NAME, getAppProfile } from "@notshekhar/loop-core";
import { WelcomeBanner } from "./components/welcome-banner";
import { WelcomePanelView } from "./components/welcome-panel";
import type { ChatHistory } from "./components/chat-history";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";

let activeBanner: WelcomeBanner | null = null;
/** The app's live panel under the banner on screen; replaced along with the banner. */
let activePanel: WelcomePanelView | null = null;
// Remembered so a banner recreated on /new or /clear keeps the notice, and so a
// notice that arrives (network) before the banner exists still lands on it.
let updateNotice: string | undefined;
/**
 * The startup status lines (workspace context, project skills, extensions).
 *
 * Remembered for the same reason the update notice is: they belong WITH the
 * masthead, and every path that rebuilds the transcript — a resumed session
 * replaying it, `/ui` and `/theme` reconstructing every component — has to be
 * able to put them back in that place. Held as text rather than as components
 * because a rebuild is exactly the moment the old components are being thrown
 * away.
 */
let startupNotices: Array<{ text: string; kind: "system" | "hook" }> = [];

/**
 * Record and show a startup status line, in the block under the masthead.
 *
 * Two different problems, one mechanism. Lines that arrive LATE (the hooks
 * list, which waits on the trust prompt; MCP servers, which report when they
 * connect) go into the block's own container rather than the end of the
 * transcript, so they join their own kind instead of trailing the
 * conversation. And every line is remembered, so a transcript rebuilt later
 * (`/ui`, `/theme`) can put the whole block back where it belongs.
 */
export function addStartupNotice(history: ChatHistory, text: string, kind: "system" | "hook" = "system"): void {
    startupNotices.push({ text, kind });
    history.addStartupLine(text, kind);
}

/** Drop the recorded lines — the caller is about to collect them afresh. */
export function resetStartupNotices(): void {
    startupNotices = [];
}

/**
 * Re-emit the recorded startup lines. Called by the rebuild paths right after
 * the banner, so the block under the masthead survives a mode or theme switch
 * that reconstructs the whole transcript.
 */
export function replayStartupNotices(history: ChatHistory): void {
    for (const line of startupNotices) history.addStartupLine(line.text, line.kind);
}

/**
 * Set the "update available" line shown under the welcome masthead. Routed here
 * (instead of appended to chat history) so it sits with the banner at the top
 * rather than floating below the conversation when the async check resolves.
 */
export function setWelcomeUpdateNotice(text: string): void {
    updateNotice = text;
    activeBanner?.setUpdateNotice(text);
}

function username(): string {
    try {
        return os.userInfo().username || process.env.USER || process.env.USERNAME || "there";
    } catch {
        return process.env.USER || process.env.USERNAME || "there";
    }
}

function shortenPath(p: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Current branch name, or null outside a repo / on a detached HEAD. Sync and
 * short-timeout on purpose: it runs once per banner during startup, and a
 * missing or slow git must never delay the first paint.
 */
function gitBranch(cwd: string): string | null {
    try {
        const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd,
            encoding: "utf8",
            timeout: 500,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out && out !== "HEAD" ? out : null;
    } catch {
        return null;
    }
}

/** Render the masthead into chat history; replaces any prior live banner. */
export function showWelcomeBanner(history: ChatHistory, state: AppState, deps: AppDeps): void {
    const banner = new WelcomeBanner(deps.tui, {
        name: username(),
        model: state.modelId,
        session: state.session?.id ?? "unsaved",
        agent: state.agent !== DEFAULT_AGENT_NAME ? state.agent : null,
        branch: gitBranch(state.cwd),
        cwd: shortenPath(state.cwd),
        version: deps.version,
    });
    activeBanner = banner;
    if (updateNotice) banner.setUpdateNotice(updateNotice);
    history.addChild(banner);
    activePanel?.dispose();
    const panel = getAppProfile().welcomePanel;
    activePanel = panel ? new WelcomePanelView(deps.tui, panel) : null;
    if (activePanel) history.addChild(activePanel);
    // Directly under the masthead, and kept open: this is where every startup
    // status line goes, including the ones that only arrive once the trust
    // prompt is answered or an MCP server finishes connecting.
    history.openStartupBlock();
    deps.tui.requestRender();
}
