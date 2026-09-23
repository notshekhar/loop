/**
 * Everything that isn't session/model/agent/hook/settings management:
 * command IO (emit), /cost, /changelog, /hotkeys, /copy, /attach, /cwd,
 * /login, /logout, /quit, and the not-implemented stub.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    buildSteakGrid,
    filterAttachmentsByModalities,
    getCatalog,
    getMcpManager,
    listMemoryFiles,
    loadMemoryContext,
    runRecap,
    type CommandContext,
    formatTokens,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { copyToClipboard } from "../clipboard";
import { readClipboardImageToFile } from "../clipboard-image";
import { startLogin, startLogout } from "../login-flow";
import { loadChangelogEntries } from "../../changelog";
import { resolveAvailableUpdate, runUpgrade } from "../../commands";
import { accent, dim, heading, warn } from "../ui/text";
import { theme } from "../ui/theme";

type MiscHandlers = Pick<
    CommandContext,
    | "emit"
    | "showCost"
    | "showSteak"
    | "showChangelog"
    | "showHotkeys"
    | "copyLastAssistant"
    | "attachImage"
    | "exit"
    | "setCwd"
    | "startLogin"
    | "startLogout"
    | "updateApp"
    | "stub"
    | "generateRecap"
    | "openMemory"
>;

export function createMiscHandlers(state: AppState, deps: AppDeps): MiscHandlers {
    const { tui, history, tracker, manager, editor, selectOnce, searchOnce, promptOnce, cleanExit, refreshCommands } =
        deps;
    const loginDeps = { tui, history, selectOnce, searchOnce, promptOnce };

    const fmtTok = (n: number) => formatTokens(n);

    /** Render the GitHub-style token heatmap; shared by /steak and /cost. */
    const printSteak = (args: string) => {
        const trimmed = (args ?? "").trim();
        const opts = /^\d{4}$/.test(trimmed) ? { year: Number(trimmed) } : {};
        const grid = buildSteakGrid(manager.dailyTokens(), opts);

        // Intensity is relative, so the wall reads the same whether you burn
        // 10k or 10M a day. The ramp walks the theme's success colour out of
        // the canvas rather than pinning GitHub's greens, which sat oddly on
        // any theme that was not GitHub dark.
        const square = (lvl: number) => (lvl < 0 ? " " : theme.heat(lvl, "■"));
        const GUTTER = 4; // "Mon " etc.

        const period = "year" in opts ? String(opts.year) : "the last year";
        history.addSystem(heading(`🥩 ${fmtTok(grid.totalTokens)} tokens in ${period}`));
        history.addSystem("");

        // Month label row: drop each abbrev at its column, 1 char per week.
        const monthRow: string[] = new Array(GUTTER + grid.weeks).fill(" ");
        for (let c = 0; c < grid.weeks; c++) {
            const lbl = grid.monthLabels[c];
            for (let i = 0; i < lbl.length && GUTTER + c + i < monthRow.length; i++) {
                monthRow[GUTTER + c + i] = lbl[i];
            }
        }
        history.addSystem(dim(monthRow.join("")));

        const dayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];
        for (let r = 0; r < 7; r++) {
            let line = dim(dayLabels[r].padEnd(GUTTER));
            for (let c = 0; c < grid.weeks; c++) line += square(grid.cells[r][c]);
            history.addSystem(line);
        }

        const legend = [0, 1, 2, 3, 4].map((l) => theme.heat(l, "■")).join("");
        history.addSystem("");
        history.addSystem(`${" ".repeat(GUTTER)}${dim("Less ")}${legend}${dim(" More")}`);

        // Streak stats, computed in core alongside the grid — same numbers
        // the web UI's usage dialog shows.
        const st = grid.stats;
        const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
        const fmtDay = (key: string) => {
            const [y, m, d] = key.split("-").map(Number);
            return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
            });
        };
        const stat = (label: string, value: string, note = "") =>
            history.addSystem(`  ${dim(label.padEnd(16))}${accent(value)}${note ? `   ${dim(note)}` : ""}`);
        history.addSystem("");
        stat("current streak", days(st.currentStreak), st.currentStreak >= 3 ? "🔥" : "");
        stat("longest streak", days(st.longestStreak));
        stat("active days", String(st.activeDays));
        if (st.busiestDay) stat("busiest day", `${fmtTok(st.busiestDayTokens)} tokens`, fmtDay(st.busiestDay));
    };

    return {
        emit(event, data) {
            if (event === "help" || event === "error") history.addSystem(String(data ?? ""));
            if (event === "commands-changed") refreshCommands();
            if (event === "inject-prompt") state.pendingInjection = String(data ?? "");
            // Both submit immediately as if the user sent the text; run-prompt
            // is the non-skill variant (/init and friends).
            if (event === "inject-skill" || event === "run-prompt") {
                const text = String(data ?? "");
                if (text && editor.onSubmit) void editor.onSubmit(text);
            }
            tui.requestRender();
        },
        showCost() {
            // Lead with the usage heatmap (trailing year), then the $ breakdown.
            printSteak("");
            history.addSystem("");

            const s = tracker.sessionBreakdown();
            const st = tracker.stats(state.cwd);
            const fmtUsd = (v: number) => `$${v.toFixed(4)}`;
            const row = (label: string, usd: number, extra = "") =>
                history.addSystem(
                    `  ${dim(label.padEnd(14))}${accent(fmtUsd(usd).padStart(10))}${extra ? `   ${dim(extra)}` : ""}`,
                );

            history.addSystem(heading("cost"));
            row(
                "session",
                s.usd,
                `in:${fmtTok(s.inputTokens)} out:${fmtTok(s.outputTokens)} cache:${fmtTok(s.cachedInputTokens)}`,
            );
            row("directory", st.cwdUsd, state.cwd.replace(process.env.HOME ?? "", "~"));
            row("today", st.todayUsd);
            row("last 7 days", st.last7Usd);
            row("this month", st.monthUsd);
            row("lifetime", st.lifetimeUsd);
            const providers = Object.entries(st.byProvider)
                .filter(([, v]) => v > 0)
                .sort((a, b) => b[1] - a[1]);
            for (const [p, v] of providers) row(`  ${p}`, v);
            // Daily/cwd buckets are new — older lifetime spend predates them.
            if (st.lifetimeUsd > 0 && st.monthUsd === 0 && st.cwdUsd === 0) {
                history.addSystem(dim("  (time/directory tracking starts now — lifetime includes earlier spend)"));
            }
            tui.requestRender();
        },
        showSteak(args) {
            printSteak(args);
            tui.requestRender();
        },
        showChangelog() {
            const entries = loadChangelogEntries();
            if (entries.length === 0) {
                history.addSystem("no changelog entries found");
                tui.requestRender();
                return;
            }
            history.addMarkdown(entries.map((e) => e.content).join("\n\n"));
            tui.requestRender();
        },
        showHotkeys() {
            const lines = [
                "Enter           submit",
                "Shift+Enter     newline",
                "Tab             completion (slash commands, @ files)",
                "Shift+Tab       cycle agent",
                "@ / #           file completion while typing",
                "Up / Down       history (Up on first line, like a shell)",
                "Cmd+Backspace   delete to line start (kitty-protocol terminals)",
                "Cmd+←/→ ↑/↓     line start/end · input start/end",
                "Cmd+Z / Ctrl+-  undo",
                "Opt+←/→         word jump · Opt+Backspace delete word",
                "Ctrl+V          attach image from clipboard (Cmd+V is the terminal's)",
                "Ctrl+I          attach image from a file picker",
                "Esc             abort current turn",
                "Ctrl+C          abort, twice to quit",
                "Ctrl+D          quit (empty)",
                'Ctrl+G          send "continue" (resume interrupted work)',
                "Ctrl+L          clear screen",
                "Ctrl+P          cycle scoped models",
                "Ctrl+E          give the keyboard to the transcript;",
                "                inside: arrows or a click select, →/← open/fold, e expand all,",
                "                d density, y copy, Esc back to the prompt",
                "PgUp / PgDn     scroll the conversation · Home / End top / bottom",
                "Ctrl+↑/↓        jump to the previous / next prompt",
                "Ctrl+Shift+F    search the conversation; Enter next, Shift+Enter previous, Esc close",
                "Mouse           wheel scrolls, drag selects text (click selects an entry in Ctrl+E)",
            ];
            for (const l of lines) history.addSystem(l);
            tui.requestRender();
        },
        async copyLastAssistant() {
            const entries = state.session?.entries() ?? [];
            const last = [...entries]
                .reverse()
                .find((e) => e.type === "message" && (e as { role?: string }).role === "assistant");
            if (!last) {
                history.addSystem("no assistant message to copy");
                tui.requestRender();
                return;
            }
            const text = String((last as { content: unknown }).content ?? "");
            copyToClipboard(text, (ok) => {
                history.addSystem(
                    ok
                        ? `copied ${text.length} chars to clipboard`
                        : `no clipboard tool available. content length: ${text.length}`,
                );
                tui.requestRender();
            });
        },
        async attachImage(givenPath) {
            const cat = await getCatalog();
            const info = cat[state.modelId];
            // Same acceptance rule as drops/turns: images need the "image"
            // modality; PDFs need "pdf" AND a provider that takes inline PDF
            // bytes (catalog modality alone lies — xAI lists pdf but throws).
            const isPdf = (givenPath ?? "").toLowerCase().endsWith(".pdf");
            const probe = filterAttachmentsByModalities(
                [
                    {
                        data: Buffer.alloc(0),
                        mediaType: isPdf ? "application/pdf" : "image/png",
                        path: givenPath ?? "x.png",
                    },
                ],
                info?.modalities,
                state.modelId.split("/")[0],
            );
            if (probe.allowed.length === 0) {
                history.addSystem(
                    warn(
                        isPdf
                            ? `${state.modelId} cannot take PDF attachments (provider needs inline-PDF support). Try an anthropic/google/openai model.`
                            : `${state.modelId} does not accept images. Pick a vision model via /model first.`,
                    ),
                );
                tui.requestRender();
                return;
            }
            let path = givenPath;
            if (!path) {
                path = readClipboardImageToFile() ?? undefined;
                if (!path) {
                    history.addSystem(
                        warn(
                            "no image in clipboard. Copy one (Cmd+C on a Finder file or screenshot), use `/attach <path>`, or press Ctrl+I to pick a file.",
                        ),
                    );
                    tui.requestRender();
                    return;
                }
            }
            if (!existsSync(path)) {
                history.addError(`file not found: ${path}`);
                tui.requestRender();
                return;
            }
            const token = `[image:${path}]`;
            const current = editor.getText?.() ?? "";
            const sep = current && !current.endsWith(" ") ? " " : "";
            editor.setText?.(`${current}${sep}${token} `);
            tui.requestRender();
        },
        exit() {
            cleanExit(0);
        },
        setCwd(p) {
            const input = p.trim();
            const expanded =
                input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
            let target = resolve(state.cwd, expanded);
            let isDir = false;
            try {
                isDir = statSync(target).isDirectory();
                // Sessions are keyed by the canonical cwd (process.cwd()
                // resolves symlinks and on-disk case). A typed path like
                // /tmp/x or ~/documents must land on the same key, or
                // /resume in the new directory comes up empty.
                target = realpathSync.native(target);
            } catch {}
            if (!isDir) {
                history.addError(`couldn't find a directory at ${target}`);
                tui.requestRender();
                return;
            }
            state.cwd = target;
            // MCP is project-aware — `.loop/mcp.json` and the trust decision
            // both belong to a folder — so it has to move too, or it keeps
            // serving the directory loop was launched in. In the background:
            // a connect is up to 30s per server and `/cd` must stay instant.
            void getMcpManager()
                .setCwd(target)
                .catch(() => {
                    // A server that fails to connect in the new folder shows up
                    // in /mcp with its own error; `cd` itself still succeeded.
                });
            // Move the session's home so /resume finds it under the new
            // directory; an unsaved session just picks up the new cwd on save.
            if (state.session) {
                manager.moveSession(state.session, target);
                history.addSystem(`cwd → ${target} (session moved)`);
            } else {
                history.addSystem(`cwd → ${target}`);
            }
            tui.requestRender();
        },
        startLogin(target) {
            return startLogin(loginDeps, target);
        },
        startLogout(target) {
            return startLogout(loginDeps, target);
        },
        async updateApp() {
            if (state.busy) {
                history.addSystem("busy; finish or abort current turn first");
                tui.requestRender();
                return;
            }
            const version = deps.version ?? "0.0.0";
            deps.showWorking("Checking for updates");
            const latest = await resolveAvailableUpdate(version);
            deps.hideWorking();
            if (!latest) {
                history.addSystem(`already up to date (v${version})`);
                tui.requestRender();
                return;
            }
            history.addSystem(`updating v${version} → ${latest}…`);
            tui.requestRender();
            // Hand the terminal to the installer: stop rendering, restore
            // console, let the platform install script take over. runUpgrade
            // exits the process when the installer finishes.
            tui.stop();
            deps.restoreConsole();
            await runUpgrade(version);
        },
        stub(name) {
            history.addSystem(warn(`/${name} not implemented yet`));
            tui.requestRender();
        },
        async openMemory() {
            if (state.busy) {
                history.addSystem("busy; finish or abort current turn first");
                tui.requestRender();
                return;
            }
            const candidates = listMemoryFiles(state.cwd);
            // Agent memory index (auto-saved facts) edits alongside the
            // instruction files — same picker, same editor flow.
            const memIndex = loadMemoryContext(state.cwd).indexPath;
            candidates.push({ label: "Agent memory (auto)", path: memIndex, exists: existsSync(memIndex) });
            const items = candidates.map((c) => ({
                value: c.path,
                label: `${c.label.padEnd(24)} ${c.path.replace(process.env.HOME ?? "", "~")}${c.exists ? "" : dim(" (create)")}`,
            }));
            const pick = await selectOnce(items, "memory — pick a file to edit");
            if (!pick) return;
            const path = pick.value;
            const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";
            try {
                mkdirSync(dirname(path), { recursive: true });
            } catch {}
            // Hand the terminal to the editor. spawnSync on purpose (the
            // upstream interactive-shell pattern): blocking the event loop
            // means no ticker/render can write over the editor's screen, and
            // stdin never goes through an async pause/resume cycle — the
            // async-spawn version came back with dead input.
            // preserveScreen: the session is coming back (tui.start() below),
            // so leaving the alternate screen must not paint the whole
            // transcript into the terminal on the way out — the editor is
            // about to cover it anyway, and the copy belongs on the real exit.
            tui.stop({ preserveScreen: true });
            process.stdout.write("\x1b[2J\x1b[H");
            const shell = process.env.SHELL || "/bin/sh";
            const quoted = `'${path.replace(/'/g, "'\\''")}'`;
            const result = spawnSync(shell, ["-c", `${editorCmd} ${quoted}`], {
                stdio: "inherit",
                env: process.env,
            });
            tui.start();
            if (result.error) history.addError(`editor failed (${editorCmd}): ${result.error.message}`);
            else history.addSystem(`edited ${path} — next turn picks it up`);
            tui.requestRender(true);
        },
        async generateRecap() {
            const session = state.session;
            if (!session || state.busy) {
                history.addSystem(state.busy ? "busy; wait for the turn to finish" : "nothing to recap yet");
                tui.requestRender();
                return;
            }
            // Last turn = last user message on the branch + everything after it.
            const branch = session.getBranch();
            const textOf = (content: unknown): string => {
                if (typeof content === "string") return content;
                if (!Array.isArray(content)) return "";
                return (content as Array<{ type?: string; text?: string }>)
                    .filter((p) => p?.type === "text" && typeof p.text === "string")
                    .map((p) => p.text)
                    .join("\n");
            };
            let lastUser = -1;
            for (let i = branch.length - 1; i >= 0; i--) {
                const e = branch[i] as { type: string; role?: string };
                if (e.type === "message" && e.role === "user") {
                    lastUser = i;
                    break;
                }
            }
            let assistantText = "";
            const toolsUsed: string[] = [];
            for (let i = lastUser + 1; i < branch.length; i++) {
                const e = branch[i] as { type: string; role?: string; content?: unknown };
                if (e.type !== "message" || e.role !== "assistant") continue;
                assistantText += textOf(e.content);
                if (Array.isArray(e.content)) {
                    for (const p of e.content as Array<{ type?: string; toolName?: string }>) {
                        if (p?.type === "tool-call" && p.toolName) toolsUsed.push(p.toolName);
                    }
                }
            }
            if (lastUser < 0 || !assistantText.trim()) {
                history.addSystem("no completed turn to recap");
                tui.requestRender();
                return;
            }
            deps.showWorking("Generating recap");
            try {
                const text = await runRecap({
                    session,
                    modelId: state.modelId,
                    userInput: textOf((branch[lastUser] as { content?: unknown }).content),
                    assistantText,
                    toolsUsed,
                    tracker,
                    cwd: state.cwd,
                });
                deps.hideWorking();
                if (text) history.addRecap(text);
                else history.addSystem("recap came back empty");
                deps.refreshStatusLine();
            } catch (err) {
                deps.hideWorking();
                history.addError(`recap failed: ${(err as Error).message}`);
            }
            tui.requestRender();
        },
    };
}
