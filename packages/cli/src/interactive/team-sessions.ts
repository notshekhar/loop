/**
 * Thread teams in the TUI (core teams/): this loop runs a team's threads.
 *
 * Each thread is a live session in the background — Ctrl+S lists it beside
 * the others, and its turns run exactly as a typed turn would (approvals park
 * until you look at it, `/rc` streams it to the phone). The lead starts them
 * with spawn_threads; this file is the runtime core hands their turns to,
 * plus `/team` (every thread, jump to one, stop) and `/lead` (back to the
 * thread that started this one).
 */
import {
    claimTeamRuntime,
    CostTracker,
    DEFAULT_AGENT_NAME,
    dropTeamTurn,
    mayRunTeamTurn,
    memberRunConfig,
    parseModelId,
    releaseTeamRuntime,
    sessionTitle,
    stopTeam,
    teamOf,
    teamSnapshot,
    wakeTeamInbox,
    type MemberState,
    type ProviderId,
    type SessionManager,
    type TeamSnapshotMember,
    type TeamTurnMeta,
} from "@notshekhar/loop-core";
import type { SelectItem, TUI } from "@notshekhar/loop-tui";
import { ChatHistory } from "./components/chat-history";
import { TodoPanel } from "./components/todo-panel";
import type { AppDeps } from "./deps";
import { renderSessionBranch } from "./replay";
import type { SessionRoster } from "./session-roster";
import type { SessionSlot, SlotManager } from "./slots";
import { accent, dim, err, ok, warn } from "./ui/text";

export interface TeamSessionsHost {
    slots: SlotManager;
    roster: SessionRoster;
    deps: AppDeps;
    tui: TUI;
    manager: SessionManager;
}

export interface TeamSessions {
    manageTeam(args: string): Promise<void>;
    /** "thread of “Add CSV export”" / "lead · 3 threads" — for a session list row, or "". */
    teamLabel(sessionId: string | undefined): string;
    dispose(): void;
}

const STATE_GLYPH: Record<MemberState, string> = {
    starting: "◌",
    running: "●",
    waiting: "◔",
    idle: "○",
    done: "✓",
    failed: "✗",
    stopped: "■",
};

function paintState(state: MemberState, text: string): string {
    if (state === "running" || state === "starting") return accent(text);
    if (state === "waiting") return warn(text);
    if (state === "done") return ok(text);
    if (state === "failed") return err(text);
    return dim(text);
}

const usd = (v: number) => `$${v.toFixed(v >= 1 ? 2 : 3)}`;

interface QueuedTeamTurn {
    readonly input: string;
    readonly team: TeamTurnMeta;
}

export function createTeamSessions(host: TeamSessionsHost): TeamSessions {
    const { slots, roster, deps, tui, manager } = host;
    const owner = {};
    /** Team turns handed over while their thread was busy — run when it frees. */
    const pending = new Map<SessionSlot, QueuedTeamTurn[]>();
    /**
     * Team turns given to a thread's runner and not yet ended. The runner
     * awaits before it marks the slot busy, and a second turn in that gap
     * would run beside the first.
     */
    const inFlight = new Set<string>();
    /** Threads being opened, so two deliveries at once share one slot. */
    const opening = new Map<string, Promise<SessionSlot>>();

    const say = (text: string): void => {
        deps.history.addSystem(text);
        tui.requestRender();
    };

    /** A background slot for a session that has none: its own model, agent and thinking level. */
    const openSlot = async (sessionId: string): Promise<SessionSlot> => {
        // The /rc server's copy when it has one: two Session objects for one
        // conversation each append to their own branch.
        const session = deps.live.feed?.openSession(sessionId) ?? (await manager.open(sessionId));
        const model = session.lastModel() || session.info.model;
        let provider = session.info.provider;
        try {
            provider = parseModelId(model).provider as ProviderId;
        } catch {
            // keep the recorded provider
        }
        const template = slots.foreground;
        // A thread runs as its lead started it, not as whatever tab is in front.
        const run = memberRunConfig(sessionId);
        const history = new ChatHistory(tui, session.info.cwd);
        const todoPanel = new TodoPanel();
        const tracker = new CostTracker();
        try {
            tracker.seedFromSession(session);
        } catch {
            // an unseeded tracker still bills this process's turns
        }
        const slot = slots.add({
            cwd: session.info.cwd,
            modelId: model,
            provider,
            thinkingLevel: run?.thinkingLevel ?? template.thinkingLevel,
            agent: run ? (run.agent ?? DEFAULT_AGENT_NAME) : template.agent,
            oneShotAgent: null,
            session,
            latestContextTokens: 0,
            busy: false,
            abort: new AbortController(),
            pendingInjection: null,
            startupHooksDone: null,
            pendingPlan: null,
            planModeViaCycle: false,
            history,
            todoPanel,
            tracker,
        });
        const team = teamOf(sessionId);
        if (team && team.role === "member") {
            history.addSystem(
                accent("⧉ ") +
                    `${sessionTitle(sessionId)}` +
                    dim(
                        ` — a thread in “${sessionTitle(team.leadId)}”'s team · /lead goes back · /team lists every thread`,
                    ),
            );
        }
        renderSessionBranch(session, history, model, todoPanel);
        return slot;
    };

    /** The live slot for a session, opened in the background if it has none. */
    const openBackground = (sessionId: string): Promise<SessionSlot> => {
        const live = slots.bySessionId(sessionId);
        if (live) return Promise.resolve(live);
        const already = opening.get(sessionId);
        if (already) return already;
        const opened = openSlot(sessionId).finally(() => opening.delete(sessionId));
        opening.set(sessionId, opened);
        return opened;
    };

    const isBusy = (slot: SessionSlot): boolean => slot.busy || (!!slot.session && inFlight.has(slot.session.id));

    const enqueue = (slot: SessionSlot, turn: QueuedTeamTurn): void => {
        const queue = pending.get(slot) ?? [];
        queue.push(turn);
        pending.set(slot, queue);
    };

    const run = (slot: SessionSlot, sessionId: string, turn: QueuedTeamTurn): void => {
        // Queued behind a busy thread, a turn can outlive its team's stop.
        if (!mayRunTeamTurn(sessionId)) {
            dropTeamTurn(turn.team);
            return;
        }
        const agent = memberRunConfig(sessionId)?.agent ?? (turn.team.kind === "spawn" ? turn.team.agent : undefined);
        if (agent) slot.oneShotAgent = agent;
        inFlight.add(sessionId);
        void roster
            .runnerFor(slot)(turn.input, { chatOnly: true, team: turn.team, onBusy: () => enqueue(slot, turn) })
            .finally(() => {
                inFlight.delete(sessionId);
                // What queued behind this turn goes first; then mail that
                // came in late — the runner's own wake ran while this turn
                // still counted as in flight, so it skipped it.
                drainPending();
                wakeTeamInbox(sessionId);
            });
    };

    /** Run what waited for a thread that is free now; a closed thread's mail goes back to its inbox. */
    const drainPending = (): void => {
        const open = new Set(slots.all());
        for (const [slot, queue] of pending) {
            if (!open.has(slot)) {
                pending.delete(slot);
                for (const turn of queue) dropTeamTurn(turn.team);
                continue;
            }
            const sessionId = slot.session?.id;
            if (!sessionId || isBusy(slot)) continue;
            const next = queue.shift();
            if (queue.length === 0) pending.delete(slot);
            if (next) run(slot, sessionId, next);
        }
    };

    const offChange = slots.onChange(drainPending);

    claimTeamRuntime(owner, {
        deliver: async (sessionId, input, team) => {
            const slot = await openBackground(sessionId);
            if (isBusy(slot)) {
                enqueue(slot, { input, team });
                return;
            }
            run(slot, sessionId, { input, team });
            tui.requestRender();
        },
        isRunning: (sessionId) => inFlight.has(sessionId) || slots.bySessionId(sessionId)?.busy === true,
        cancel: (sessionId) => {
            const slot = slots.bySessionId(sessionId);
            if (!slot?.busy) return;
            slot.abort.abort();
            slot.abort = new AbortController();
        },
    });

    const goTo = async (sessionId: string): Promise<void> => {
        const slot = await openBackground(sessionId);
        slots.switchTo(slot);
    };

    const row = (m: TeamSnapshotMember, here: string | undefined): SelectItem => {
        const state: MemberState = m.role === "lead" && m.running ? "running" : m.state;
        const glyph = paintState(state, STATE_GLYPH[state]);
        const what = m.activity && (state === "running" || state === "starting") ? m.activity : state;
        return {
            value: m.id,
            label: `${glyph} ${m.role === "lead" ? `${m.title} ${dim("(lead)")}` : m.title}`,
            description: `${m.id === here ? "here · " : ""}${what} · ${usd(m.usd)}`,
        };
    };

    const manageTeam = async (args: string): Promise<void> => {
        const sub = args.trim();
        const here = slots.foreground.session?.id;
        const team = here ? teamOf(here) : null;
        if (!team) {
            say(
                dim(
                    "this session is not in a thread team — with “thread teams” on in /settings, the agent can start one when a job splits into parallel parts",
                ),
            );
            return;
        }
        if (sub === "lead") {
            if (team.role === "lead") {
                say(dim("this is the lead — /team lists its threads"));
                return;
            }
            await goTo(team.leadId);
            return;
        }
        if (sub === "stop") {
            stopTeam(team.teamId);
            say(warn("team stopped") + dim(" — every running thread was cancelled; the lead can start new ones"));
            return;
        }
        const snapshot = teamSnapshot(team.teamId);
        if (!snapshot) return;
        const STOP = "\x00stop";
        const items: SelectItem[] = [
            row(snapshot.lead, here),
            ...snapshot.members.map((m) => row(m, here)),
            ...(snapshot.stopped
                ? []
                : [{ value: STOP, label: dim("■ Stop the team"), description: "cancel every running thread" }]),
        ];
        const working = snapshot.members.filter((m) => m.state === "running" || m.state === "starting").length;
        const pick = await deps.selectOnce(
            items,
            `Team · ${snapshot.members.length} thread${snapshot.members.length === 1 ? "" : "s"}${working ? ` · ${working} working` : ""} · ${usd(snapshot.cost.usd)}`,
        );
        if (!pick) return;
        if (pick.value === STOP) return manageTeam("stop");
        if (pick.value !== here) await goTo(pick.value);
    };

    const teamLabel = (sessionId: string | undefined): string => {
        if (!sessionId) return "";
        const team = teamOf(sessionId);
        if (!team) return "";
        if (team.role === "member") return `thread of “${sessionTitle(team.leadId)}” · `;
        const snapshot = teamSnapshot(team.teamId);
        const n = snapshot?.members.length ?? 0;
        return n > 0 ? `lead · ${n} thread${n === 1 ? "" : "s"} · ` : "";
    };

    return {
        manageTeam,
        teamLabel,
        dispose: () => {
            offChange();
            releaseTeamRuntime(owner);
        },
    };
}
