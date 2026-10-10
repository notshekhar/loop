/**
 * Session lifecycle: /new, /clear, /compact, /resume, /session, /name,
 * /export, /import.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    CompactAbortedError,
    clearReadRegistry,
    runCompact,
    runHooks,
    sessionToJsonl,
    sessionToMarkdown,
    setProjectModel,
    settingsStore,
    LIVE_STATUS_ORDER,
    sessionTitle,
    teamOf,
    teamsOf,
    type CommandContext,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { renderSessionBranch } from "../replay";
import { defaultTabName, setTabName } from "../session-title";
import { copyToClipboard } from "../clipboard";
import { showWelcomeBanner } from "../welcome";
import { showWorkspaceBanners } from "../startup";
import { dim } from "../ui/text";
import { HERE, liveActivity, liveGlyph } from "../session-roster";

type SessionHandlers = Pick<
    CommandContext,
    | "newSession"
    | "clearScreen"
    | "manualCompact"
    | "showSessions"
    | "showSessionInfo"
    | "setSessionName"
    | "exportSession"
    | "importSession"
    | "shareSession"
>;

/**
 * Open a session by id or transcript path and swap it in as the live session
 * (model, status line, cost tracker, replayed history). Shared by /resume and
 * the /background manager's "open last run".
 */
export async function resumeSessionById(state: AppState, deps: AppDeps, idOrPath: string): Promise<void> {
    // Already live in this loop (running in the background, say): go to it
    // rather than open a second copy that would fight it over the transcript.
    const live = deps.sessions.findLive(idOrPath);
    if (live) {
        deps.sessions.switchTo(live);
        return;
    }
    // Never replace a session mid-turn: it keeps running, and the resumed
    // one opens beside it.
    if (state.busy) await deps.sessions.openNew();
    const { tui, history, statusLine, tracker, manager, refreshStatusLine } = deps;
    try {
        // The `/rc` server may already hold this session — a phone opened it,
        // or is running a turn in it right now. Use its object: a second copy
        // in this process appends to its own branch, and whichever writes
        // second drops the other's messages (the phone's reply, typically).
        const feed = deps.live.feed;
        let opened = feed?.openSession(idOrPath);
        if (!opened) {
            opened = await manager.open(idOrPath);
            opened = feed?.openSession(opened.id) ?? opened;
        }
        state.session = opened;
        const resumedModel = state.session.lastModel();
        if (resumedModel) {
            state.modelId = resumedModel;
            settingsStore.set("defaultModel", state.modelId);
            setProjectModel(state.cwd, state.modelId);
            statusLine.setModel(state.modelId);
        }
        statusLine.setSession(state.session.id);
        // The tab follows the session that is live now — the resumed one's own
        // name if it has one, and the standing name if it never earned one.
        setTabName(deps, state.session.getName() || defaultTabName());
        // Restore cost/usage/ctx from the resumed transcript.
        state.latestContextTokens = tracker.seedFromSession(state.session).ctxTokens;
        refreshStatusLine();
        history.reset();
        if (idOrPath.endsWith(".jsonl") && state.session.path !== idOrPath) {
            history.addSystem(`resumed fork ${state.session.id}`);
            history.addSystem(
                dim("selected legacy session was forked; new messages and compactions save to this session"),
            );
        } else {
            history.addSystem(`resumed session ${state.session.id}`);
        }
        renderSessionBranch(state.session, history, state.modelId, deps.todoPanel);
        // Mid-turn on the server: the rest of that reply streams in here.
        deps.remote?.followServerTurn(state.session.id);
    } catch (err) {
        history.addError(`open failed: ${(err as Error).message}`);
    }
    tui.requestRender();
}

/** Sessions per page in /resume. */
const RESUME_PAGE = 100;

export function createSessionHandlers(state: AppState, deps: AppDeps): SessionHandlers {
    const {
        tui,
        history,
        statusLine,
        tracker,
        manager,
        queuedMessages,
        refreshStatusLine,
        renderPending,
        showWorking,
        hideWorking,
        searchOnce,
        selectOnce,
        promptOnce,
    } = deps;

    /** "today 10:49 PM", "yesterday 9:12 AM", else locale date — keeps the
     * list scannable and makes "today"/"yesterday" searchable terms. */
    const formatSessionTime = (mtime: number): string => {
        const d = new Date(mtime);
        const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const today = startOfDay(new Date());
        if (d.getTime() >= today) return `today ${time}`;
        if (d.getTime() >= today - 86_400_000) return `yesterday ${time}`;
        return d.toLocaleString(undefined, { month: "numeric", day: "numeric", year: "numeric" }) + ` ${time}`;
    };

    // Abort a turn still streaming so /new and /clear don't leave it running
    // against the old session — the agent would keep appending to the cleared
    // session and burning tokens. Mirrors the Esc/Ctrl+C abort in input-handler.
    const abortActiveTurn = () => {
        if (!state.busy) return;
        state.abort.abort();
        state.abort = new AbortController();
        state.busy = false;
        hideWorking();
    };

    return {
        async newSession() {
            // A turn in flight is not thrown away: it carries on in the
            // background (Ctrl+S to go back) and the new session opens beside
            // it. Only an idle session is replaced in place, as before.
            if (state.busy) {
                await deps.sessions.openNew();
                history.addSystem(dim("previous session keeps running in the background · ctrl+s to switch"));
                tui.requestRender();
                return;
            }
            // Its reads only, not every live session's (the registry is keyed
            // by session; no id would clear them all).
            if (state.session) clearReadRegistry(state.session.id);
            state.session = null;
            statusLine.setSession("unsaved");
            // The tab named the session that just went away. Hand it back its
            // standing name — otherwise a fresh session sits under the last
            // one's title until it earns its own, which in cmux is a pane card
            // advertising work that no longer exists.
            setTabName(deps, defaultTabName());
            // Plan mode is keyed to the old session id — clear the UI flag so
            // the fresh session doesn't look gated.
            state.planModeViaCycle = false;
            statusLine.setPlanMode(false);
            deps.todoPanel.clear();
            tracker.reset();
            state.latestContextTokens = 0;
            refreshStatusLine();
            queuedMessages.length = 0;
            renderPending();
            history.reset();
            showWelcomeBanner(history, state, deps);
            // Re-show workspace context + active extensions so /new matches startup.
            await showWorkspaceBanners(history, state.cwd);
            tui.requestRender();
        },
        clearScreen() {
            // /clear is a new session too, and a running turn survives it the
            // same way: newSession opens the fresh one beside it.
            if (state.busy) return;
            abortActiveTurn();
            process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
            tracker.reset();
            state.latestContextTokens = 0;
            refreshStatusLine();
            history.reset();
            showWelcomeBanner(history, state, deps);
            // Fire-and-forget (clearScreen is sync): re-show context + extensions.
            void showWorkspaceBanners(history, state.cwd).then(() => tui.requestRender());
            tui.invalidate();
            tui.requestRender(true);
        },
        async manualCompact(focus?: string) {
            if (!state.session) {
                history.addSystem("nothing to compact");
                tui.requestRender();
                return;
            }
            if (state.busy) {
                history.addSystem("busy; finish or abort current turn first");
                tui.requestRender();
                return;
            }
            state.busy = true;
            showWorking("Compacting");
            tui.requestRender();
            try {
                // PreCompact is informational for watchers — block is ignored.
                await runHooks(
                    "PreCompact",
                    "manual",
                    { session_id: state.session.id, transcript_path: state.session.path, trigger: "manual" },
                    state.cwd,
                );
                const result = await runCompact({
                    session: state.session,
                    modelId: state.modelId,
                    manual: true,
                    ...(focus?.trim() ? { focus: focus.trim() } : {}),
                    abortSignal: state.abort.signal,
                    tracker: deps.tracker,
                    cwd: state.cwd,
                });
                if (result.summary) {
                    history.addCompactionSummary(result.summary, result.tokensBefore);
                    // The last reported size measured the context this replaced.
                    state.latestContextTokens = 0;
                    refreshStatusLine();
                } else {
                    history.addSystem("nothing to compact");
                }
            } catch (err) {
                if (err instanceof CompactAbortedError || state.abort.signal.aborted) {
                    history.addSystem("compact aborted");
                } else {
                    history.addError((err as Error).message);
                }
            } finally {
                state.busy = false;
                hideWorking();
            }
            tui.requestRender();
        },
        async showSessions() {
            // A page at a time, newest first: the picker asks for the next as
            // the cursor nears the end (or a search runs short of matches),
            // so a folder with thousands of sessions opens as fast as one
            // with ten.
            const sessions = manager.list(state.cwd, "active", { limit: RESUME_PAGE });
            let more = sessions.length === RESUME_PAGE;
            const nextPage = () => {
                if (!more) return [];
                const page = manager.list(state.cwd, "active", { limit: RESUME_PAGE, offset: sessions.length });
                more = page.length === RESUME_PAGE;
                sessions.push(...page);
                return page;
            };
            if (sessions.length === 0) {
                history.addSystem("no sessions in this cwd");
                tui.requestRender();
                return;
            }

            // Date buckets: first row cycles through them; type-to-search
            // (searchOnce) filters the rest by id/model/date/first message.
            const DAY = 86_400_000;
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const dateFilters: Array<{ label: string; test: (mtime: number) => boolean }> = [
                { label: "all", test: () => true },
                { label: "today", test: (t) => t >= todayStart },
                { label: "yesterday", test: (t) => t >= todayStart - DAY && t < todayStart },
                { label: "last 7 days", test: (t) => t >= todayStart - 6 * DAY },
                { label: "last 30 days", test: (t) => t >= todayStart - 29 * DAY },
            ];
            const FILTER_ROW = "\x00date-filter";
            let filterIndex = 0;

            let pick: SelectItem | null;
            while (true) {
                const filter = dateFilters[filterIndex];
                // Sessions live in this loop lead the list, in roster order
                // (needs you, working, done, …); the rest keep their recency.
                const live = new Map(sessions.map((s) => [s.id, deps.sessions.findLive(s.id)] as const));
                const rank = (id: string) => {
                    const slot = live.get(id);
                    return slot ? LIVE_STATUS_ORDER.indexOf(slot.status) : LIVE_STATUS_ORDER.length;
                };
                const sorted = sessions
                    .filter((s) => filter.test(s.mtime))
                    .sort((a, b) => rank(a.id) - rank(b.id));
                // Thread teams: a lead's threads sit right under it, indented,
                // instead of scattered through the list by recency.
                const teams = teamsOf(sorted.map((s) => s.id));
                const present = new Set(sorted.map((s) => s.id));
                const nested = (s: (typeof sessions)[number]) => {
                    const team = teams.get(s.id);
                    return team?.role === "member" && present.has(team.leadId);
                };
                const filtered: typeof sorted = [];
                for (const s of sorted) {
                    if (nested(s)) continue;
                    filtered.push(s);
                    if (teams.get(s.id)?.role !== "lead") continue;
                    filtered.push(
                        ...sorted
                            .filter((m) => teams.get(m.id)?.role === "member" && teams.get(m.id)?.leadId === s.id)
                            .sort((x, y) => x.createdAt - y.createdAt),
                    );
                }
                const liveCount = filtered.filter((s) => live.get(s.id)).length;
                const row = (s: (typeof sessions)[number]): SelectItem => {
                        const slot = live.get(s.id) ?? deps.sessions.findLive(s.id);
                        // Not-live rows get a blank where the glyph goes, so
                        // every title starts in the same column.
                        const badge = slot ? liveGlyph(slot) : " ";
                        const here = s.id === state.session?.id ? HERE : "";
                        const title = s.name
                            ? `${s.name}  ·  ${s.id.slice(0, 12)}`
                            : `${s.id.slice(0, 12)}  ${s.model || "?"}`;
                        const team = teamOf(s.id);
                        const indent = team?.role === "member" && present.has(team.leadId) ? "  ├ " : "";
                        const teamNote =
                            team?.role === "member"
                                ? indent
                                    ? `${team.state} · `
                                    : `thread of “${sessionTitle(team.leadId)}” · `
                                : (deps.team?.teamLabel(s.id) ?? "");
                        return {
                            value: s.path,
                            label: `${indent}${badge} ${title}`,
                            description: `${here}${teamNote}${slot ? liveActivity(slot) : ""}${formatSessionTime(s.mtime)}  ·  ${s.firstUserMessage?.slice(0, 80) ?? "(no messages)"}`,
                        };
                };
                const items: SelectItem[] = [
                    {
                        value: FILTER_ROW,
                        label: `⏷ date: ${filter.label}`,
                        description: "Enter cycles · all → today → yesterday → last 7 days → last 30 days",
                    },
                    ...filtered.map(row),
                ];
                const liveNote = liveCount > 0 ? ` · ${liveCount} live` : "";
                pick = await searchOnce(
                    items,
                    `Resume session · ${filtered.length}${more ? "+" : `/${sessions.length}`}${liveNote}`,
                    {
                        // An empty answer means "no more", so a page the date
                        // filter empties is skipped, not returned.
                        loadMore: async () => {
                            for (let page = nextPage(); page.length > 0; page = nextPage()) {
                                const matching = page.filter((s) => filter.test(s.mtime));
                                if (matching.length > 0) return matching.map(row);
                            }
                            return [];
                        },
                    },
                );
                if (!pick) return;
                if (pick.value === FILTER_ROW) {
                    filterIndex = (filterIndex + 1) % dateFilters.length;
                    continue;
                }
                break;
            }
            await resumeSessionById(state, deps, pick.value);
        },
        showSessionInfo() {
            const s = tracker.sessionBreakdown();
            history.addSystem(`session id   ${state.session?.id ?? "unsaved"}`);
            if (state.session?.getName()) history.addSystem(`name         ${state.session.getName()}`);
            history.addSystem(`model        ${state.modelId}`);
            history.addSystem(`provider     ${state.provider}`);
            history.addSystem(`thinking     ${state.thinkingLevel}`);
            history.addSystem(`cwd          ${state.cwd}`);
            history.addSystem(`tokens       in:${s.inputTokens} out:${s.outputTokens} cache:${s.cachedInputTokens}`);
            history.addSystem(`cost (sess)  $${s.usd.toFixed(4)}`);
            tui.requestRender();
        },
        async setSessionName(name) {
            if (!state.session) {
                history.addSystem("session is unsaved — send a message first");
                tui.requestRender();
                return;
            }
            // /name with no arg opens an inline rename prompt prefilled with
            // the current name (diverges, which just prints it).
            let next = name.trim();
            if (!next) {
                next = (await promptOnce("session name", state.session.getName() ?? "")).trim();
                if (!next) return;
            }
            await state.session.setName(next);
            // A name the user chose outranks the generated one everywhere the
            // session is shown, the tab included (Claude Code's /rename does
            // the same).
            setTabName(deps, next);
            history.addSystem(`session name → ${next}`);
            tui.requestRender();
        },
        async exportSession(target) {
            if (!state.session) {
                history.addSystem("session is unsaved");
                tui.requestRender();
                return;
            }
            const out = target ?? `${state.session.id}.jsonl`;
            const content = sessionToJsonl(state.session.entries());
            writeFileSync(out, content);
            history.addSystem(`exported to ${out}`);
            tui.requestRender();
        },
        async shareSession() {
            const session = state.session;
            if (!session) {
                history.addSystem("session is unsaved — send a message first");
                tui.requestRender();
                return;
            }
            if (!Bun.which("gh")) {
                history.addError("gh CLI not found — install it (brew install gh), then run: gh auth login");
                tui.requestRender();
                return;
            }
            const md = sessionToMarkdown(session);
            const jsonl = sessionToJsonl(session.entries());
            const confirm = await selectOnce(
                [
                    { value: "yes", label: `create secret gist (transcript.md ${md.length} chars + raw .jsonl)` },
                    { value: "no", label: "cancel" },
                ],
                "share — uploads this session to GitHub as a secret gist",
            );
            if (confirm?.value !== "yes") return;

            const dir = mkdtempSync(join(tmpdir(), "loop-share-"));
            const mdPath = join(dir, "transcript.md");
            const jsonlPath = join(dir, `${session.id}.jsonl`);
            writeFileSync(mdPath, md);
            writeFileSync(jsonlPath, jsonl);
            showWorking("Creating secret gist");
            try {
                const desc = `loop session ${session.getName() ?? session.id}`;
                const result = await new Promise<{ code: number; out: string; err: string }>((done) => {
                    const child = spawn("gh", ["gist", "create", "--secret", "--desc", desc, mdPath, jsonlPath]);
                    let out = "";
                    let err = "";
                    child.stdout.on("data", (d) => (out += String(d)));
                    child.stderr.on("data", (d) => (err += String(d)));
                    child.on("close", (code) => done({ code: code ?? 1, out, err }));
                    child.on("error", (e) => done({ code: 1, out, err: e.message }));
                });
                hideWorking();
                if (result.code !== 0) {
                    const hint = /auth/i.test(result.err) ? " — run: gh auth login" : "";
                    history.addError(`gist create failed: ${result.err.trim() || "unknown error"}${hint}`);
                } else {
                    const url = result.out.trim().split("\n").pop() ?? "";
                    history.addSystem(`secret gist: ${url}`);
                    copyToClipboard(url, (ok) => {
                        if (!ok) return;
                        history.addSystem(dim("(url copied to clipboard)"));
                        tui.requestRender();
                    });
                }
            } finally {
                hideWorking();
                rmSync(dir, { recursive: true, force: true });
            }
            tui.requestRender();
        },
        async importSession(path) {
            try {
                const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
                const ns = await manager.create({ cwd: state.cwd, provider: state.provider, model: state.modelId });
                for (const line of lines) {
                    try {
                        await ns.append(JSON.parse(line));
                    } catch {}
                }
                state.session = ns;
                statusLine.setSession(state.session.id);
                history.addSystem(`imported ${lines.length} entries → session ${state.session.id}`);
            } catch (err) {
                history.addError(`import failed: ${(err as Error).message}`);
            }
            tui.requestRender();
        },
    };
}
