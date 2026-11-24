/**
 * /shells with no arguments is the visible way to stop a background shell:
 * a picker of shells, then what to do with the one chosen. These drive the
 * real handler against the real registry and a real child process.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SelectItem } from "@notshekhar/loop-tui";
import { killAllShells, listShells } from "@notshekhar/loop-core";
import { ShellsPanel } from "../src/interactive/components/shells-panel";
import { createShellsHandlers } from "../src/interactive/handlers/shells-handlers";
import type { AppDeps } from "../src/interactive/deps";
import type { AppState } from "../src/interactive/state";

/** Finished shells stay listed, so every test gets a session of its own. */
let run = 0;
let SESSION = "";

/** The handler with a scripted picker: each menu answers with the item `choose` returns. */
function handlers(choose: (items: SelectItem[], title?: string) => SelectItem | null) {
    const said: string[] = [];
    const menus: string[] = [];
    const deps = {
        tui: { requestRender() {} },
        history: { addSystem: (t: string) => said.push(t), addError: (t: string) => said.push(`error: ${t}`) },
        shellsPanel: new ShellsPanel(),
        selectOnce: async (items: SelectItem[], title?: string) => {
            menus.push(title ?? "");
            return choose(items, title);
        },
    } as unknown as AppDeps;
    const state = { session: { id: SESSION }, cwd: process.cwd() } as unknown as AppState;
    return { ...createShellsHandlers(state, deps), said, menus };
}

const running = () => listShells(SESSION).filter((s) => s.status === "running");

/** A process's liveness, asked of the OS rather than the registry. */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await Bun.sleep(20);
}

beforeEach(() => {
    SESSION = `shells-picker-test-${++run}`;
});

afterEach(() => {
    killAllShells();
});

describe("/shells picker", () => {
    test("pick a running shell, choose Stop it, and the process is gone", async () => {
        const h = handlers((items, title) =>
            title?.startsWith("Background shells") ? items[0] : (items.find((i) => i.value === "stop") ?? null),
        );
        await h.manageShells("run sleep 30");
        const [shell] = running();
        expect(shell?.pid).toBeGreaterThan(0);
        expect(alive(shell.pid!)).toBe(true);

        await h.manageShells("");
        expect(h.menus).toHaveLength(2);
        await until(() => !alive(shell.pid!));
        expect(alive(shell.pid!)).toBe(false);
        expect(running()).toHaveLength(0);
        expect(h.said.at(-1)).toContain("stopped");
    });

    test("with two running, the first row stops both", async () => {
        const h = handlers((items) => items[0]);
        await h.manageShells("run sleep 30");
        await h.manageShells("run sleep 31");
        const pids = running().map((s) => s.pid!);
        expect(pids).toHaveLength(2);
        await h.manageShells("");
        await until(() => pids.every((p) => !alive(p)));
        expect(pids.filter(alive)).toEqual([]);
    });

    test("Esc on the picker stops nothing", async () => {
        const h = handlers(() => null);
        await h.manageShells("run sleep 30");
        await h.manageShells("");
        expect(running()).toHaveLength(1);
    });

    test("nothing to pick says how to start one instead of opening an empty menu", async () => {
        const h = handlers(() => null);
        await h.manageShells("");
        expect(h.menus).toHaveLength(0);
        expect(h.said[0]).toContain("No background shells");
    });
});
