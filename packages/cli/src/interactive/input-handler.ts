import type { CommandContext } from "@notshekhar/loop-core";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import {
    isAltDown,
    isAltUp,
    isCtrlC,
    isCtrlD,
    isCtrlDown,
    isCtrlE,
    isCtrlG,
    isCtrlI,
    isCtrlL,
    isCtrlP,
    isCtrlUp,
    isCtrlV,
    isDown,
    isEnd,
    isEnter,
    isEsc,
    isHome,
    isKeyboardInput,
    isClearLine,
    isLeft,
    isPageDown,
    isPageUp,
    isPrintableChar,
    isRight,
    countWheelScroll,
    MOUSE_SGR_ANY,
    isShiftLeft,
    isShiftRight,
    isShiftTab,
    isTab,
    isUp,
} from "./keys";
import { isKeyRelease } from "@notshekhar/loop-tui";
import { activeUiMode, getToolDetail, nextToolDetail, setLiveVariant, setToolDetail } from "./ui/ui-mode";
import { copyToClipboard, readClipboardText } from "./clipboard";
import { traceEvent } from "./debug-log";
import { pickImageFile, readClipboardImageToFile } from "./clipboard-image";
import { ClipboardImageTip } from "./clipboard-tip";
import {
    agentExists,
    extractImagesFromInput,
    filterAttachmentsByModalities,
    getModelSync,
    getSetting,
    isPlanModeActive,
    listAgents,
    PLAN_AGENT_NAME,
    playCue,
    playMaxCue,
    setPlanMode,
    settingsStore,
} from "@notshekhar/loop-core";

export type InputListener = (data: string) => { consume: boolean } | undefined;

// Terminals deliver both clipboard pastes and file drag-and-drop as a bracketed
// paste: ESC[200~ <content> ESC[201~ (the TUI re-wraps its paste event this way).
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

/**
 * True for a paste that carried no text at all.
 *
 * This is what Cmd+V looks like when the clipboard holds an image: the
 * terminal owns Cmd+V, reads the clipboard's *text* flavour, finds none, and
 * sends an empty paste. The keystroke never reaches us as a chord, so the
 * empty paste is the only trace of it — treat it as "the user tried to paste
 * something we should go look for".
 */
function isEmptyPaste(data: string): boolean {
    const paste = BRACKETED_PASTE.exec(data);
    return paste !== null && paste[1].trim() === "";
}

/**
 * If a paste / drag-and-drop is *purely* attachable file path(s) — images or
 * PDFs, nothing but the path(s) modulo surrounding whitespace — return them,
 * split by whether the active model's catalog modalities accept each (image
 * files need "image", PDFs need "pdf"; unknown modalities allow everything).
 * Mixed pastes ("look at ./a.png") return null and fall through to the editor
 * untouched; submit-time extraction still handles those.
 */
function droppedAttachments(
    data: string,
    cwd: string,
    modelId: string,
): { allowed: string[]; rejected: string[] } | null {
    const paste = BRACKETED_PASTE.exec(data);
    if (!paste) return null;
    const { textWithoutPaths, images } = extractImagesFromInput(paste[1], cwd);
    if (images.length === 0 || textWithoutPaths.trim() !== "") return null;
    const { allowed, rejected } = filterAttachmentsByModalities(
        images,
        getModelSync(modelId)?.modalities,
        modelId.split("/")[0],
    );
    return { allowed: allowed.map((i) => i.path), rejected: rejected.map((i) => i.path) };
}

/** The navigation key hint. Carries the current density, since `d` cycles it
 * and a cycle with no visible state is a key nobody trusts. */
const scrollbackHint = (): string =>
    `live · ↑/↓ select · shift+←/→ turn · →/← open/fold · Enter toggle · e all · d detail:${getToolDetail()} · wheel/PgUp scroll · y copy · ctrl+e/Esc exit`;

export function createInputHandler(state: AppState, deps: AppDeps, ctx: CommandContext): InputListener {
    const { tui, history, queuedMessages, renderPending, hideWorking, cleanExit, editor, statusLine } = deps;

    const clipboardTip = new ClipboardImageTip();

    /** Would an image attach right now? Gates the tip's pasteboard probe. */
    const imagePasteEligible = (editorFocused: boolean): boolean => {
        if (!editorFocused || state.busy || state.scrollbackFocus || deps.getSelectorDepth() !== 0) return false;
        const probe = filterAttachmentsByModalities(
            [{ data: Buffer.alloc(0), mediaType: "image/png", path: "x.png" }],
            getModelSync(state.modelId)?.modalities,
            state.modelId.split("/")[0],
        );
        return probe.allowed.length > 0;
    };

    /**
     * Enter/leave the active mode's live variant. Live is a STATE of the mode
     * you are already in, not a mode of its own — the theme and canvas never
     * change, so flipping in and out mid-turn only moves the frame and the
     * folds.
     */
    const setLive = (on: boolean): void => {
        if (setLiveVariant(on)) history.invalidate();
    };

    /**
     * The live state the user actually chose (the `uiLive` setting, honoured
     * only by modes that have a live variant) — the same expression theme.ts
     * applies at startup.
     *
     * Leaving navigation has to come back to THIS, not to off: a user whose
     * mode starts live was being dropped out of live every time they left nav,
     * which looks exactly like the transcript un-grouping itself.
     */
    const preferredLive = (): boolean => Boolean(getSetting("uiLive")) && Boolean(activeUiMode().live);

    const enterScrollbackFocus = (): boolean => {
        if (!history.selectLast()) return false;
        state.scrollbackFocus = true;
        setLive(true);
        history.setViewport(true);
        statusLine.setHint(scrollbackHint());
        // SGR mouse reporting, live-scoped: the wheel scrolls the window here;
        // outside it the terminal keeps native selection/copy behavior.
        tui.terminal.write("\x1b[?1006h\x1b[?1000h");
        tui.requestRender();
        return true;
    };

    const exitScrollbackFocus = (): void => {
        state.scrollbackFocus = false;
        setLive(preferredLive());
        history.setViewport(false);
        history.clearSelection();
        // Folds opened while navigating are part of navigating — the prompt
        // gets the mode's default view back, not whatever was left open.
        history.resetFolds();
        statusLine.setHint(null);
        tui.terminal.write("\x1b[?1000l\x1b[?1006l");
        if (wheelTimer) {
            clearTimeout(wheelTimer);
            wheelTimer = null;
            wheelAccum = 0;
        }
        tui.requestRender();
    };

    // Wheel deltas coalesce over a short window and apply as ONE net scroll:
    // macOS trackpads emit micro-events that alternate direction on slow
    // scrolls (lift-off/momentum jitter) — applied individually they made the
    // window flicker back and forth between the same lines.
    let wheelAccum = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const WHEEL_COALESCE_MS = 30;
    const queueWheel = (delta: number): void => {
        wheelAccum += delta;
        if (wheelTimer) return;
        wheelTimer = setTimeout(() => {
            wheelTimer = null;
            const page = history.viewportPage();
            const net = Math.max(-page, Math.min(page, wheelAccum * 2));
            wheelAccum = 0;
            if (net !== 0 && state.scrollbackFocus) {
                history.scrollViewportLines(net);
                tui.requestRender();
            }
        }, WHEEL_COALESCE_MS);
    };

    /**
     * Move to the next density and persist it.
     *
     * `full` is not a style knob — it is the expand-all flag the transcript
     * already owns, the same one `e` toggles — so it is applied here rather
     * than resolved in the style spec. That keeps ONE mechanism for "everything
     * is open" instead of two that can disagree; the cost is that pressing `e`
     * afterwards can leave the two out of step, which is why leaving `full`
     * closes everything again rather than trying to remember what `e` did.
     */
    const cycleToolDetail = (): void => {
        const next = nextToolDetail();
        setToolDetail(next);
        settingsStore.set("toolDetail", next);
        history.setToolsExpanded(next === "full");
        history.invalidate();
        statusLine.setHint(scrollbackHint());
        tui.requestRender();
    };

    const copySelected = (): void => {
        const text = history.getSelectedText();
        if (text === null) return;
        copyToClipboard(text, (ok) => {
            history.addSystem(
                ok
                    ? `copied ${text.length} chars to clipboard`
                    : `no clipboard tool available. content length: ${text.length}`,
            );
            tui.requestRender();
        });
    };

    /** Map a clicked screen row (1-based) to the chat history's own rendered
     * lines and select the entry there. The transcript is the first thing in
     * the document, so its line under a screen row is the row plus however far
     * the window it is shown through has scrolled — whether that window is the
     * whole screen (flowing layout) or the transcript's own pane (pinned).
     * Component renders are pure, so measuring by re-rendering is safe
     * (clicks are rare). */
    const selectAtScreenRow = (row: number): boolean => {
        const { top, height } = deps.transcriptViewport();
        const screenLine = row - 1;
        if (screenLine < 0 || screenLine >= height) return false;
        const local = screenLine + top;
        if (local >= history.render(tui.terminal.columns).length) return false;
        return history.clickAtLocalLine(local);
    };

    /** grok's scrollback focus: Tab (on an empty prompt) hands the keyboard to
     * the transcript — arrows walk entries, Left/Right fold, letters bounce
     * straight back to the prompt and type. */
    const handleScrollbackFocus = (data: string): { consume: boolean } | undefined => {
        if (isUp(data) || isDown(data) || isCtrlUp(data) || isCtrlDown(data)) {
            if (history.moveSelection(isUp(data) || isCtrlUp(data) ? -1 : 1)) tui.requestRender();
            return { consume: true };
        }
        if (isShiftLeft(data) || isShiftRight(data) || isAltUp(data) || isAltDown(data)) {
            if (history.jumpTurn(isShiftLeft(data) || isAltUp(data) ? -1 : 1)) tui.requestRender();
            return { consume: true };
        }
        if (isLeft(data) || isRight(data)) {
            if (history.setSelectedExpanded(isRight(data))) tui.requestRender();
            return { consume: true };
        }
        if (isEnter(data)) {
            if (history.toggleSelected()) tui.requestRender();
            return { consume: true };
        }
        // Window scrolling without moving the selection (grok's scroll keys).
        if (isPageUp(data) || isPageDown(data)) {
            history.scrollViewportLines(isPageUp(data) ? -history.viewportPage() : history.viewportPage());
            tui.requestRender();
            return { consume: true };
        }
        if (isCtrlD(data) || data === "\x15" /* ctrl+u */) {
            history.scrollViewportLines(
                isCtrlD(data) ? Math.ceil(history.viewportPage() / 2) : -Math.ceil(history.viewportPage() / 2),
            );
            tui.requestRender();
            return { consume: true };
        }
        if (isHome(data) || isEnd(data)) {
            history.scrollViewportEdge(isHome(data) ? "top" : "bottom");
            tui.requestRender();
            return { consume: true };
        }
        // Mouse wheel: coalesced (see queueWheel) — 2 lines per net event,
        // one-page cap per window, direction jitter cancels to zero.
        const wheel = countWheelScroll(data);
        if (wheel !== 0) {
            queueWheel(wheel);
            return { consume: true };
        }
        // Left-click selects the entry under the pointer (button 0 press; no
        // wheel/motion bits — modifier bits are fine).
        const click = /^\x1b\[<(\d+);(\d+);(\d+)M/.exec(data);
        if (click) {
            const button = Number(click[1]);
            if ((button & 0b1100011) === 0 && selectAtScreenRow(Number(click[3]))) tui.requestRender();
            return { consume: true };
        }
        if (MOUSE_SGR_ANY.test(data)) return { consume: true };
        // e: expand/collapse everything (the viewport re-anchors on the
        // selection, so this never flings the screen to the bottom).
        if (data === "e") {
            history.toggleToolsExpanded();
            tui.requestRender();
            return { consume: true };
        }
        // d: cycle how much of a finished call the transcript shows. The
        // density is the escape hatch for the rows receipts and peeks add —
        // `compact` is the one-line-per-call look, `full` opens everything.
        if (data === "d") {
            cycleToolDetail();
            return { consume: true };
        }
        if (data === "y") {
            copySelected();
            return { consume: true };
        }
        if (isEsc(data) || isCtrlE(data) || isTab(data) || data === " " || data === "q") {
            exitScrollbackFocus();
            return { consume: true };
        }
        // Any other printable key: back to the prompt, and let the editor
        // receive this very keystroke (grok's letter-key auto-focus).
        if (isPrintableChar(data) || BRACKETED_PASTE.test(data)) {
            exitScrollbackFocus();
            return undefined;
        }
        // Remaining control chords (ctrl+c quit, shift+tab agent cycle, …)
        // fall through to the normal handlers below.
        return undefined;
    };

    return (data) => {
        // Trace raw input: shows the press/release pair, modifiers, and which
        // chord (if any) a keystroke resolves to — the view that exposes
        // double-fire / event-ordering bugs.
        traceEvent(
            "input",
            `${JSON.stringify(data)} release=${isKeyRelease(data)} esc=${isEsc(data)} busy=${state.busy} q=${queuedMessages.length}`,
        );

        // Under the Kitty keyboard protocol a single physical keypress emits BOTH
        // a press and a release event, and our chord matchers (isEsc, isCtrlC, …)
        // match the codepoint regardless of event type. The TUI filters releases
        // before the focused component, but input listeners run earlier, so a
        // lone Esc would fire the interrupt twice — the release firing lands on
        // the *next* (drained) turn and kills it. Drop releases here; every chord
        // below is a press-only action. (isKeyRelease excludes bracketed-paste.)
        if (isKeyRelease(data)) return undefined;

        // Selectors (e.g. /tree) own ctrl-key chords like ctrl+l/ctrl+d while
        // focused — global shortcuts that would shadow them only fire when the
        // editor has focus.
        const editorFocused = (editor as unknown as { focused?: boolean }).focused === true;

        // Ride this keystroke to notice an image sitting on the pasteboard (and
        // to drop an already-read tip). Throttled + deduped inside; nothing is
        // scheduled, so an idle prompt never probes.
        clipboardTip.onKey(
            statusLine,
            () => imagePasteEligible(editorFocused),
            () => tui.requestRender(),
        );

        // Scrollback focus mode owns navigation keys while active. Selectors
        // (which steal editor focus) suspend it implicitly via the flag reset
        // on exit paths below.
        if (state.scrollbackFocus && editorFocused && deps.getSelectorDepth() === 0) {
            const handled = handleScrollbackFocus(data);
            if (handled) return handled;
        } else if (state.scrollbackFocus) {
            // A selector/overlay took over — drop focus mode quietly.
            exitScrollbackFocus();
        }

        // A key brings the prompt back into view, the way a shell scrolls to
        // the bottom on a keystroke. The wheel and the scroll keys never get
        // this far — the viewport consumed them — so what does is input to the
        // prompt, or to a menu drawn on it, and both live where the document
        // ends. Pointer and focus reports are the terminal talking, not the user.
        if (isKeyboardInput(data)) deps.revealPrompt();

        // Drag-and-drop / paste of attachable file(s) — images/PDFs — into the
        // prompt: attach what the model accepts (clean [image:…] tokens); paths
        // the model can't take stay in the editor as plain text WITH a visible
        // note, so a blocked drop never looks like a silent no-op. Editor-focused
        // only, so it never fires while a selector owns input.
        if (editorFocused) {
            const dropped = droppedAttachments(data, state.cwd, state.modelId);
            if (dropped && (dropped.allowed.length > 0 || dropped.rejected.length > 0)) {
                for (const path of dropped.allowed) void ctx.attachImage(path);
                if (dropped.rejected.length > 0) {
                    const current = editor.getText?.() ?? "";
                    const sep = current && !current.endsWith(" ") ? " " : "";
                    editor.setText?.(current + sep + dropped.rejected.join(" ") + " ");
                    history.addSystem(
                        `${state.modelId} does not accept ${dropped.rejected.some((p) => p.toLowerCase().endsWith(".pdf")) ? "PDFs" : "images"} — path pasted as text (switch models via /model to attach).`,
                    );
                    tui.requestRender();
                }
                return { consume: true };
            }
        }
        // Agent cycling: Shift+Tab only. Plain Tab is reserved for the editor's
        // completion — slash-command autocomplete and "@" file completion — so
        // we never consume it here; it falls through to the focused editor,
        // which triggers/applies the completion. Cycle = active custom agent (if
        // selected via /agents) plus all built-ins.
        const wantsAgentCycle = isShiftTab(data);
        if (wantsAgentCycle && editorFocused) {
            // Cycle = visible built-ins, plus the one extra agent the user has
            // opted into (a custom agent or a revealed hidden built-in like
            // data-analyst). Hidden built-ins stay out until selected.
            const cycle = [
                ...(state.cycleCustomAgent && agentExists(state.cycleCustomAgent) ? [state.cycleCustomAgent] : []),
                ...listAgents()
                    .filter((a) => a.builtin && !a.hidden)
                    .map((a) => a.name),
            ];
            const next = cycle[(cycle.indexOf(state.agent) + 1) % cycle.length];
            const prev = state.agent;
            state.agent = next;
            settingsStore.set("agent", next);
            statusLine.setAgent(next);
            // Landing on the plan agent arms the session's plan-mode gate
            // (edits rejected, bash read-only — covers subagents too); cycling
            // away disarms it only when the cycle armed it, so a gate set via
            // /plan or enter_plan_mode isn't clobbered by agent browsing.
            if (state.session) {
                if (next === PLAN_AGENT_NAME && !isPlanModeActive(state.session.id)) {
                    setPlanMode(state.session.id, true);
                    state.planModeViaCycle = true;
                    statusLine.setPlanMode(true);
                } else if (prev === PLAN_AGENT_NAME && next !== PLAN_AGENT_NAME && state.planModeViaCycle) {
                    setPlanMode(state.session.id, false);
                    state.planModeViaCycle = false;
                    statusLine.setPlanMode(false);
                }
            }
            tui.requestRender();
            return { consume: true };
        }
        if (isCtrlL(data) && editorFocused) {
            ctx.clearScreen();
            return { consume: true };
        }
        // Ctrl+P: cycle through the /scoped-models list. Editor-focused only
        // (selectors own their own chords); skips models that dropped out of
        // the catalog or lost availability since being scoped.
        if (isCtrlP(data) && editorFocused) {
            const scoped = (getSetting("scopedModels") ?? []).filter((id) => getModelSync(id)?.available !== false);
            if (scoped.length === 0) {
                history.addSystem("no scoped models — pick some with /scoped-models");
                tui.requestRender();
                return { consume: true };
            }
            const next = scoped[(scoped.indexOf(state.modelId) + 1) % scoped.length];
            if (next !== state.modelId) void ctx.setModel(next);
            return { consume: true };
        }
        // ctrl+e is the ONLY way in to live mode (expand-all moved to `e`
        // inside it) — Esc/ctrl+arrows used to enter too, but stray Esc
        // presses on an idle prompt kept flinging people into it. See
        // keys.ts:isCtrlE for why Ghostty's cmd+→ no longer counts.
        if (isCtrlE(data) && editorFocused && deps.getSelectorDepth() === 0) {
            enterScrollbackFocus();
            return { consume: true };
        }
        // Cmd+V with an image on the clipboard, in the terminals that report it
        // at all: the terminal handles Cmd+V itself and pastes the clipboard's
        // text flavour, which for raw image data is nothing — an empty paste is
        // then our only signal that the user asked for one.
        //
        // Ghostty (measured) sends NOTHING in that case, not an empty paste, so
        // this arm can't be the whole story — Cmd+V is simply undeliverable to
        // a raw-mode TUI there. Ctrl+V below is the chord that always arrives,
        // and clipboardTip nudges the user toward it. Kept because it costs one
        // comparison and does fire on the terminals that send the empty frame.
        if (editorFocused && isEmptyPaste(data)) {
            const path = readClipboardImageToFile();
            if (path) {
                void ctx.attachImage(path);
                return { consume: true };
            }
            // No image either — swallow it. An empty paste has nothing to
            // insert, and letting it through just redraws the editor.
            return { consume: true };
        }
        if (isCtrlV(data)) {
            clipboardTip.dismiss(statusLine);
            const path = readClipboardImageToFile();
            if (path) {
                void ctx.attachImage(path);
                return { consume: true };
            }
            // No raster → paste the text flavour instead. Ctrl+V is the only
            // paste chord a raw-mode TUI reliably receives on macOS, so it has
            // to be a *complete* paste: an image-only chord that errors on text
            // trains people not to use the one key that works.
            const text = readClipboardText();
            if (text) {
                editor.insertTextAtCursor(text);
                tui.requestRender();
                return { consume: true };
            }
            // Say so rather than no-op: a silent Ctrl+V is indistinguishable
            // from a broken one, which is exactly how this got reported.
            history.addSystem(
                process.platform === "darwin"
                    ? "clipboard is empty — copy an image (screenshot, or Cmd+C in Preview/Finder) or some text, or press Ctrl+I to pick a file."
                    : "clipboard is empty, and reading images from it is macOS-only for now — use Ctrl+I to pick a file, or `/attach <path>`.",
            );
            tui.requestRender();
            return { consume: true };
        }
        if (isCtrlI(data)) {
            const path = pickImageFile();
            if (path) void ctx.attachImage(path);
            return { consume: true };
        }
        // Ctrl+G: send "continue" as a message — the one-keystroke version of
        // the resume-after-interrupt ritual (reopen session, type "continue").
        // Idle + editor-focused only: while a turn runs it would just queue
        // noise, and selectors own their own ctrl chords.
        if (isCtrlG(data) && !state.busy && editorFocused) {
            if (editor.onSubmit) void editor.onSubmit("continue");
            return { consume: true };
        }
        if (isCtrlD(data) && !state.busy && editorFocused) {
            cleanExit(0);
            return { consume: true };
        }
        if (isCtrlC(data)) {
            if (state.busy) {
                playCue("press");
                state.abort.abort();
                state.abort = new AbortController();
                state.busy = false;
                hideWorking();
                queuedMessages.length = 0;
                renderPending();
                tui.requestRender();
                return { consume: true };
            }
            const now = Date.now();
            if (now - state.lastCtrlCAt < 1000) {
                cleanExit(130);
                return { consume: true };
            }
            state.lastCtrlCAt = now;
            history.addSystem("Press Ctrl+C again to quit.");
            tui.requestRender();
            return { consume: true };
        }
        // Esc with a stray idle selection just drops it (safety net).
        if (isEsc(data) && !state.busy && deps.getSelectorDepth() === 0 && history.clearSelection()) {
            tui.requestRender();
            return { consume: true };
        }
        // Esc aborts the running turn — but not while a selector/prompt owns
        // the input (e.g. the ask tool's question UI, extension api.ui panels):
        // there Esc must reach the focused component (skip/cancel), not kill
        // the whole turn.
        if (isEsc(data) && state.busy && deps.getSelectorDepth() === 0) {
            playCue("press");
            state.abort.abort();
            state.abort = new AbortController();
            state.busy = false;
            hideWorking();
            tui.requestRender();
            return { consume: true };
        }

        // The `max` tier: incidental keyboard feedback, off unless asked for.
        // Both fire on the KEY, before the editor acts on it, because that is
        // the only seam the CLI owns — the popup and the line buffer live in
        // the TUI editor, and this stays out of that fork on purpose.
        if (editorFocused && deps.getSelectorDepth() === 0) {
            // A leading `/` on an empty prompt is the slash menu opening.
            if (data === "/" && editor.getText() === "") playMaxCue("toggle");
            else if (isClearLine(data) && editor.getText() !== "") playMaxCue("release");
        }
        return undefined;
    };
}
