import { describe, expect, test } from "bun:test";
import { CostTracker, sortLiveRows } from "@notshekhar/loop-core";
import { forwardTo, makeStateView, SlotManager, type SharedState, type SlotInit } from "../src/interactive/slots";
import { formatSessionsChip, formatAge, liveActivity } from "../src/interactive/session-roster";
import type { ChatHistory } from "../src/interactive/components/chat-history";
import { TodoPanel } from "../src/interactive/components/todo-panel";

const strip = (s: string | null) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

function init(over: Partial<SlotInit> = {}): SlotInit {
    return {
        cwd: "/tmp",
        modelId: "m",
        provider: "xai",
        thinkingLevel: "off",
        agent: "default",
        oneShotAgent: null,
        session: null,
        latestContextTokens: 0,
        busy: false,
        abort: new AbortController(),
        pendingInjection: null,
        startupHooksDone: null,
        pendingPlan: null,
        planModeViaCycle: false,
        history: { name: "h" } as unknown as ChatHistory,
        todoPanel: new TodoPanel(),
        tracker: new CostTracker(),
        ...over,
    };
}

function shared(): SharedState {
    return {
        cycleCustomAgent: null,
        scrollbackFocus: false,
        pinnedInput: false,
        lastCtrlCAt: 0,
        timerEndsAt: null,
        timerLabel: "",
    };
}

describe("state views", () => {
    test("the foreground view follows the switch; a pinned view does not", () => {
        const slots = new SlotManager(init({ modelId: "a" }));
        const first = slots.foreground;
        const sh = shared();
        const fg = makeStateView(sh, () => slots.foreground);
        const pinned = makeStateView(sh, () => first);

        const second = slots.add(init({ modelId: "b" }));
        slots.switchTo(second);
        expect(fg.modelId).toBe("b");
        expect(pinned.modelId).toBe("a");

        // A background turn ending writes to ITS session, not the screen's.
        first.busy = true;
        pinned.busy = false;
        expect(first.busy).toBe(false);
        fg.busy = true;
        expect(second.busy).toBe(true);
        expect(first.busy).toBe(false);
    });

    test("app-wide fields are shared by every view", () => {
        const slots = new SlotManager(init());
        const sh = shared();
        const a = makeStateView(sh, () => slots.foreground);
        const b = makeStateView(sh, () => slots.foreground);
        a.pinnedInput = true;
        expect(b.pinnedInput).toBe(true);
        expect(sh.pinnedInput).toBe(true);
    });

    test("forwardTo binds methods to the current target and forwards writes", () => {
        let current: string[] = ["x"];
        const q = forwardTo(() => current);
        q.push("y");
        expect(current).toEqual(["x", "y"]);
        current = [];
        expect(q.length).toBe(0);
        current = ["p", "q"];
        q.length = 0;
        expect(current).toEqual([]);
        // Iteration and spread reach the real array.
        current = ["1", "2"];
        expect([...q]).toEqual(["1", "2"]);
    });

    test("a forwarded component keeps its own `this`", () => {
        const a = new TodoPanel();
        const b = new TodoPanel();
        let current = a;
        const panel = forwardTo(() => current);
        panel.setItems([{ content: "one", status: "pending" } as never]);
        expect(a.isEmpty()).toBe(false);
        expect(b.isEmpty()).toBe(true);
        current = b;
        expect(panel.isEmpty()).toBe(true);
    });
});

describe("parked prompts", () => {
    test("the foreground's prompt opens at once", async () => {
        const slots = new SlotManager(init());
        expect(await slots.waitForForeground(slots.foreground, "question")).toBe(true);
    });

    test("a background prompt parks as needs-input and opens on switch", async () => {
        const slots = new SlotManager(init());
        const bg = slots.foreground;
        bg.busy = true;
        const fg = slots.add(init());
        slots.switchTo(fg);

        let opened: boolean | null = null;
        const pending = slots.waitForForeground(bg, "bash approval").then((v) => (opened = v));
        await Promise.resolve();
        expect(opened).toBeNull();
        expect(bg.status).toBe("needs-input");
        expect(bg.activity).toBe("Waiting: bash approval");

        // Other status updates cannot hide a parked prompt.
        slots.setStatus(bg, "working", "Running bash…");
        expect(bg.status).toBe("needs-input");

        slots.switchTo(bg);
        await pending;
        expect(opened).toBe(true);
        expect(bg.status).toBe("working");
    });

    test("cancelling the turn releases its parked prompt as not shown", async () => {
        const slots = new SlotManager(init());
        const bg = slots.foreground;
        slots.switchTo(slots.add(init()));
        const abort = new AbortController();
        const pending = slots.waitForForeground(bg, "question", abort.signal);
        abort.abort();
        expect(await pending).toBe(false);
        expect(bg.waiters.size).toBe(0);
        expect(bg.status).toBe("idle");
    });
});

describe("roster", () => {
    test("a turn ending out of sight is done until looked at", () => {
        const slots = new SlotManager(init());
        const bg = slots.foreground;
        slots.switchTo(slots.add(init()));
        slots.settle(bg, false);
        expect(bg.status).toBe("done");
        slots.switchTo(bg);
        expect(bg.status).toBe("idle");
    });

    test("a finished session stops claiming what it was doing", () => {
        const slots = new SlotManager(init());
        const bg = slots.foreground;
        slots.switchTo(slots.add(init()));
        slots.setStatus(bg, "working", "Generating");
        expect(liveActivity(bg)).toBe("Generating · ");
        slots.settle(bg, false);
        expect(bg.activity).toBe("");
        expect(liveActivity(bg)).toBe("done · ");
        slots.switchTo(bg);
        expect(liveActivity(bg)).toBe("");
    });

    test("a failure out of sight is failed; on screen it is just idle", () => {
        const slots = new SlotManager(init());
        const first = slots.foreground;
        slots.settle(first, true);
        expect(first.status).toBe("idle");
        const other = slots.add(init());
        slots.settle(other, true);
        expect(other.status).toBe("failed");
    });

    test("the foreground cannot be removed", () => {
        const slots = new SlotManager(init());
        expect(slots.remove(slots.foreground)).toBe(false);
        const other = slots.add(init());
        expect(slots.remove(other)).toBe(true);
        expect(slots.all()).toHaveLength(1);
    });

    test("rows sort by what needs you, then recency", () => {
        const rows = sortLiveRows([
            { id: "idle", status: "idle", lastActivityAt: 9 },
            { id: "old-work", status: "working", lastActivityAt: 1 },
            { id: "ask", status: "needs-input", lastActivityAt: 0 },
            { id: "new-work", status: "working", lastActivityAt: 5 },
            { id: "done", status: "done", lastActivityAt: 3 },
        ] as const);
        expect(rows.map((r) => r.id)).toEqual(["ask", "new-work", "old-work", "done", "idle"]);
    });

    test("the status chip counts the other sessions", () => {
        const slots = new SlotManager(init());
        expect(formatSessionsChip([])).toBeNull();
        const a = slots.add(init());
        const b = slots.add(init());
        const c = slots.add(init());
        slots.setStatus(a, "working");
        slots.setStatus(b, "working");
        void slots.waitForForeground(c, "question");
        expect(strip(formatSessionsChip([a, b, c]))).toBe("◆ 1 needs you · ● 2 working (ctrl+s)");
        expect(strip(formatSessionsChip([slots.add(init())]))).toBe("1 other session (ctrl+s)");
    });

    test("ages read like a clock", () => {
        expect(formatAge(5_000)).toBe("now");
        expect(formatAge(4 * 60_000)).toBe("4m");
        expect(formatAge(2 * 3_600_000)).toBe("2h");
        expect(formatAge(3 * 86_400_000)).toBe("3d");
    });
});
