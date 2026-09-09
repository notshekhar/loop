import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeStore, type generateRecipe } from "@notshekhar/loop-core";
import { createRecipeHandlers } from "../src/interactive/handlers/recipe-handlers";
import type { AppDeps } from "../src/interactive/deps";
import type { AppState } from "../src/interactive/state";
import { initTheme } from "../src/interactive/ui/theme";

const dirs: string[] = [];
beforeEach(() => initTheme("dark"));
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
    const directory = mkdtempSync(join(tmpdir(), "loop-recipe-handler-"));
    dirs.push(directory);
    const store = new RecipeStore(directory);
    const messages: string[] = [];
    const submitted: string[] = [];
    const answers: string[] = [];
    const choices: Array<string | null> = [];
    const generated: Parameters<typeof generateRecipe>[0][] = [];
    const state = {
        cwd: directory,
        modelId: "test/model",
        agent: "reviewer",
        busy: false,
        abort: new AbortController(),
        session: {
            id: "session-1",
            getBranch: () => [{ type: "message", role: "user", content: "Add and test an endpoint" }],
        },
    } as unknown as AppState;
    const deps = {
        history: { addSystem: (text: string) => messages.push(text), addChild: () => {}, invalidate: () => {} },
        tui: { requestRender: () => {} },
        editor: {
            onSubmit: async (text: string) => {
                expect(state.busy).toBe(false);
                submitted.push(text);
            },
        },
        promptOnce: async () => answers.shift() ?? "",
        selectOnce: async () => {
            const value = choices.shift();
            return value ? { value, label: value } : null;
        },
        searchOnce: async () => null,
        showWorking: () => {},
        hideWorking: () => {},
        refreshStatusLine: () => {},
    } as unknown as AppDeps;
    const generate: typeof generateRecipe = async (opts) => {
        generated.push(opts);
        return "# Add endpoint\n## Inputs\n{{resource}}: resource name\n## Steps\nAdd {{resource}}.\n## Verification\nRun tests.";
    };
    return {
        state,
        deps,
        store,
        messages,
        submitted,
        answers,
        choices,
        generated,
        generate,
        handlers: createRecipeHandlers(state, deps, { store, generate }),
    };
}

describe("/recipe", () => {
    test("extracts the active branch, lets the user edit, then saves without running", async () => {
        const h = harness();
        h.choices.push("edit", "save");
        h.answers.push("# Reusable endpoint\nCreate {{resource}} and test it.");
        await h.handlers.manageRecipes("save add-endpoint resource name");
        expect(h.generated[0].sessionPub).toBe("session-1");
        expect(h.generated[0].focus).toBe("resource name");
        expect(h.generated[0].modelId).toBe("test/model");
        expect(h.store.read("add-endpoint").body).toContain("Reusable endpoint");
        expect(h.submitted).toEqual([]);
        expect(h.state.busy).toBe(false);
    });

    test("cancelled draft writes nothing and existing names never regenerate", async () => {
        const h = harness();
        h.choices.push(null);
        await h.handlers.manageRecipes("save endpoint resource");
        expect(h.store.names()).toEqual([]);
        h.store.save("endpoint", "original");
        await expect(h.handlers.manageRecipes("save endpoint resource")).rejects.toThrow("already exists");
        expect(h.generated).toHaveLength(1);
        expect(h.store.read("endpoint").body).toBe("original");
        expect(h.state.busy).toBe(false);
    });

    test("prompts for missing inputs and submits through the normal agent flow", async () => {
        const h = harness();
        h.store.save("endpoint", "Add {{resource}} at {{route}}; test {{resource}}.");
        h.answers.push("/api/users");
        await h.handlers.manageRecipes("endpoint users");
        expect(h.submitted).toHaveLength(1);
        expect(h.submitted[0]).toContain("Add users at /api/users; test users.");
        expect(h.state.agent).toBe("reviewer");
        expect(h.state.modelId).toBe("test/model");
    });

    test("cancelling an input and misspelled named inputs cannot launch a turn", async () => {
        const h = harness();
        h.store.save("endpoint", "Add {{resource}}.");
        h.answers.push("");
        await h.handlers.manageRecipes("endpoint");
        await expect(h.handlers.manageRecipes("endpoint resorce=users")).rejects.toThrow("Unknown input");
        expect(h.submitted).toEqual([]);
        expect(h.state.busy).toBe(false);
    });

    test("explicit run disambiguates subcommand names and supports quoted named values", async () => {
        const h = harness();
        h.store.save("list", "Check {{target}}.");
        await h.handlers.manageRecipes('run list target="user accounts"');
        expect(h.submitted[0]).toContain("Check user accounts.");
    });

    test("editing and deletion require their selected actions", async () => {
        const h = harness();
        h.store.save("endpoint", "old");
        h.answers.push("new {{resource}}");
        h.choices.push("save", "keep", "delete");
        await h.handlers.manageRecipes("edit endpoint");
        expect(h.store.read("endpoint").body).toBe("new {{resource}}");
        await h.handlers.manageRecipes("rm endpoint");
        expect(h.store.names()).toEqual(["endpoint"]);
        await h.handlers.manageRecipes("rm endpoint");
        expect(h.store.names()).toEqual([]);
    });

    test("generation failure restores the input state without writing", async () => {
        const h = harness();
        const previousAbort = h.state.abort;
        const handlers = createRecipeHandlers(h.state, h.deps, {
            store: h.store,
            generate: async () => {
                throw new Error("provider unavailable");
            },
        });
        await expect(handlers.manageRecipes("save endpoint resource")).rejects.toThrow("provider unavailable");
        expect(h.state.abort).toBe(previousAbort);
        expect(h.state.busy).toBe(false);
        expect(h.store.names()).toEqual([]);
    });

    test("cancelled generation cannot save or reset a newer turn's abort controller", async () => {
        const h = harness();
        let newerAbort: AbortController;
        const handlers = createRecipeHandlers(h.state, h.deps, {
            store: h.store,
            generate: async () => {
                h.state.abort.abort();
                newerAbort = new AbortController();
                h.state.abort = newerAbort;
                h.state.busy = true;
                return "draft";
            },
        });
        await handlers.manageRecipes("save endpoint resource");
        expect(h.store.names()).toEqual([]);
        expect(h.state.abort).toBe(newerAbort!);
        expect(h.state.busy).toBe(true);
    });
});
