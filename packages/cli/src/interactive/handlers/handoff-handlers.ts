import {
    clearReadRegistry,
    estimateContextTokens,
    generateHandoff,
    getCatalog,
    handoffGitStatus,
    handoffMessage,
    isPlanModeActive,
    listAgents,
    listShells,
    parseModelId,
    setPlanMode,
    type CommandContext,
} from "@notshekhar/loop-core";
import { Container, Markdown, Text } from "@notshekhar/loop-tui";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { getMarkdownTheme } from "../ui/theme";
import { DynamicBorder } from "../ui/messages";
import { accentTitle, dim } from "../ui/text";
import { setTabName } from "../session-title";
import { renderSessionBranch } from "../replay";

const CONTINUE =
    "Continue from the handoff brief above. Verify the current workspace state, then work on the next unfinished step. Respect the constraints and verification requirements in the brief.";

export function createHandoffHandlers(
    state: AppState,
    deps: AppDeps,
    services: {
        generate?: typeof generateHandoff;
        gitStatus?: typeof handoffGitStatus;
        catalog?: typeof getCatalog;
        agents?: typeof listAgents;
    } = {},
): Pick<CommandContext, "manageHandoff"> {
    const generate = services.generate ?? generateHandoff;
    const gitStatus = services.gitStatus ?? handoffGitStatus;
    const catalog = services.catalog ?? getCatalog;
    const agents = services.agents ?? listAgents;
    const { history, tui, selectOnce, searchOnce, promptOnce } = deps;
    const say = (text: string) => {
        history.addSystem(text);
        tui.requestRender();
    };

    return {
        async manageHandoff(focus) {
            const source = state.session;
            if (!source || !source.getBranch().some((e) => e.type === "message")) {
                say("Nothing to hand off yet — send a message first.");
                return;
            }
            if (state.busy) {
                say("Finish or cancel the current turn before creating a handoff.");
                return;
            }
            if (!state.modelId) {
                say("Choose a model with /model before creating a handoff.");
                return;
            }
            const sourceModel = state.modelId;
            const sourceAgent = state.agent;
            const sourcePlanMode = isPlanModeActive(source.id);
            const cwd = state.cwd;
            let sourceLeaf = source.getLeafId();
            const previousAbort = state.abort;
            const abort = new AbortController();
            state.abort = abort;
            state.busy = true;
            let continueNow = false;
            let opened = false;
            try {
                // Startup hook context must settle before taking the snapshot.
                if (state.startupHooksDone) await state.startupHooksDone;
                if (abort.signal.aborted) return;
                sourceLeaf = source.getLeafId();
                deps.showWorking("Preparing handoff");
                let brief: string;
                try {
                    const workspaceStatus = await gitStatus(cwd);
                    if (abort.signal.aborted) return;
                    brief = await generate({
                        entries: source.getBranch(),
                        modelId: sourceModel,
                        cwd,
                        focus,
                        workspaceStatus,
                        abortSignal: abort.signal,
                        tracker: deps.tracker,
                        sessionPub: source.id,
                    });
                } finally {
                    if (state.abort === abort) deps.hideWorking();
                    deps.refreshStatusLine();
                }
                while (!abort.signal.aborted) {
                    // Ruled like every other transient block, because that is
                    // what this is: the brief is a draft for a session that does
                    // not exist yet, and it never enters this session's context.
                    // Rendered bare it reads as another assistant turn, which is
                    // the one thing it is not.
                    const preview = new Container();
                    preview.addChild(
                        new Text(accentTitle(" Handoff brief") + dim("  · not part of this conversation"), 0, 0),
                    );
                    preview.addChild(new DynamicBorder());
                    preview.addChild(new Markdown(brief, 1, 0, getMarkdownTheme()));
                    preview.addChild(new DynamicBorder());
                    history.addChild(preview);
                    history.invalidate();
                    tui.requestRender();
                    const review = await selectOnce(
                        [
                            {
                                value: "open",
                                label: "open a fresh session",
                                description: "choose a model and agent; start when you are ready",
                            },
                            {
                                value: "continue",
                                label: "open and continue",
                                description: "choose a model and agent; start the next step immediately",
                            },
                            { value: "edit", label: "edit brief", description: "revise the summary and next steps" },
                            { value: "cancel", label: "cancel", description: "stay in this session" },
                        ],
                        "Review handoff",
                    );
                    if (!review || review.value === "cancel" || abort.signal.aborted) return;
                    if (review.value === "edit") {
                        const edited = await promptOnce("Edit the handoff brief", brief);
                        if (edited.trim()) brief = edited.trim();
                        continue;
                    }
                    continueNow = review.value === "continue";
                    break;
                }
                if (abort.signal.aborted) return;
                const models = await catalog();
                if (abort.signal.aborted) return;
                const model = await searchOnce(
                    [
                        { value: sourceModel, label: `${sourceModel} (current)` },
                        ...Object.values(models)
                            .filter((m) => m.available && m.id !== sourceModel)
                            .sort((a, b) => a.id.localeCompare(b.id))
                            .map((m) => ({ value: m.id, label: m.id, description: m.name })),
                    ],
                    "Handoff model",
                );
                if (!model || abort.signal.aborted) return;
                const availableAgents = agents();
                const agent = await selectOnce(
                    [
                        {
                            value: sourceAgent,
                            label: `${sourceAgent} (current)`,
                            description: sourcePlanMode ? "keep plan mode (read-only)" : "keep the current agent",
                        },
                        ...availableAgents
                            .filter((a) => a.name !== sourceAgent && !a.hidden)
                            .map((a) => ({
                                value: a.name,
                                label: a.name,
                                description:
                                    a.name === "plan" ? "read-only planning" : a.tools?.join(", ") || "all tools",
                            })),
                    ],
                    "Handoff agent",
                );
                if (!agent || abort.signal.aborted) return;

                const provider = parseModelId(model.value).provider;
                const message = handoffMessage({ sourceId: source.id, sourceLeaf, cwd, brief });
                // Create + brief + name is a single transaction. The source
                // stays live until a complete, resumable destination exists.
                const destination = deps.manager.createHandoff(source, {
                    cwd,
                    provider,
                    model: model.value,
                    brief: message,
                });
                const planMode = agent.value === "plan" || (agent.value === sourceAgent && sourcePlanMode);
                setPlanMode(destination.id, planMode);
                state.session = destination;
                state.modelId = model.value;
                state.provider = provider;
                state.agent = agent.value;
                state.oneShotAgent = null;
                state.pendingPlan = null;
                state.pendingInjection = null;
                state.planModeViaCycle = agent.value === "plan";
                state.cycleCustomAgent = availableAgents.find((a) => a.name === agent.value)?.builtin
                    ? null
                    : agent.value;
                clearReadRegistry();
                deps.tracker.reset();
                state.latestContextTokens = estimateContextTokens(destination);
                deps.todoPanel.clear();
                deps.shellsPanel.setShells(listShells(destination.id));
                deps.statusLine.setSession(destination.id);
                deps.statusLine.setModel(model.value);
                deps.statusLine.setAgent(agent.value);
                deps.statusLine.setPlanMode(planMode);
                setTabName(deps, destination.getName()!);
                deps.editor.setText("");
                history.reset();
                renderSessionBranch(destination, history, model.value, deps.todoPanel);
                deps.refreshStatusLine();
                say(
                    `Handoff opened: ${destination.id}\nOriginal session: ${source.id}${continueNow ? "" : "\nReady for your next prompt."}`,
                );
                opened = true;
            } catch (error) {
                if (abort.signal.aborted) say("Handoff cancelled.");
                else throw error;
            } finally {
                // Esc can already have released input to a newer turn.
                if (state.abort === abort) {
                    state.busy = false;
                    state.abort = previousAbort;
                }
                tui.requestRender();
            }
            if (opened && continueNow && !abort.signal.aborted && deps.editor.onSubmit) {
                await deps.editor.onSubmit(CONTINUE);
            }
        },
    };
}
