import { beforeEach, describe, expect, test } from "bun:test";
import {
    SessionManager,
    isPlanModeActive,
    setPlanMode,
    type generateHandoff,
    type getCatalog,
} from "@notshekhar/loop-core";
import { useTempSessionDb } from "../../core/test/helpers/temp-db";
import { createHandoffHandlers } from "../src/interactive/handlers/handoff-handlers";
import type { AppDeps } from "../src/interactive/deps";
import type { AppState } from "../src/interactive/state";
import { initTheme } from "../src/interactive/ui/theme";

useTempSessionDb();
beforeEach(() => initTheme("dark"));

async function harness() {
    const manager = new SessionManager();
    const source = await manager.create({ cwd: "/tmp/handoff-ui", provider: "xai", model: "xai/current" });
    await source.append({ type: "message", role: "user", content: "Fix the endpoint", ts: 1 });
    const state = {
        session: source,
        modelId: "xai/current",
        provider: "xai",
        cwd: source.info.cwd,
        agent: "default",
        busy: false,
        abort: new AbortController(),
        startupHooksDone: null,
    } as unknown as AppState;
    const choices: Array<string | null> = [];
    const answers: string[] = [];
    const messages: string[] = [];
    const submitted: string[] = [];
    const generated: Parameters<typeof generateHandoff>[0][] = [];
    let resets = 0;
    const deps = {
        manager,
        history: {
            addSystem: (text: string) => messages.push(text),
            addUser: () => {},
            addChild: () => {},
            invalidate: () => {},
            reset: () => {},
        },
        tui: { requestRender: () => {}, setTitle: () => {} },
        statusLine: { setSession: () => {}, setModel: () => {}, setAgent: () => {}, setPlanMode: () => {} },
        tracker: {
            reset: () => {
                resets++;
            },
        },
        todoPanel: { clear: () => {}, setItems: () => {} },
        shellsPanel: { setShells: () => {} },
        editor: {
            setText: () => {},
            onSubmit: async (text: string) => {
                expect(state.busy).toBe(false);
                submitted.push(text);
            },
        },
        selectOnce: async () => {
            const value = choices.shift();
            return value ? { value, label: value } : null;
        },
        searchOnce: async () => {
            const value = choices.shift();
            return value ? { value, label: value } : null;
        },
        promptOnce: async () => answers.shift() ?? "",
        showWorking: () => {},
        hideWorking: () => {},
        refreshStatusLine: () => {},
    } as unknown as AppDeps;
    const services = {
        generate: (async (opts) => {
            generated.push(opts);
            return "## Next steps\nFix validation and rerun tests.";
        }) as typeof generateHandoff,
        gitStatus: async () => " M endpoint.ts",
        catalog: (async () => ({})) as typeof getCatalog,
        agents: () => [
            { name: "default", builtin: true, prompt: "default" },
            { name: "plan", builtin: true, prompt: "plan" },
        ],
    };
    return {
        manager,
        source,
        state,
        deps,
        services,
        choices,
        answers,
        messages,
        submitted,
        generated,
        resets: () => resets,
        handlers: createHandoffHandlers(state, deps, services),
    };
}

describe("/handoff", () => {
    test("edits the brief and opens a persistent session with the chosen model and agent", async () => {
        const h = await harness();
        const before = JSON.stringify(h.source.entries());
        h.choices.push("edit", "open", "anthropic/next", "plan");
        h.answers.push("## Next steps\nInvestigate the regression first.");
        await h.handlers.manageHandoff("focus on validation");
        expect(h.generated[0].focus).toBe("focus on validation");
        expect(h.generated[0].workspaceStatus).toContain("endpoint.ts");
        expect(h.state.session!.id).not.toBe(h.source.id);
        expect(h.state.modelId).toBe("anthropic/next");
        expect(h.state.provider).toBe("anthropic");
        expect(h.state.agent).toBe("plan");
        expect(isPlanModeActive(h.state.session!.id)).toBe(true);
        expect(h.submitted).toEqual([]);
        expect(h.resets()).toBe(1);
        expect(JSON.stringify(h.source.entries())).toBe(before);
        const reopened = await h.manager.open(h.state.session!.id);
        expect(JSON.stringify(reopened.entries())).toContain("Investigate the regression first.");
        expect(reopened.info.parentSession).toBe(h.source.path);
    });

    test("open and continue starts exactly one normal turn in the destination", async () => {
        const h = await harness();
        h.choices.push("continue", "xai/current", "default");
        await h.handlers.manageHandoff("");
        expect(h.submitted).toHaveLength(1);
        expect(h.submitted[0]).toContain("Continue from the handoff brief");
        expect(h.state.session!.id).not.toBe(h.source.id);
    });

    for (const selections of [[null], ["open", null], ["open", "xai/current", null]]) {
        test(`cancellation at stage ${selections.length} preserves the source and creates nothing`, async () => {
            const h = await harness();
            h.choices.push(...selections);
            await h.handlers.manageHandoff("");
            expect(h.state.session).toBe(h.source);
            expect(h.manager.list(h.state.cwd)).toHaveLength(1);
            expect(h.state.modelId).toBe("xai/current");
            expect(h.state.busy).toBe(false);
            expect(h.resets()).toBe(0);
        });
    }

    test("the current agent retains a source session's read-only gate", async () => {
        const h = await harness();
        setPlanMode(h.source.id, true);
        h.choices.push("open", "xai/current", "default");
        await h.handlers.manageHandoff("");
        expect(isPlanModeActive(h.state.session!.id)).toBe(true);
        expect(isPlanModeActive(h.source.id)).toBe(true);
    });

    test("provider failure leaves the source active and restores input state", async () => {
        const h = await harness();
        const previousAbort = h.state.abort;
        const handlers = createHandoffHandlers(h.state, h.deps, {
            ...h.services,
            generate: async () => {
                throw new Error("unavailable");
            },
        });
        await expect(handlers.manageHandoff("")).rejects.toThrow("unavailable");
        expect(h.state.session).toBe(h.source);
        expect(h.state.abort).toBe(previousAbort);
        expect(h.state.busy).toBe(false);
        expect(h.manager.list(h.state.cwd)).toHaveLength(1);
    });

    test("cancelled generation cannot switch sessions or reset a newer turn", async () => {
        const h = await harness();
        let newerAbort: AbortController;
        const handlers = createHandoffHandlers(h.state, h.deps, {
            ...h.services,
            generate: async () => {
                h.state.abort.abort();
                newerAbort = new AbortController();
                h.state.abort = newerAbort;
                h.state.busy = true;
                return "discard this";
            },
        });
        await handlers.manageHandoff("");
        expect(h.state.session).toBe(h.source);
        expect(h.state.abort).toBe(newerAbort!);
        expect(h.state.busy).toBe(true);
        expect(h.manager.list(h.state.cwd)).toHaveLength(1);
    });
});
