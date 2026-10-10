import { EventEmitter } from "node:events";
import {
    asTurnEmitter,
    isDeliveredPlan,
    isPlanModeActive,
    listAgents,
    normalizePlanText,
    PLAN_TOOL_NAME,
    setPlanMode,
    type CommandContext,
    parseModelId,
    runInSession,
    runTurn,
    teamOf,
    TURN_EVENT_NAMES,
    wakeTeamInbox,
    type TeamTurnMeta,
} from "@notshekhar/loop-core";
import { wrapSessionHookContext } from "@notshekhar/loop-core";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import { formatError } from "./format-error";
import { createSubagentStream } from "./subagent-stream";
import { wireTurnEmitter } from "./turn-emitter";
import { traceEvent } from "./debug-log";
import { goalModeEngine } from "./goal-mode";
import { maybeTitleSession } from "./session-title";
import { dim, warn } from "./ui/text";
import { formatBangContext, parseBangCommand, runBangCommand } from "./bang-command";

/**
 * Whether the leading /token of an input maps to a registered slash command.
 * Mirrors how CommandRegistry.run parses the name so the two stay in sync.
 */
function commandExists(commands: { has(name: string): boolean }, input: string): boolean {
    const space = input.indexOf(" ");
    const name = (space < 0 ? input.slice(1) : input.slice(1, space)).trim();
    return commands.has(name);
}

/** Commands that move the screen to another session instead of acting on this one. */
const LEAVING_COMMANDS = new Set(["new", "clear", "resume", "sessions"]);

function leavesSession(input: string, commands: { has(name: string): boolean }): boolean {
    if (!input.startsWith("/") || !commandExists(commands, input)) return false;
    const space = input.indexOf(" ");
    return LEAVING_COMMANDS.has((space < 0 ? input.slice(1) : input.slice(1, space)).trim());
}

/**
 * Why a turn failed, in one line: the first error, which is the cause, plus
 * how many different ones followed it. A stream error and the exception that
 * carries it out of the turn are the same failure, so repeats are not counted.
 */
export function describeTurnFailure(errors: readonly unknown[]): string {
    const messages = [...new Set(errors.map((e) => formatError(e)))];
    const [cause, ...rest] = messages;
    return rest.length === 0 ? cause : `${cause} (and ${rest.length} more)`;
}

export function createTurnRunner(state: AppState, deps: AppDeps, ctx: CommandContext) {
    const {
        tui,
        history,
        editor,
        commands,
        queuedMessages,
        refreshStatusLine,
        renderPending,
        showWorking,
        hideWorking,
        ensureSession,
        tracker,
        selectOnce,
        todoPanel,
    } = deps;

    /**
     * The plan tool ended the turn with a finished plan: offer to hand it to
     * an implementing agent, or keep discussing with the plan agent. Esc at
     * any point = keep discussing (the plan stays in the session either way).
     */
    const offerPlanFollowUp = async (plan: string): Promise<void> => {
        // The plan itself is already on screen: the plan tool's box renders
        // its input as full markdown (streaming and done alike).
        const choice = await selectOnce(
            [
                { value: "implement", label: "implement it", description: "hand the plan to an implementing agent" },
                { value: "talk", label: "talk about it", description: "keep refining it with the plan agent" },
            ],
            "Plan ready",
        );
        if (!choice || choice.value === "talk") {
            history.addSystem(dim("keep chatting to refine the plan — deliver again with the plan tool"));
            tui.requestRender();
            return;
        }
        const candidates = listAgents().filter((a) => a.name !== "plan" && !a.hidden);
        const pick = await selectOnce(
            candidates.map((a) => ({ value: a.name, label: a.name })),
            "Implement with",
        );
        if (!pick) return;
        // Accepting a plan is the plan-mode exit gate: lift the session's
        // read-only lock so the implementing agent can actually edit.
        if (state.session && isPlanModeActive(state.session.id)) {
            setPlanMode(state.session.id, false);
            state.planModeViaCycle = false;
            deps.statusLine.setPlanMode(false);
            history.addSystem(dim("plan approved — plan mode off, edits enabled"));
        }
        void ctx.useAgent(
            pick.value,
            `Implement this plan. It is complete — follow it rather than re-planning:\n\n${plan}`,
        );
    };

    // Pull the next queued input and resubmit it, whatever its type (chat or
    // command). Called after every item finishes so the FIFO queue keeps
    // draining — chat turns drain from their finally, commands/guards from
    // their return paths.
    const drainNext = (): void => {
        // A command that skipped the queue mid-turn (/new) drains nothing:
        // the turn still running will drain its own queue when it ends.
        if (state.busy) return;
        const next = queuedMessages[0];
        if (next === undefined) return;
        // A session working in the background drains its chat messages on its
        // own, but a queued /command or !command waits until it is on screen
        // again: commands act on the session you are LOOKING at, and running
        // this one's /model or /new against another session would be worse
        // than waiting. Switching back drains it.
        if (!deps.isForeground() && (next.trimStart().startsWith("/") || parseBangCommand(next) !== null)) return;
        queuedMessages.shift();
        traceEvent("drain", `"${next}" aborted=${state.abort.signal.aborted} remaining=${queuedMessages.length}`);
        renderPending();
        if (editor.onSubmit) void editor.onSubmit(next);
    };

    /**
     * `chatOnly`: a message from a remote client — never a command here.
     * `team`: the thread team started this turn (a member's brief, mail that
     * woke it) — drawn as a team card and passed to the turn as such.
     */
    const onSubmit = async (raw: string, opts?: { chatOnly?: boolean; team?: TeamTurnMeta }) => {
        const text = raw.trim();
        if (!text) {
            drainNext();
            return;
        }

        // Agent busy → queue every input for after the current turn, FIFO.
        // Everything queues uniformly: chat messages AND slash commands
        // (including /new and /clear). They mutate session/model state and would
        // race the running turn, so they run in order when their turn comes up
        // rather than preempting. The queue drains after each item via
        // drainNext(), whatever its type.
        //
        // Except the commands that LEAVE this session: /new, /clear and
        // /resume never touch the running turn — it carries on in the
        // background and the other session opens beside it — so making them
        // wait for the turn would be waiting for nothing.
        if (state.busy && !leavesSession(text, commands)) {
            queuedMessages.push(text);
            traceEvent("queue", `"${text}" (depth=${queuedMessages.length})`);
            renderPending();
            tui.requestRender();
            return;
        }

        // `!<cmd>` runs a shell command here and now, and its output joins the
        // conversation. Handled BEFORE slash commands and before the model,
        // because `!` is a prefix on the line rather than a name to look up:
        // there is no "unknown !command" to fall through to chat as prose.
        const bang = opts?.chatOnly ? null : parseBangCommand(text);
        if (bang !== null) {
            history.addCommand(`! ${bang}`);
            tui.requestRender();
            // No shellPath override: the setting shell.ts advertises is not
            // wired to anything yet, and /shells resolves the shell the same
            // bare way. One behaviour for both, until that key is real.
            const result = await runBangCommand(bang, state.cwd, { signal: state.abort.signal });
            if (result.spawnError) history.addError(result.spawnError);
            else if (result.output.trim()) history.addSystem(result.output.trimEnd());
            if (result.truncated) history.addSystem(`[output truncated]`);
            if (!result.spawnError && result.exitCode !== null && result.exitCode !== 0) {
                history.addSystem(`exited with code ${result.exitCode}`);
            }
            // The model sees it on the NEXT turn rather than now: `!` is the
            // user doing something themselves, not asking for a reply, so it
            // must not spend a turn. Appended, so several `!` lines in a row
            // all survive to the message that finally follows them.
            const ctxText = formatBangContext(bang, result);
            state.pendingInjection = state.pendingInjection ? `${state.pendingInjection}\n\n${ctxText}` : ctxText;
            tui.requestRender();
            drainNext();
            return;
        }

        // Slash commands run inline. Handler errors land in chat — otherwise
        // they die as unhandled rejections nobody sees. An unrecognized /name
        // isn't an error: the user may just be talking about a path or option,
        // so we fall through and send it to the model as a normal message.
        if (!opts?.chatOnly && text.startsWith("/") && commandExists(commands, text)) {
            history.addCommand(text);
            try {
                await commands.run(text, ctx);
            } catch (err) {
                history.addError(formatError(err));
            }
            tui.requestRender();
            drainNext();
            return;
        }

        // No model picked yet — a chat turn can't run. Guide instead of crashing
        // on parseModelId(""); /provider and /login stay reachable above.
        if (!state.modelId) {
            history.addSystem("No model selected. Run /provider to pick one, or /login to add a provider.");
            tui.requestRender();
            drainNext();
            return;
        }

        // First turn may race SessionStart hooks — wait so their injected
        // context (pendingInjection) isn't silently dropped.
        if (state.startupHooksDone) {
            try {
                await state.startupHooksDone;
            } catch (err) {
                history.addError(`startup hooks: ${formatError(err)}`);
            }
            state.startupHooksDone = null;
        }

        // SessionStart hook context must persist in the transcript (the model
        // needs it in history on every later turn), but the tag lets the TUI
        // collapse it instead of rendering it as if the user typed it.
        // A team turn carries the team's words, not the user's: the user's own
        // pending `!` context waits for the next thing they type.
        const finalInput = opts?.team
            ? text
            : state.pendingInjection
              ? wrapSessionHookContext(state.pendingInjection, text)
              : text;
        if (!opts?.team) state.pendingInjection = null;

        // One-shot agent (/<agent> <message>) applies to exactly this turn.
        const turnAgent = state.oneShotAgent ?? state.agent;
        state.oneShotAgent = null;

        const activeSession = await ensureSession();
        state.busy = true;
        if (opts?.team) history.addTeamCard(opts.team, finalInput);
        else history.addUser(finalInput);
        // The message just sent is the thing to look at — and this is the one
        // place a pinned transcript should move on its own.
        deps.scrollTranscriptToEnd();
        showWorking("Generating");
        tui.requestRender();

        const { provider: turnProvider } = parseModelId(state.modelId);
        history.ensureAssistant(turnProvider, state.modelId);
        const emitter = asTurnEmitter(new EventEmitter());
        const subagentStream = createSubagentStream(history, tui);
        // Every turn closes with ONE line saying how it went — grok's
        // TurnCompleted / TurnFailed. An error that ends the turn is held here
        // (the first is the cause; a stream error and the throw that follows it
        // are one failure, not two) and printed as that closing line, instead
        // of an `error:` line followed by a "Turn completed" that contradicts it.
        const turnErrors: unknown[] = [];
        const noteTurnFailure = (err: unknown): void => {
            turnErrors.push(err);
        };
        wireTurnEmitter(emitter, {
            history,
            tui,
            state,
            turnProvider,
            subagentStream,
            todoPanel: deps.todoPanel,
            showWorking,
            refreshStatusLine,
            onTurnError: noteTurnFailure,
        });
        // Goal mode reads the turn's final text (bail phrases, verifier
        // input) — accumulate it here rather than re-parsing history.
        let assistantText = "";
        emitter.on("text-delta", (t: string) => {
            assistantText += t;
        });
        // Plan delivery: stash the plan tool's input so the follow-up flow
        // (implement / talk) can run once the turn has fully wound down.
        emitter.on("tool-call", (part: { toolName?: string; input?: unknown }) => {
            if (part.toolName !== PLAN_TOOL_NAME) return;
            // Stub deliveries are rejected by the tool and retried — only a
            // substantial plan arms the implement/talk follow-up.
            if (isDeliveredPlan(part.input)) {
                state.pendingPlan = normalizePlanText((part.input as { plan: string }).plan);
            }
        });

        const turnSignal = state.abort.signal;
        const turnStartedAt = Date.now();
        // enter_plan_mode / exit_plan_mode flip the session's gate MID-turn,
        // both behind their own approval prompt. syncPlanMode reconciles the
        // UI with whatever the gate now says: it runs after every tool result
        // (so the change lands the moment the user answers, not minutes later
        // when the turn ends) and once more in the finally, which also covers
        // a gate flipped by something that never emitted a tool result.
        let planModeShown = isPlanModeActive(activeSession.id);
        const syncPlanMode = (): void => {
            const active = isPlanModeActive(activeSession.id);
            if (active === planModeShown) return;
            planModeShown = active;
            deps.statusLine.setPlanMode(active);
            if (active) {
                history.addSystem(
                    warn("plan mode on") + dim(" — edits rejected, bash read-only; accept a plan or /plan to turn off"),
                );
            } else {
                // The agent's own exit: the gate the cycle may have armed is
                // gone, so cycling away from the plan agent must not re-clear it.
                state.planModeViaCycle = false;
                history.addSystem(dim("plan approved — plan mode off, edits enabled"));
            }
            tui.requestRender();
        };
        emitter.on("tool-result", syncPlanMode);
        // Under `/rc` this turn is also every remote client's: the same events,
        // in the same order, into the session's shared stream. Read from the
        // holder each time, so turning `/rc` on mid-turn still streams the rest.
        const publish = (part: { type: string; data: unknown }) =>
            deps.live.feed?.publish(activeSession.id, part);
        for (const event of TURN_EVENT_NAMES) {
            emitter.on(event, (data: unknown) => publish({ type: event, data }));
        }
        deps.live.feed?.setRunning(activeSession.id, true);
        traceEvent("turn", `start "${text}" abortedAtStart=${turnSignal.aborted} agent=${turnAgent}`);
        try {
            // In the session's scope so a question or approval this turn
            // raises is routed to THIS session, even if by then you are
            // looking at another one.
            await runInSession(activeSession.id, () =>
                runTurn({
                    session: activeSession,
                    modelId: state.modelId,
                    userInput: finalInput,
                    cwd: state.cwd,
                    abortSignal: turnSignal,
                    tracker,
                    emitter,
                    thinkingLevel: state.thinkingLevel,
                    agent: turnAgent,
                    ...(opts?.team ? { team: opts.team } : {}),
                }),
            );
        } catch (err) {
            noteTurnFailure(err);
        } finally {
            traceEvent("turn", `end   "${text}" abortedAtEnd=${turnSignal.aborted}`);
            state.busy = false;
            deps.live.feed?.setRunning(activeSession.id, false);
            subagentStream.dispose();
            history.finishAssistant();
            // Aborted mid-flight: still-pending tool boxes would show a
            // running state forever — freeze them as "interrupted".
            if (turnSignal.aborted) history.markPendingToolsInterrupted();
            // The checklist retires into scrollback at every turn end — done,
            // interrupted, or forgotten — so the panel never outlives the turn.
            // Session state keeps the list for nudges and /resume.
            if (!todoPanel.isEmpty()) {
                history.addSystem(todoPanel.retireLine());
                todoPanel.clear();
            }
            // Finished shells leave the panel only here. Dropping a row the
            // moment its process exits would shrink the frame mid-turn, which
            // is the one change the renderer cannot make cleanly; a turn
            // boundary is where the transcript is settled anyway.
            deps.shellsPanel.retireFinished();
            if (!turnSignal.aborted) {
                const seconds = (Date.now() - turnStartedAt) / 1000;
                if (turnErrors.length > 0) history.addTurnFailed(seconds, describeTurnFailure(turnErrors));
                else history.addTurnSummary(seconds);
            }
            syncPlanMode();
            hideWorking();
            deps.settleTurn(turnErrors.length > 0 && !turnSignal.aborted);
            tui.requestRender();
            // Plan follow-up runs before the queue drains so the selector
            // isn't fighting a queued message's turn.
            const plan = state.pendingPlan;
            state.pendingPlan = null;
            if (plan && !turnSignal.aborted) await offerPlanFollowUp(plan);
            // Goal mode: decide whether this session's goal continues, gets
            // verified, or pauses — may resubmit through onSubmit. No-op when
            // no goal is active or user input is queued.
            goalModeEngine(state, deps).afterTurn(assistantText, turnSignal.aborted);
            // Name the session from its opening exchange, once. Detached: the
            // prompt is already free and a title is never worth making anyone
            // wait for.
            void maybeTitleSession(state, deps, { userInput: text, assistantText, aborted: turnSignal.aborted });
            // Drain the next queued input (FIFO), whatever its type. Each fresh
            // turn/command re-reads state.
            drainNext();
            // A thread team member: mail that arrived after its last step
            // starts its next turn (no-op while a queued input is running).
            if (teamOf(activeSession.id)) wakeTeamInbox(activeSession.id);
        }
    };

    return onSubmit;
}
