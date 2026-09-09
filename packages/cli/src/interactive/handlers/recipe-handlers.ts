import {
    bindRecipeInputs,
    generateRecipe,
    parseRecipeArgs,
    recipeInputs,
    RecipeStore,
    renderRecipe,
    validateRecipeName,
    type CommandContext,
    type Recipe,
} from "@notshekhar/loop-core";
import { Container, Markdown, Text } from "@notshekhar/loop-tui";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { getMarkdownTheme } from "../ui/theme";
import { DynamicBorder } from "../ui/messages";
import { accentTitle, dim } from "../ui/text";

const HELP =
    "Recipes: /recipe save <name> [what should vary] · /recipe list · /recipe show|edit|rm <name> · /recipe <name> [values or input=value]. Quote values containing spaces. Use /recipe run <name> for names matching a subcommand.";

export function createRecipeHandlers(
    state: AppState,
    deps: AppDeps,
    services: { store?: RecipeStore; generate?: typeof generateRecipe } = {},
): Pick<CommandContext, "manageRecipes"> {
    const store = services.store ?? new RecipeStore();
    const generate = services.generate ?? generateRecipe;
    const { history, tui, promptOnce, selectOnce } = deps;
    const say = (text: string) => {
        history.addSystem(text);
        tui.requestRender();
    };
    // Ruled like every other transient block: a draft recipe is not a turn in
    // this conversation and never enters its context, so it must not read as one.
    const preview = (name: string, body: string) => {
        const block = new Container();
        block.addChild(
            new Text(accentTitle(` Recipe draft: ${name}`) + dim("  · not part of this conversation"), 0, 0),
        );
        block.addChild(new DynamicBorder());
        block.addChild(new Markdown(body, 1, 0, getMarkdownTheme()));
        block.addChild(new DynamicBorder());
        history.addChild(block);
        history.invalidate();
        tui.requestRender();
    };

    async function review(name: string, initial: string): Promise<string | null> {
        let body = initial;
        while (true) {
            preview(name, body);
            const inputs = recipeInputs(body);
            const choice = await selectOnce(
                [
                    { value: "save", label: "save recipe", description: `inputs: ${inputs.join(", ") || "none"}` },
                    { value: "edit", label: "edit draft", description: "change steps or {{input_name}} placeholders" },
                    { value: "cancel", label: "cancel", description: "leave the recipe unchanged" },
                ],
                `Recipe: ${name}`,
            );
            if (!choice || choice.value === "cancel") return null;
            if (choice.value === "save") return body;
            const edited = await promptOnce("Recipe Markdown — {{input_name}} marks a value to ask for", body);
            if (edited.trim()) body = edited.trim();
        }
    }

    async function run(recipe: Recipe, args: string[]): Promise<string | null> {
        const values = bindRecipeInputs(recipe, args);
        for (const input of recipe.inputs) {
            if (values[input]?.trim()) continue;
            const value = await promptOnce(`${recipe.name} — ${input} (blank/Esc cancels)`);
            if (!value.trim()) {
                say("Recipe cancelled.");
                return null;
            }
            values[input] = value;
        }
        return renderRecipe(recipe, values);
    }

    return {
        async manageRecipes(raw) {
            // Keep queued input from changing the session/model beneath the draft.
            const previousAbort = state.abort;
            const abort = new AbortController();
            state.abort = abort;
            state.busy = true;
            let prompt: string | null = null;
            try {
                const args = parseRecipeArgs(raw);
                let action = args.shift() ?? "";
                if (action === "help") {
                    say(HELP);
                    return;
                }
                if (!action) {
                    const selected = await deps.searchOnce(
                        [
                            { value: "+save", label: "+ save this session as a recipe" },
                            ...store.names().map((name) => ({ value: name, label: name })),
                        ],
                        "Recipes — choose a workflow",
                    );
                    if (!selected) return;
                    if (selected.value === "+save") action = "save";
                    else {
                        const recipe = store.read(selected.value);
                        const choice = await selectOnce(
                            [
                                {
                                    value: "run",
                                    label: "run",
                                    description: `inputs: ${recipe.inputs.join(", ") || "none"}`,
                                },
                                { value: "show", label: "view" },
                                { value: "edit", label: "edit" },
                                { value: "rm", label: "delete" },
                            ],
                            recipe.name,
                        );
                        if (!choice) return;
                        action = choice.value;
                        args.push(recipe.name);
                    }
                }
                if (action === "list") {
                    const names = store.names();
                    say(
                        names.length
                            ? names.map((name) => `/recipe ${name}`).join("\n")
                            : "No recipes yet. Finish a task, then /recipe save <name>.",
                    );
                    say(`Recipes live in ${store.directory}`);
                    return;
                }
                if (action === "save") {
                    const session = state.session;
                    if (!session || !session.getBranch().some((e) => e.type === "message")) {
                        say("Send a message first, then save the completed workflow as a recipe.");
                        return;
                    }
                    if (!state.modelId) {
                        say("Choose a model with /model before extracting a recipe.");
                        return;
                    }
                    const name = args.shift() ?? (await promptOnce("Recipe name (e.g. add-endpoint)"));
                    if (!name.trim()) return;
                    validateRecipeName(name);
                    if (store.names().includes(name))
                        throw new Error(
                            `Recipe "${name}" already exists. Use /recipe edit ${name}, or choose another name.`,
                        );
                    const focus = args.length
                        ? args.join(" ")
                        : await promptOnce(
                              "What should vary between runs? (e.g. resource name and route)",
                              "Infer reusable inputs from this session",
                          );
                    if (!focus.trim()) return;
                    let draft: string;
                    deps.showWorking("Extracting recipe");
                    try {
                        draft = await generate({
                            name,
                            entries: session.getBranch(),
                            modelId: state.modelId,
                            focus,
                            abortSignal: abort.signal,
                            tracker: deps.tracker,
                            sessionPub: session.id,
                            cwd: state.cwd,
                        });
                    } finally {
                        if (state.abort === abort) deps.hideWorking();
                        deps.refreshStatusLine();
                    }
                    if (abort.signal.aborted) return;
                    const body = await review(name, draft);
                    if (body !== null && !abort.signal.aborted) {
                        const saved = store.save(name, body);
                        say(
                            `Saved ${saved.path}\nRun: /recipe run ${name}${saved.inputs.map((key) => ` <${key}>`).join("")}`,
                        );
                    }
                    return;
                }
                if (["show", "edit", "rm", "run"].includes(action)) {
                    const name = args.shift();
                    if (!name) {
                        say(HELP);
                        return;
                    }
                    if (action !== "run" && args.length) throw new Error(`Usage: /recipe ${action} <name>`);
                    const recipe = store.read(name);
                    if (action === "show") {
                        preview(recipe.name, recipe.body);
                        say(recipe.path);
                        return;
                    }
                    if (action === "edit") {
                        const edited = await promptOnce(`Edit ${name} — {{input_name}} marks an input`, recipe.body);
                        if (!edited.trim()) return;
                        const body = await review(name, edited.trim());
                        if (body !== null && !abort.signal.aborted) say(`Saved ${store.save(name, body, true).path}`);
                        return;
                    }
                    if (action === "rm") {
                        const choice = await selectOnce(
                            [
                                { value: "keep", label: "keep recipe" },
                                { value: "delete", label: "delete recipe", description: recipe.path },
                            ],
                            `Delete ${name}?`,
                        );
                        if (choice?.value === "delete" && !abort.signal.aborted) {
                            store.remove(name);
                            say(`Deleted recipe "${name}".`);
                        }
                        return;
                    }
                    prompt = await run(recipe, args);
                } else {
                    prompt = await run(store.read(action), args);
                }
            } catch (error) {
                if (abort.signal.aborted) say("Recipe cancelled.");
                else if ((error as NodeJS.ErrnoException).code === "ENOENT")
                    say("Recipe not found. Use /recipe list to see saved workflows.");
                else throw error;
            } finally {
                if (state.abort === abort) {
                    state.busy = false;
                    state.abort = previousAbort;
                }
                tui.requestRender();
            }
            // Normal turn path owns permissions, tools, persistence and cancellation.
            if (prompt && !abort.signal.aborted && deps.editor.onSubmit) await deps.editor.onSubmit(prompt);
        },
    };
}
