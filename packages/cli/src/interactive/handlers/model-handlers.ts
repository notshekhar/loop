/**
 * Model & provider selection: /model, /provider, /thinking.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    addCustomModel,
    getActiveProvider,
    getCatalog,
    getModelSync,
    getSetting,
    getProjectProviderModel,
    listCustomModelIds,
    removeCustomModel,
    setActiveProvider,
    setProjectModel,
    playCue,
    settingsStore,
    THINKING_LEVEL_DESCRIPTIONS,
    THINKING_LEVELS,
    type CommandContext,
    type ProviderId,
    type ThinkingLevel,
    CONFIG_DIR_NAME,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { listUsableProviders } from "../provider-availability";
import { err, warn } from "../ui/text";

type ModelHandlers = Pick<
    CommandContext,
    "setModel" | "setProvider" | "openModelPicker" | "setThinking" | "manageScopedModels"
>;

export function createModelHandlers(state: AppState, deps: AppDeps): ModelHandlers {
    const { tui, history, statusLine, refreshStatusLine, selectOnce, searchOnce, promptOnce, resolveModelId } = deps;

    const applyModel = (id: string) => {
        state.modelId = id;
        settingsStore.set("defaultModel", id);
        setProjectModel(state.cwd, id);
        statusLine.setModel(id);
        history.addSystem(`model → ${id}`);
        // The interaction cue: a setting you flipped, confirmed by ear.
        playCue("click");
        tui.requestRender();
    };

    return {
        async setModel(id) {
            const resolved = await resolveModelId(id);
            if (!resolved) {
                history.addSystem(err(`unknown model: ${id} — try /model to pick from a list`));
                tui.requestRender();
                return;
            }
            applyModel(resolved);
            refreshStatusLine();
        },
        async setProvider(p) {
            // logged-in providers + zero-login ollama + saved custom gateways
            const usable = await listUsableProviders();
            if (usable.length === 0) {
                history.addSystem(warn("no providers available. /login first."));
                tui.requestRender();
                return;
            }
            let target = p;
            if (!target) {
                const items: SelectItem[] = usable.map((id) => ({
                    value: id,
                    label: id,
                    description: id === getActiveProvider() ? "(active)" : "",
                }));
                const pick = await searchOnce(items, "Provider (type to filter)");
                if (!pick) return;
                target = pick.value;
            }
            if (!usable.includes(target as ProviderId)) {
                history.addSystem(err(`not authorized: ${target}. /login ${target} first.`));
                tui.requestRender();
                return;
            }
            setActiveProvider(target as ProviderId);
            const cat = await getCatalog();
            // This folder's last model for the provider wins; first available is the fallback.
            const rememberedId = getProjectProviderModel(state.cwd, target);
            const remembered = rememberedId ? cat[rememberedId] : undefined;
            const pick = remembered?.available
                ? remembered
                : Object.values(cat).find((m) => m.provider === target && m.available);
            if (pick) {
                state.modelId = pick.id;
                settingsStore.set("defaultModel", state.modelId);
                setProjectModel(state.cwd, state.modelId);
                statusLine.setModel(state.modelId);
            }
            history.addSystem(`provider → ${target}${pick ? `, model → ${pick.id}` : ""}`);
            tui.requestRender();
        },
        async openModelPicker() {
            const active = (getActiveProvider() ?? state.provider) as ProviderId;

            const ADD = "\x00add";
            let lastIndex = 0;
            while (true) {
                const cat = await getCatalog();
                const custom = new Set(listCustomModelIds());
                const describe = (m: (typeof cat)[string]) =>
                    `${m.name}  ·  ctx ${m.contextWindow.toLocaleString()}  ·  $${m.cost.input}/$${m.cost.output}`;

                // Scoped models first, whichever provider they belong to.
                //
                // The picker is scoped to the active provider, which is right
                // for browsing but wrong for the handful you actually work
                // with: those are the ones already named in `scopedModels`, and
                // until now the only way to reach one was Ctrl+P cycling. So
                // they go at the top, keeping their full id (they are not all
                // under `active`, and the bare name would be ambiguous), and
                // picking one switches the provider with it.
                const scoped = (getSetting("scopedModels") ?? [])
                    .map((id) => cat[id])
                    .filter((m): m is NonNullable<typeof m> => Boolean(m?.available));
                const scopedItems: SelectItem[] = scoped.map((m) => ({
                    value: m.id,
                    label: `★ ${m.id}`,
                    description: describe(m),
                }));

                const scopedIds = new Set(scoped.map((m) => m.id));
                const modelItems: SelectItem[] = Object.values(cat)
                    .filter((m) => m.provider === active && m.available && !scopedIds.has(m.id))
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .map((m) => ({
                        value: m.id,
                        label: m.id.slice(active.length + 1) + (custom.has(m.id) ? "  (custom)" : ""),
                        description: describe(m),
                    }));
                const items: SelectItem[] = [
                    ...scopedItems,
                    { value: ADD, label: "+ add model…", description: `register a model id under ${active}` },
                    ...modelItems,
                ];
                const pick = await searchOnce(items, `Model · ${active} (type to filter)`, {
                    initialIndex: lastIndex,
                });
                if (!pick) return;
                lastIndex = Math.max(
                    0,
                    items.findIndex((i) => i.value === pick.value),
                );

                if (pick.value === ADD) {
                    const modelId = (await promptOnce(`new model id under ${active}/ (e.g. some-model-v2)`)).trim();
                    if (!modelId) continue;
                    const full = addCustomModel({ provider: active, modelId });
                    history.addSystem(
                        `added ${full} (custom). It'll error at chat time if ${active} doesn't serve it.`,
                    );
                    applyModel(full);
                    return;
                }
                // A custom model offers remove via a follow-up action menu.
                if (custom.has(pick.value)) {
                    const action = await selectOnce(
                        [
                            { value: "use", label: "use", description: pick.value },
                            {
                                value: "remove",
                                label: "remove custom model",
                                description: `delete from ~/${CONFIG_DIR_NAME}/models.json`,
                            },
                        ],
                        pick.value,
                    );
                    if (!action) continue;
                    if (action.value === "remove") {
                        removeCustomModel(pick.value);
                        history.addSystem(`removed custom model ${pick.value}`);
                        tui.requestRender();
                        continue;
                    }
                }
                // A scoped pick can belong to another provider — follow it, or
                // the status line and the next turn disagree about who is
                // serving the model.
                const picked = cat[pick.value];
                if (picked && picked.provider !== active) {
                    setActiveProvider(picked.provider as ProviderId);
                }
                applyModel(pick.value);
                return;
            }
        },
        async manageScopedModels(args) {
            const current = getSetting("scopedModels") ?? [];

            if (args) {
                const [op = "", ...rest] = args.split(/\s+/);
                const raw = rest.join(" ");
                if (op === "add" && raw) {
                    const resolved = await resolveModelId(raw);
                    if (!resolved) {
                        history.addSystem(err(`unknown model: ${raw}`));
                    } else if (current.includes(resolved)) {
                        history.addSystem(`already scoped: ${resolved}`);
                    } else {
                        settingsStore.set("scopedModels", [...current, resolved]);
                        history.addSystem(`scoped models + ${resolved}`);
                    }
                } else if ((op === "rm" || op === "remove") && raw) {
                    if (!current.includes(raw)) {
                        history.addSystem(err(`not in scoped list: ${raw}`));
                    } else {
                        settingsStore.set(
                            "scopedModels",
                            current.filter((m) => m !== raw),
                        );
                        history.addSystem(`scoped models - ${raw}`);
                    }
                } else {
                    history.addSystem("usage: /scoped-models · /scoped-models add <id> · /scoped-models rm <id>");
                }
                tui.requestRender();
                return;
            }

            // Panel: toggle over every available model, across providers —
            // Ctrl+P cycling is meant to hop providers too.
            const cat = await getCatalog();
            const values = Object.values(cat)
                .filter((m) => m.available)
                .map((m) => m.id)
                .sort();
            if (values.length === 0) {
                history.addSystem(warn("no available models — /login first"));
                tui.requestRender();
                return;
            }
            const picked = await deps.toggleOnce(
                values,
                new Set(current),
                "Scoped models — Ctrl+P cycles the checked ones",
            );
            if (!picked) return;
            settingsStore.set("scopedModels", picked);
            history.addSystem(
                picked.length
                    ? `scoped models (${picked.length}): ${picked.join(", ")}`
                    : "scoped models cleared — Ctrl+P disabled",
            );
            tui.requestRender();
        },
        async setThinking(level) {
            // Models that don't reason (e.g. composer-2.5, grok-3) have no
            // thinking levels — the reference shows "does not support thinking" and
            // skips the selector entirely.
            if (!getModelSync(state.modelId)?.reasoning) {
                history.addSystem("current model does not support thinking");
                tui.requestRender();
                return;
            }
            let target = level as ThinkingLevel | undefined;
            if (!target) {
                const items: SelectItem[] = THINKING_LEVELS.map((lv) => ({
                    value: lv,
                    label: lv,
                    description: THINKING_LEVEL_DESCRIPTIONS[lv] + (lv === state.thinkingLevel ? "  (current)" : ""),
                }));
                const pick = await selectOnce(items, "Thinking level");
                if (!pick) return;
                target = pick.value as ThinkingLevel;
            }
            if (!(THINKING_LEVELS as readonly string[]).includes(target)) {
                history.addSystem(err(`unknown thinking level: ${target}. options: ${THINKING_LEVELS.join(", ")}`));
                tui.requestRender();
                return;
            }
            state.thinkingLevel = target;
            settingsStore.set("thinkingLevel", target);
            statusLine.setThinking(target);
            history.addSystem(`thinking → ${target}`);
            tui.requestRender();
        },
    };
}
