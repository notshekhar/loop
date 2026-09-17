/**
 * Startup-time chat banners and the trust → SessionStart hooks sequence.
 * Pulled out of app.ts so the app file stays an orchestrator.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    getMcpManager,
    getExtensionHost,
    isMcpEnabled,
    getTrustDecision,
    getTrustOptions,
    hasProjectTrustInputs,
    isTrusted,
    loadHooksConfig,
    loadMcpServers,
    loadProjectSkills,
    loadWorkspaceContext,
    runHooks,
    withheldProjectServers,
    syncMcpPromptCommands,
    setTrust,
    settingsStore,
    trustForSession,
    CONFIG_DIR_NAME,
    PRODUCT_NAME,
} from "@notshekhar/loop-core";
import type { ChatHistory } from "./components/chat-history";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import { checkForUpdate } from "../commands";
import { addStartupNotice, resetStartupNotices, setWelcomeUpdateNotice } from "./welcome";
import { getNewEntries, loadChangelogEntries } from "../changelog";
import { dim, warn } from "./ui/text";

/**
 * What's-new: show changelog entries the user hasn't seen yet (fresh
 * installs just record the version; resumed sessions skip).
 */
export function showWhatsNew(history: ChatHistory, version: string | undefined, resumed: boolean): void {
    if (!version || resumed) return;
    const lastSeen = settingsStore.get("lastChangelogVersion") as string | undefined;
    if (!lastSeen) {
        settingsStore.set("lastChangelogVersion", version);
        return;
    }
    if (lastSeen !== version) {
        const fresh = getNewEntries(loadChangelogEntries(), lastSeen);
        if (fresh.length > 0) {
            history.addSystem(dim(`Updated to v${version} — what's new:`));
            history.addMarkdown(fresh.map((e) => e.content).join("\n\n"));
        }
        settingsStore.set("lastChangelogVersion", version);
    }
}

/**
 * Silent background update check; suggest upgrade if a newer release exists.
 * Fire-and-forget so startup never blocks on the network.
 */
export function startUpdateCheck(version: string | undefined): void {
    if (!version) return;
    void checkForUpdate(version).then((latest) => {
        if (latest) {
            // Routed to the welcome banner (top), not chat history, so it sits
            // under the masthead instead of floating below the conversation when
            // this async check resolves.
            setWelcomeUpdateNotice(
                `Update available: v${version} → ${latest}. Run /update (or \`${PRODUCT_NAME} update\`) to upgrade.`,
            );
        }
    });
}

/**
 * Workspace context + project skills + active extensions: the status block that
 * belongs directly under the masthead.
 *
 * Every line goes through addStartupNotice, which both prints it and remembers
 * it, so a transcript rebuilt later (`/ui`, `/theme`) puts the same block back
 * under the banner instead of dropping it. Callers must run this BEFORE
 * replaying a session's transcript — it is awaited, and a resumed session that
 * replays first ends up with its startup block printed underneath the whole
 * conversation.
 */
export async function showWorkspaceBanners(history: ChatHistory, cwd: string): Promise<void> {
    resetStartupNotices();
    if ((settingsStore.get("workspaceContext") as boolean) !== false) {
        const ws = loadWorkspaceContext(cwd);
        if (ws.files.length > 0) {
            addStartupNotice(history, dim(`workspace context (${ws.files.length}):`));
            for (const f of ws.files) {
                addStartupNotice(history, dim(`  • ${f.replace(process.env.HOME ?? "", "~")}`));
            }
        } else {
            addStartupNotice(history, dim("workspace context: none (AGENTS.md, CLAUDE.md not found)"));
        }
    }
    if ((settingsStore.get("skills") as boolean) !== false) {
        const sk = await loadProjectSkills(cwd);
        if (sk.skills.length > 0) {
            addStartupNotice(history, dim(`skills (${sk.skills.length}):`));
            for (const s of sk.skills) {
                addStartupNotice(history, dim(`  • ${s.name} — ${s.description.slice(0, 80)}`));
            }
        }
    }
    // Active extensions, grouped with the other startup status lines. Capped so a
    // user with many installed doesn't get a wall of text.
    const exts = getExtensionHost().activeStatuses();
    if (exts.length > 0) {
        const MAX = 8;
        const shown = exts.slice(0, MAX).join(" · ");
        const extra = exts.length > MAX ? ` · +${exts.length - MAX} more` : "";
        addStartupNotice(history, dim(`extensions: ${shown}${extra}`));
    }
}

/**
 * Project trust → SessionStart hooks. First open of a folder that ships
 * .loop/.claude resources prompts before any project hook/skill can run; the
 * decision gates project resource loading (executable hooks, project skills).
 */
export async function runStartupTrustAndHooks(state: AppState, deps: AppDeps): Promise<void> {
    const { tui, history, selectOnce } = deps;

    if (hasProjectTrustInputs(state.cwd) && getTrustDecision(state.cwd) === null) {
        const opts = getTrustOptions(state.cwd);
        history.addSystem(
            warn(`Trust this project folder?\n${state.cwd}`) +
                dim(
                    `\nTrusting lets ${PRODUCT_NAME} load this repo's ${CONFIG_DIR_NAME}/.claude settings, hooks, and skills.`,
                ),
        );
        tui.requestRender();
        const items: SelectItem[] = opts.map((o) => ({ value: o.label, label: o.label, description: "" }));
        const pick = await selectOnce(items, "Project trust");
        const chosen = opts.find((o) => o.label === pick?.value);
        if (chosen) {
            if (chosen.remember) setTrust(chosen.savePath, chosen.trusted);
            else if (chosen.trusted) trustForSession(state.cwd); // session-only: in-memory, not persisted
            history.addSystem(
                dim(chosen.trusted ? "project trusted" : "project not trusted — project hooks/skills disabled"),
            );
        } else {
            history.addSystem(dim("trust prompt dismissed — treating project as untrusted for now"));
        }
        tui.requestRender();
    }

    // Active hooks summary (after trust is resolved so project hooks count).
    // Display command shortened to its script basename — full plugin paths
    // are too long for the startup banner.
    const shortCmd = (cmd: unknown): string => {
        // Malformed config entries can lack `command` — banner must not throw.
        if (typeof cmd !== "string" || !cmd) return "(invalid hook entry)";
        const script = cmd.match(/[^\s"']+\.(?:sh|js|ts|py|cmd|mjs|cjs)\b/)?.[0];
        if (script) return script.split("/").pop()!;
        return cmd.length > 48 ? `${cmd.slice(0, 45)}…` : cmd;
    };
    const hooksCfg = loadHooksConfig(state.cwd);
    const hookEvents = Object.entries(hooksCfg).filter(([, groups]) => groups?.length);
    if (hookEvents.length > 0) {
        const total = hookEvents.reduce(
            (n, [, groups]) => n + groups!.reduce((m, g) => m + (g.hooks?.length ?? 0), 0),
            0,
        );
        // Into the header's status block, not the end of the transcript: this
        // runs after the trust prompt, which on a resumed session is long after
        // the conversation is on screen.
        addStartupNotice(history, `hooks (${total}):`, "hook");
        for (const [ev, groups] of hookEvents) {
            const cmds = groups!.flatMap((g) => g.hooks ?? []).map((h) => shortCmd(h.command));
            addStartupNotice(history, dim(`    • ${ev}: ${cmds.join(", ")}`));
        }
        tui.requestRender();
    }

    // SessionStart hooks (now that trust is resolved): messages render in chat;
    // additionalContext rides the first user prompt.
    const h = await runHooks(
        "SessionStart",
        "startup",
        { session_id: state.session?.id, transcript_path: state.session?.path, source: "startup" },
        state.cwd,
    );
    for (const m of h.messages) history.addHook(m);
    for (const s of h.terminalSequences) process.stdout.write(s);
    if (h.additionalContext) {
        state.pendingInjection = state.pendingInjection
            ? `${state.pendingInjection}\n\n${h.additionalContext}`
            : h.additionalContext;
    }
    if (h.messages.length || h.additionalContext) tui.requestRender();

    startMcpServers(state, deps);
}

/**
 * Connect MCP servers in the background so a slow server never blocks startup.
 * Renders a one-line-per-server banner once connections settle.
 *
 * Anything held back is SAID so. Silence was the old behaviour whenever the
 * `mcp` setting was off or the folder untrusted, which is how a correctly
 * configured server came to look like a broken one: no banner, no error, no
 * tools, and no hint that the reason was a setting three levels away.
 */
export function startMcpServers(state: AppState, deps: AppDeps): void {
    const { tui, history } = deps;
    const configured = Object.keys(loadMcpServers(state.cwd));
    if (configured.length === 0) return;
    // MCP is on by default — only an explicit `mcp: false` turns it off.
    if (!isMcpEnabled()) {
        addStartupNotice(
            history,
            `MCP: off (mcp: false in settings) — ${configured.length} configured server(s) not connected`,
        );
        return;
    }
    // Project-scoped servers ride in with the repo, so they wait for trust the
    // way hooks and project skills do. User-scope servers connect regardless.
    const withheld = withheldProjectServers(state.cwd, isTrusted(state.cwd));
    if (withheld.length > 0) {
        addStartupNotice(
            history,
            `MCP: ${withheld.join(", ")} declared in ${CONFIG_DIR_NAME}/mcp.json — not connected until this project is trusted`,
            "hook",
        );
    }

    const manager = getMcpManager();
    // Server-side prompts become `/mcp:<server>:<prompt>` commands. Re-synced
    // on every catalog change, not just at startup: a server can announce
    // prompts/list_changed at any point, and a command list that only reflects
    // the launch-time servers is one people learn not to trust.
    const syncPrompts = () => {
        const changed = syncMcpPromptCommands(deps.commands, manager.listPrompts(), {
            getPrompt: (server, prompt, args) => manager.getPrompt(server, prompt, args),
        });
        if (changed) deps.refreshCommands();
    };
    manager.onPromptsChanged = syncPrompts;
    void manager.init(state.cwd).then(() => {
        syncPrompts();
        const servers = manager.listServers();
        if (servers.length === 0) return;
        const summary = servers
            .map((s) => (s.status === "ready" ? `${s.name} (${s.toolCount})` : `${s.name}: ${s.status}`))
            .join(", ");
        // Same block as the rest of the startup status, however late the
        // servers take to connect.
        addStartupNotice(history, `MCP: ${summary}`, "hook");
        for (const s of servers) {
            if (s.status === "error" && s.error) addStartupNotice(history, dim(`    • ${s.name}: ${s.error}`));
        }
        tui.requestRender();
    });
}
