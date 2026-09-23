#!/usr/bin/env bun
/**
 * End-to-end screen tests for the TUI.
 *
 * The renderer's bugs do not show up in unit tests, because none of them are
 * about what a component renders — they are about where the terminal ends up
 * putting it. A conversation printed twice into the scrollback, a blank band
 * where a menu closed, /new leaving the previous session on screen: every one of
 * those is a correct frame, drawn wrong. The only way to catch them is to run
 * loop in a real pty and look at the screen.
 *
 * Two invariants carry most of the weight:
 *
 *   NOTHING IS EVER PRINTED TWICE. A line that has scrolled off is committed; the
 *   terminal cannot be made to move it, only to print it again. So a duplicate in
 *   the scrollback means the renderer tried to move history and made a copy.
 *
 *   TRANSIENT UI COSTS THE FRAME NOTHING. Opening a menu or a completion list
 *   must not scroll the terminal, because the rows it scrolls off cannot come
 *   back when it closes — which is what leaves a band behind.
 *
 * Run: bun packages/cli/test/e2e/run.ts [name ...]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Session, withSession } from "./harness";

const NOIR = '{"theme": "night"}';

const failures: string[] = [];
let checks = 0;

function check(cond: unknown, label: string, detail?: unknown): void {
    checks++;
    if (cond) {
        console.log(`    ok   ${label}`);
        return;
    }
    console.log(`    FAIL ${label}`);
    if (detail !== undefined && detail !== "") {
        const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 1);
        for (const line of String(text).split("\n")) console.log(`         ${line}`);
    }
    failures.push(label);
}

/** Lines printed more than once across scrollback + screen. */
function duplicates(session: Session, needle = "filler "): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const raw of [...session.historyRows(), ...session.screenRows()]) {
        const line = raw.trim();
        if (!line.includes(needle)) continue;
        counts[line] = (counts[line] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 1));
}

function hasDuplicates(session: Session, needle = "filler "): boolean {
    return Object.keys(duplicates(session, needle)).length > 0;
}

/** A conversation taller than the screen, with identifiable lines. */
async function fill(session: Session, n: number, settle = 0.25): Promise<void> {
    for (let i = 0; i < n; i++) await session.send(`filler ${i}\r`, settle);
    await session.pump(0.8);
}

/** Index of a run of `size` blank rows, or -1 — the shape of a shrink gap. */
function blankBand(rows: string[], size = 3): number {
    for (let i = 0; i <= rows.length - size; i++) {
        let all = true;
        for (let j = i; j < i + size; j++) if (rows[j]!.trim()) all = false;
        if (all) return i;
    }
    return -1;
}

/** The filler indices as printed, in the order they appear. */
function fillerOrder(session: Session): number[] {
    const printed = [...session.historyRows(), ...session.screenRows()].filter((r) => r.includes("filler "));
    const order: number[] = [];
    for (const r of printed) {
        const tail = r.split("filler ")[1]!;
        const head = tail.split(/\s+/)[0]!;
        if (/^\d+$/.test(tail.trim())) order.push(Number(head));
    }
    return order;
}

const isSorted = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! <= x);

/** The status line under the editor, not the masthead's "shift+tab agents" hint. */
const promptRows = (rows: string[]): number[] =>
    rows.map((r, i) => (r.includes("agent default (shift+tab)") ? i : -1)).filter((i) => i >= 0);

const rowsWith = (rows: string[], needle: string): number[] =>
    rows.map((r, i) => (r.includes(needle) ? i : -1)).filter((i) => i >= 0);

/** Enable the Lua builtin and drop a script into the session's HOME. */
function withLua(s: Session, name: string, source: string): void {
    s.writeHome(".loop/extensions.json", '{"builtins": {"lua": true}}');
    s.writeHome(`.loop/lua/${name}`, source);
}

/**
 * A user-scope MCP server that publishes resources and prompts as well as
 * tools. User scope, not project scope, so it connects without the trust
 * prompt standing between the test and the thing being tested.
 */
function mcpSettings(): string {
    const fixture = join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "core",
        "test",
        "fixtures",
        "mock-mcp-features.mjs",
    );
    return JSON.stringify({
        theme: "night",
        mcpServers: { feat: { type: "stdio", command: process.execPath, args: [fixture] } },
    });
}

// ---------------------------------------------------------------- scenarios

/** The first screen: masthead, and a prompt block that is actually drawn. */
async function testBoot(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        const rows = s.screenRows();
        check(
            rows.some((r) => r.includes("Welcome back")),
            "masthead is on screen",
        );
        check(s.committed() === 0, "nothing scrolled off a fresh boot");
        check(
            rows.some((r) => r.trim().startsWith("─")),
            "the prompt block is on screen",
            rows,
        );
    });
}

/** A conversation past the fold is printed once, in order. */
async function testNoDuplicatesWhileGrowing(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 30);
        check(!hasDuplicates(s), "no line was printed twice while the transcript grew", duplicates(s));
        const order = fillerOrder(s);
        check(isSorted(order), "the transcript is in order", order.slice(0, 40));
    });
}

/** Typing `/` and deleting it must leave the screen exactly as it was. */
async function testCompletionListCostsNothing(): Promise<void> {
    for (const [label, settings] of [["noir", NOIR]] as const) {
        await withSession({ settings }, async (s) => {
            await s.pump(7);
            await fill(s, 20);
            const before = s.screenRows();
            const committedBefore = s.committed();

            await s.send("/", 1.6);
            const openRows = s.screenRows();
            check(
                openRows.some((r) => r.includes("help")),
                `[${label}] the completion list is showing`,
            );
            check(
                s.committed() === committedBefore,
                `[${label}] opening it scrolled nothing off`,
                `${s.committed() - committedBefore} rows committed`,
            );

            await s.send("\x7f", 1.6);
            const after = s.screenRows();
            check(
                JSON.stringify(after) === JSON.stringify(before),
                `[${label}] deleting it put the screen back exactly`,
                after
                    .map((a, i) => (a !== before[i] ? `${i}|${JSON.stringify(a)} != ${JSON.stringify(before[i])}` : ""))
                    .filter(Boolean)
                    .join("\n"),
            );
            check(!hasDuplicates(s), `[${label}] and printed nothing twice`, duplicates(s));
        });
    }
}

/** A menu opening and closing must not move the conversation. */
async function testSelectorCostsNothing(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 20);
        const committedBefore = s.committed();
        const topBefore = s.screenRows();

        await s.send("/settings\r", 3.0);
        const rows = s.screenRows();
        check(
            rows.some((r) => r.includes("theme:")),
            "the settings menu is showing",
        );
        // Running the command appends its own echo to the transcript ("/settings"
        // plus a blank), and on a full screen those two rows legitimately scroll
        // off. The MENU must cost nothing on top of that: inline it was fifteen
        // rows tall, and all fifteen came out of the top of the screen.
        const echoRows = 2;
        const committed = s.committed() - committedBefore;
        check(
            committed <= echoRows,
            "the menu itself scrolled nothing off — only the command's echo",
            `${committed} rows committed, at most ${echoRows} expected`,
        );
        // Scrolling by the echo means row N of the new screen is row N+echo of
        // the old one — the conversation moved by exactly that and no more.
        check(
            JSON.stringify(s.screenRows().slice(0, 6)) === JSON.stringify(topBefore.slice(echoRows, echoRows + 6)),
            "the transcript above the menu moved by exactly that echo",
            `${JSON.stringify(s.screenRows().slice(0, 3))}\n${JSON.stringify(topBefore.slice(echoRows, echoRows + 3))}`,
        );

        await s.send("\x1b", 2.5);
        const after = s.screenRows();
        check(blankBand(after.slice(0, 20)) === -1, "no blank band where the menu was", after.slice(0, 20));
        check(!hasDuplicates(s), "and nothing was printed twice", duplicates(s));
    });
}

/** /new on a long conversation starts clean: banner back, old chat gone. */
async function testNewSession(): Promise<void> {
    for (const [label, settings] of [["noir", NOIR]] as const) {
        await withSession({ settings }, async (s) => {
            await s.pump(7);
            await fill(s, 30);
            await s.send("/new\r", 3.5);
            const rows = s.screenRows();
            check(
                rows.some((r) => r.includes("Welcome back")),
                `[${label}] /new shows the masthead again`,
                rows.slice(0, 12),
            );
            check(
                !rows.some((r) => r.includes("filler ")),
                `[${label}] /new leaves none of the old conversation on screen`,
                rows.filter((r) => r.includes("filler ")).slice(0, 5),
            );
        });
    }
}

/** /clear wipes the screen and starts the session's header again. */
async function testClearScreen(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 30);
        await s.send("/clear\r", 3.0);
        const rows = s.screenRows();
        check(
            rows.some((r) => r.includes("Welcome back")),
            "/clear shows the masthead again",
            rows.slice(0, 12),
        );
        check(
            !rows.some((r) => r.includes("filler ")),
            "/clear leaves no old conversation on screen",
        );
    });
}

/**
 * A background shell appears in the pinned panel without disturbing the
 * conversation above it — and killing it does not strand a band.
 */
async function testShellsPanel(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 20);
        const committedBefore = s.committed();

        await s.send("/shells run sleep 30\r", 2.0);
        let rows = s.screenRows();
        check(
            rows.some((r) => r.includes("bash_1")),
            "the shell shows up on screen",
            rows.slice(-12),
        );
        check(!hasDuplicates(s), "starting one printed nothing twice", duplicates(s));
        const order = fillerOrder(s);
        check(isSorted(order), "the conversation above it is intact and in order", order.slice(0, 40));

        // The panel grew the frame; growth is safe, but the rows it pushed off
        // must be exactly as many as it added, never a duplicated stretch.
        await s.send("/shells\r", 1.5);
        check(
            s.screenRows().some((r) => r.includes("bash_1")),
            "/shells lists it",
        );
        check(!hasDuplicates(s), "listing printed nothing twice", duplicates(s));

        await s.send("/shells kill all\r", 2.0);
        rows = s.screenRows();
        check(
            rows.some((r) => r.includes("Killed")),
            "killing it is reported",
            rows.slice(-12),
        );
        check(!hasDuplicates(s), "killing printed nothing twice", duplicates(s));
        check(blankBand(s.screenRows()) === -1, "no blank band was left behind", s.screenRows());
        check(s.committed() >= committedBefore, "history only ever grew");
    });
}

/** esc ends a turn; it must not take a background shell with it. */
async function testShellsSurviveEsc(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await s.send("/shells run sleep 30\r", 2.0);
        await s.send("\x1b", 0.6);
        await s.send("\x1b", 0.6);
        await s.send("/shells\r", 1.5);
        const rows = s.screenRows();
        check(
            rows.some((r) => r.includes("running")),
            "the shell is still running after esc",
            rows.slice(-14),
        );
        await s.send("/shells kill all\r", 1.5);
    });
}

/** A resize re-wraps without losing or duplicating the conversation. */
async function testResize(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 20);
        await s.resize(90, 24);
        await s.pump(2.5);
        const rows = s.screenRows();
        check(rows.length === 24, "the frame follows the new height");
        check(
            rows.some((r) => r.trim()),
            "the screen is not blank after a resize",
            rows,
        );
    });
}

/**
 * The chat is on the alternate screen: nothing is committed while it runs.
 *
 * This is the property the alt screen was adopted for. Committed rows were
 * the source of the duplicated chat, the blank bands and the stranded frames,
 * because a row that has scrolled off can only be reprinted, never moved. On
 * the alternate screen there are no committed rows at all — and the
 * conversation is not lost either, because leaving the screen prints it once,
 * whole, into the terminal.
 */
async function testAltScreenKeepsScrollbackClean(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 40);
        check(s.committed() === 0, "40 messages committed nothing to the terminal's scrollback", s.committed());
        check(
            s.screenRows().some((r) => r.trim().startsWith("─")),
            "the prompt is still drawn after a long conversation",
        );

        await s.send("\x03", 0.4);
        await s.send("\x03", 2.5);
        await s.pump(2.0);
        const left = [...s.historyRows(), ...s.screenRows()];
        check(
            left.some((r) => r.includes("Welcome back")),
            "quitting prints the transcript into the terminal instead of losing it",
        );
    });
}

/**
 * A menu on a SHORT conversation must not cover the editor's status rows.
 *
 * Overlays are anchored to where the frame's content ends, not to the bottom
 * of the terminal. Those are the same row once the conversation fills the
 * screen, and differ by one while it does not — so this only reproduces on a
 * short transcript, which is why the other selector scenario (20 messages,
 * frame already full) cannot see it. The alt-screen move first reported the
 * padded viewport height as the content height and landed every menu one row
 * low, over the "agent … (shift+tab)" line.
 */
async function testMenuAnchorsToTheFrameNotTheScreen(): Promise<void> {
    for (const [label, keys] of [
        ["settings", "/settings\r"],
        ["completion", "/"],
    ] as const) {
        await withSession({ settings: NOIR }, async (s) => {
            await s.pump(7);
            await fill(s, 2); // deliberately short: the frame must not fill the screen
            await s.send(keys, 2.5);
            const rows = s.screenRows();
            check(
                rows.some((r) => r.includes("shift+tab")),
                `[${label}] the menu left the editor's status rows visible`,
                rows.slice(-5),
            );
            check(
                rows.some((r) => r.includes("session") && r.includes("ctx")),
                `[${label}] and the session line below them too`,
                rows.slice(-3),
            );
        });
    }
}

/**
 * With pinning off, the prompt scrolls away with the transcript — and a
 * menu belongs to the prompt, not to the screen.
 *
 * What broke: overlays anchored to `rows - contentHeight`, the document's
 * length, which knows nothing about where the window onto it is. Scrolled
 * back, the prompt was below the screen and `/` or `/settings` painted a
 * menu floating over the transcript with no prompt under it.
 *
 * The contract now: a key brings the prompt back into view (a shell scrolls
 * to the bottom on a keystroke), so a menu always opens ON the prompt; and
 * wheeling away while one is open takes the menu along — it is hidden with
 * the prompt and back when either the wheel or a key returns.
 */
async function testMenuFollowsThePromptWhenScrolled(): Promise<void> {
    const up = "\x1b[<64;20;10M";
    const down = "\x1b[<65;20;10M";
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 30);
        for (let i = 0; i < 3; i++) await s.send(up, 0.12);
        await s.pump(0.6);
        check(promptRows(s.screenRows()).length === 0, "scrolled back, the prompt is off the screen");

        await s.send("/", 1.6);
        let rows = s.screenRows();
        let at = promptRows(rows);
        check(at.length > 0, "typing brought the prompt back", rows.slice(-4));
        const listing = rows
            .map((r, i) => (r.includes("help") && r.includes("Show available commands") ? i : -1))
            .filter((i) => i >= 0);
        check(
            listing.length > 0 && at.length > 0 && listing[0]! < at[0]!,
            "and the completion list opened above it, not floating in the transcript",
            rows.slice(-12),
        );

        for (let i = 0; i < 3; i++) await s.send(up, 0.12);
        await s.pump(0.6);
        rows = s.screenRows();
        check(promptRows(rows).length === 0, "wheeling away takes the prompt off again");
        check(
            !rows.some((r) => r.includes("Show available commands")),
            "and the completion list went with it instead of floating",
            rows.slice(-12),
        );
        for (let i = 0; i < 6; i++) await s.send(down, 0.1);
        await s.pump(0.6);
        rows = s.screenRows();
        check(
            rows.some((r) => r.includes("Show available commands")) && promptRows(rows).length > 0,
            "wheeling back shows both again",
            rows.slice(-12),
        );

        await s.send("\x7f", 1.0);
        for (let i = 0; i < 3; i++) await s.send(up, 0.12);
        await s.pump(0.6);
        await s.send("/settings\r", 2.5);
        rows = s.screenRows();
        at = promptRows(rows);
        const menu = rowsWith(rows, "theme:");
        check(
            menu.length > 0 && at.length > 0 && menu[0]! < at[0]!,
            "/settings opens on the prompt too",
            rows.slice(-8),
        );
    });
}

/**
 * A trackpad keeps sending wheel-up for a few hundred ms after the fingers
 * lift. Scroll back, start typing: the first key jumps to the prompt, and the
 * tail must NOT drag the view up again — that was the prompt and the
 * completion list flickering, and the jump "only working on the second key".
 *
 * The wheel yields to a keyboard jump for a moment (extended while keys keep
 * coming), and is back to normal once the typing stops.
 */
async function testWheelTailYieldsToTyping(): Promise<void> {
    const up = "\x1b[<64;20;10M";
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 30);
        for (let i = 0; i < 4; i++) await s.send(up, 0.03); // the flick
        await s.send("h", 0.05);
        check(promptRows(s.screenRows()).length > 0, "the FIRST key brings the prompt back", s.screenRows().slice(-4));
        // The tail keeps coming while the user types on. (pump() polls at 20 ms,
        // so each "60 ms" here can run a little over; keys are interleaved
        // densely, the way typing actually is, rather than after a long silent
        // tail.)
        for (const ch of "ey") {
            for (let i = 0; i < 2; i++) await s.send(up, 0.06);
            await s.send(ch, 0.05);
        }
        for (let i = 0; i < 2; i++) await s.send(up, 0.06);
        await s.pump(0.3);
        const rows = s.screenRows();
        check(promptRows(rows).length > 0, "the tail did not drag the prompt away again", rows.slice(-4));
        check(
            rows.some((r) => r.trim() === "hey"),
            "and what was typed is on it",
            rows.slice(-6),
        );

        await s.pump(0.6); // the hold has lapsed
        for (let i = 0; i < 3; i++) await s.send(up, 0.12);
        await s.pump(0.5);
        check(promptRows(s.screenRows()).length === 0, "a real scroll afterwards still works");
    });
}

/**
 * The wheel scrolls the conversation, the way the terminal's own
 * scrollback would — and the prompt goes with it, because it is part of
 * the same document, exactly as it is when a shell command's output is
 * scrolled back over.
 *
 * On the alternate screen there is no terminal scrollback, so the wheel has
 * to reach loop or there is no scrolling at all. What broke it: loop's
 * Terminal.start() cleanses stale modes (`?1000l ?1006l`) AFTER the alt
 * screen asks for mouse tracking, switching it straight back off.
 */
async function testWheelScrollsTheDocument(): Promise<void> {
    const up = "\x1b[<64;20;10M";
    const down = "\x1b[<65;20;10M";
    await withSession({ settings: NOIR }, async (s) => {
        await s.pump(7);
        await fill(s, 30);
        const rest = s.screenRows();
        check(
            rest.slice(-5).some((r) => r.includes("shift+tab")),
            "the prompt is drawn at rest",
        );

        for (let i = 0; i < 6; i++) await s.send(up, 0.12);
        await s.pump(0.8);
        const scrolled = s.screenRows();
        check(
            JSON.stringify(rest.slice(0, 6)) !== JSON.stringify(scrolled.slice(0, 6)),
            "the wheel scrolled the conversation",
            scrolled.slice(0, 3),
        );
        check(s.committed() === 0, "scrolling committed nothing to the terminal");
        // A real terminal only SENDS wheel reports to an app that asked for
        // them, and this harness sends them regardless — so the request itself
        // has to be asserted, or the cleanse switching mouse tracking back off
        // after startup goes unnoticed here.
        check(s.mouseTrackingEnabled(), "loop still has mouse tracking on after startup");

        for (let i = 0; i < 12; i++) await s.send(down, 0.1);
        await s.pump(0.8);
        check(
            JSON.stringify(s.screenRows()) === JSON.stringify(rest),
            "scrolling back down returns to the live end",
        );
    });
}

/**
 * `pinnedInput`: the prompt is held on the last rows from the first frame,
 * the wheel scrolls only the transcript above it, and quitting still prints
 * the whole conversation.
 *
 * The last point is the one that bit: the pinned frame is a VStack, and the
 * exit path renders it WITHOUT a viewport, where a `basis: 0` transcript is
 * zero rows — the conversation was gone from the terminal on quit.
 */
async function testPinnedInput(): Promise<void> {
    const up = "\x1b[<64;20;10M";
    const down = "\x1b[<65;20;10M";
    await withSession({ settings: '{"theme": "night", "pinnedInput": true}' }, async (s) => {
        await s.pump(7);
        const boot = s.screenRows();
        check(
            boot.some((r) => r.includes("Welcome back")),
            "masthead is on screen",
        );
        const atBoot = promptRows(boot);
        check(
            atBoot.length > 0 && atBoot[atBoot.length - 1]! >= boot.length - 4,
            "the prompt is on the last rows from the start",
            atBoot,
        );

        await fill(s, 30);
        const rest = s.screenRows();
        for (let i = 0; i < 6; i++) await s.send(up, 0.12);
        await s.pump(0.8);
        const scrolled = s.screenRows();
        check(
            JSON.stringify(rest.slice(0, 6)) !== JSON.stringify(scrolled.slice(0, 6)),
            "the wheel scrolled the transcript",
            scrolled.slice(0, 3),
        );
        check(
            JSON.stringify(promptRows(scrolled)) === JSON.stringify(promptRows(rest)),
            "and the prompt stayed put while it did",
        );
        check(s.committed() === 0, "scrolling committed nothing to the terminal");
        for (let i = 0; i < 12; i++) await s.send(down, 0.1);
        await s.pump(0.8);
        check(
            JSON.stringify(s.screenRows()) === JSON.stringify(rest),
            "scrolling back down returns to the live end",
        );

        await s.send("\x03", 0.4);
        await s.send("\x03", 2.5);
        await s.pump(2.0);
        const left = [...s.historyRows(), ...s.screenRows()];
        check(
            left.some((r) => r.includes("Welcome back")),
            "quitting prints the whole transcript, masthead included",
        );
    });
}

/**
 * A Lua script draws a widget and a Lua keymap summons it.
 *
 * This is the only test that proves the whole chain in a real terminal: the
 * embedded wasm boots, ~/.loop/lua auto-loads with no install step, a Lua
 * table satisfies the TUI's component contract, and a Lua-registered key
 * binding reaches the input listener ahead of the editor.
 */
async function testLuaWidget(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        // Written after the session built HOME, before loop has read anything.
        withLua(
            s,
            "init.lua",
            `
local W = { ticks = 0 }

function W:render(width)
  local bar = string.rep("=", self.ticks % 10)
  return {
    "+" .. string.rep("-", width - 2) .. "+",
    string.format("| LUAWIDGET %-" .. (width - 13) .. "s |", bar),
    "+" .. string.rep("-", width - 2) .. "+",
  }
end

function W:on_key(data)
  if data == "j" then self.ticks = self.ticks + 1 return true end
  return false
end

-- Placement lives on the widget table itself, so \`self\` inside render is W.
W.anchor, W.width, W.offset_y = "center", 40, -2

HANDLE = nil
loop.keymap.set("ctrl+g", function()
  if HANDLE then HANDLE:hide(); HANDLE = nil
  else HANDLE = loop.widget.show(W) end
end)
`,
        );
        await s.pump(8);
        let rows = s.screenRows();
        check(
            !rows.some((r) => r.includes("LUAWIDGET")),
            "no widget before the key is pressed",
        );

        const committedBefore = s.committed();
        await s.send("\x07", 0); // ctrl+g
        await s.pump(2);
        rows = s.screenRows();
        check(
            rows.some((r) => r.includes("LUAWIDGET")),
            "the Lua widget is on screen after ctrl+g",
            rows,
        );

        // A widget is transient UI: showing it must not scroll the transcript,
        // because rows pushed off cannot come back when it closes.
        check(s.committed() === committedBefore, "showing a widget scrolled nothing off");

        // It is centred, not simply appended at the bottom.
        const widgetRows = rowsWith(rows, "LUAWIDGET");
        check(
            widgetRows.length > 0 && widgetRows[0]! >= 2 && widgetRows[0]! <= rows.length - 3,
            "the widget is placed away from the screen edges",
            widgetRows,
        );

        await s.send("\x07", 0); // toggle it back off
        await s.pump(2);
        check(
            !s.screenRows().some((r) => r.includes("LUAWIDGET")),
            "ctrl+g hides it again",
        );

        // Kitty protocol reports press, repeat AND release for one keypress.
        // A binding that fires on all three toggles twice, so whatever it opens
        // is visible only while the key is held down. Press + release must
        // leave the widget shown. ('g' = 103, modifier 5 = ctrl, ":3" = release)
        await s.send("\x1b[103;5u", 0.5);
        await s.send("\x1b[103;5:3u", 0.8);
        check(
            s.screenRows().some((r) => r.includes("LUAWIDGET")),
            "a press+release pair toggles once, not twice",
            s.screenRows(),
        );
        await s.send("\x1b[103;5u", 0.8);
        check(s.committed() === committedBefore, "hiding the widget left the transcript where it was");
    });
}

/**
 * A Lua dock takes rows from the transcript, and leaves nothing behind on exit.
 *
 * The exit half is the point. The pinned frame is rendered one last time
 * WITHOUT a viewport on the way out, and that render is what lands in the
 * user's scrollback — a panel still mounted would print a band of dead rows
 * under the conversation, permanently.
 */
async function testLuaDock(): Promise<void> {
    const repo = (await Bun.$`mktemp -d ${join(require("node:os").tmpdir(), "loop-gitrepo-XXXXXX")}`.text()).trim();
    await Bun.$`git init -q && git config user.email t@t && git config user.name t && echo one > a.txt && git add . && git commit -qm init && echo two >> a.txt`
        .cwd(repo)
        .quiet();
    await withSession({ settings: NOIR, cwd: repo }, async (s) => {
        withLua(
            s,
            "git.lua",
            `
local P = { size = 6, lines = {} }

function P:refresh()
  local _, status = loop.run("git", { args = { "status", "--short" } })
  local out = {}
  for line in status:gmatch("[^%c]+") do out[#out + 1] = line end
  self.lines = out
  loop.redraw()
end

function P:render(width)
  local rows = { "DOCKMARK git " .. string.rep("-", math.max(0, width - 14)) }
  for i = 1, #self.lines do rows[#rows + 1] = "  " .. self.lines[i] end
  return rows
end

DOCK = nil
loop.keymap.set("ctrl+g", function()
  if DOCK then DOCK:close(); DOCK = nil
  else P:refresh(); DOCK = loop.dock.open(P) end
end)
`,
        );
        await s.pump(8);
        const committedBefore = s.committed();
        await s.send("\x07", 0);
        await s.pump(2);
        const rows = s.screenRows();
        check(
            rows.some((r) => r.includes("DOCKMARK")),
            "the Lua dock is on screen",
            rows,
        );
        check(
            rows.some((r) => r.includes("a.txt")),
            "the dock shows real git output",
            rows,
        );

        // A dock reflows the frame; it must not push the transcript off the top.
        check(s.committed() === committedBefore, "opening a dock scrolled nothing off");

        // It sits below the input, where VS Code puts its panel.
        const dockRow = rowsWith(rows, "DOCKMARK")[0]!;
        const ruleRows = rows.map((r, i) => (r.trim().startsWith("─") ? i : -1)).filter((i) => i >= 0);
        check(
            ruleRows.some((i) => i < dockRow),
            "the dock is below the input box",
            [dockRow, ruleRows],
        );

        // Quit with the dock still open — the failure this test exists for.
        await s.send("\x03", 0);
        await s.send("\x03", 0);
        await s.pump(3);
        const after = [...s.historyRows(), ...s.screenRows()];
        check(
            !after.some((r) => r.includes("DOCKMARK")),
            "quitting with a dock open leaves no dead rows in the scrollback",
            after.filter((r) => r.includes("DOCKMARK")),
        );
    });
}

/**
 * A Lua widget implements its own dragging from raw mouse events.
 *
 * loop routes the event and nothing more: the grab offset, the new position
 * and the decision to consume are all script-side. The last check is the one
 * that keeps the terminal usable — a widget that declines an event must leave
 * the transcript's own text selection working.
 */
async function testLuaDrag(): Promise<void> {
    const sgr = (button: number, col: number, row: number, press = true) =>
        `\x1b[<${button};${col};${row}${press ? "M" : "m"}`;

    await withSession({ settings: NOIR, cols: 88, rows: 24 }, async (s) => {
        withLua(
            s,
            "drag.lua",
            `
local W = { row = 6, col = 8, width = 26, grab = nil }

function W:render(width)
  return {
    "+" .. string.rep("-", width - 2) .. "+",
    "|  DRAGME  drag me around  |",
    "+" .. string.rep("-", width - 2) .. "+",
  }
end

function W:on_mouse(ev)
  if ev.type == "press" then
    self.grab = { x = ev.x, y = ev.y }
    return true
  elseif ev.type == "drag" and self.grab then
    self.handle:set_pos(ev.screen_y - self.grab.y, ev.screen_x - self.grab.x)
    return true
  elseif ev.type == "release" then
    self.grab = nil
    return true
  end
  return false
end

loop.keymap.set("ctrl+g", function()
  if HANDLE then HANDLE:hide(); HANDLE = nil else HANDLE = loop.widget.show(W) end
end)
`,
        );
        await s.pump(8);
        check(s.mouseTrackingEnabled(), "the terminal is reporting mouse events");
        await s.send("\x07", 0);
        await s.pump(1.2);

        const find = (): [number, number] | null => {
            const rows = s.screenRows();
            for (let i = 0; i < rows.length; i++) {
                const at = rows[i]!.indexOf("DRAGME");
                if (at >= 0) return [i, at];
            }
            return null;
        };

        const start = find();
        check(start !== null, "the draggable widget is on screen");
        if (!start) return;
        const [row, col] = start;

        // Press inside the box, move the pointer, release. SGR is 1-based.
        await s.send(sgr(0, col + 2, row + 1), 0.4);
        await s.send(sgr(32, col + 2 + 20, row + 1 + 5), 0.4);
        await s.send(sgr(0, col + 2 + 20, row + 1 + 5, false), 0.6);

        const moved = find();
        check(moved !== null, "the widget is still on screen after the drag");
        if (!moved) return;
        const delta: [number, number] = [moved[0] - start[0], moved[1] - start[1]];
        // The script moves the box by the pointer's travel, so the widget must
        // land exactly where the pointer went — not merely somewhere else.
        check(delta[0] === 5 && delta[1] === 20, "the widget followed the pointer exactly", delta);

        // A click nowhere near the widget is declined, so the transcript's own
        // selection still runs — losing that would make the terminal feel broken.
        await s.send(sgr(0, 3, 2), 0.3);
        await s.send(sgr(32, 30, 2), 0.3);
        await s.send(sgr(0, 30, 2, false), 0.5);
        check(find()?.[0] === moved[0], "a click outside the widget does not move it", find());
    });
}

/**
 * A real shell in a docked panel, and the ways out of it.
 *
 * The escape route is the point. A panel that takes the keyboard must still
 * let its own toggle through, or the only way out is quitting loop — and
 * ctrl+c has to interrupt the command in the panel rather than ask loop to
 * exit.
 */
async function testLuaTerminal(): Promise<void> {
    await withSession({ settings: NOIR, cols: 92, rows: 26 }, async (s) => {
        withLua(
            s,
            "term.lua",
            `
local t = nil
local function toggle()
  if t and t:is_open() then t:close(); t = nil
  else t = loop.term.open({ size = 12, cmd = "/bin/sh" }) end
end
loop.keymap.set("ctrl+/", toggle)
loop.keymap.set("ctrl+-", toggle)
`,
        );
        await s.pump(8);
        check(
            !s.screenRows().some((r) => r.includes("TERMMARK")),
            "no shell before the panel is opened",
        );

        await s.send("\x1b[47;5u", 3.0); // ctrl+/ (kitty encoding)
        let rows = s.screenRows();
        check(
            rows.some((r) => r.includes("terminal —")),
            "the terminal panel opened",
            rows,
        );

        // Below the input box, where VS Code puts its panel.
        const header = rowsWith(rows, "terminal —")[0]!;
        const rules = rows.map((r, i) => (r.trim().startsWith("─────") ? i : -1)).filter((i) => i >= 0);
        check(
            rules.some((i) => i < header),
            "the panel is below the input",
            [header, rules],
        );

        await s.send("echo TERMMARK\n", 2.0);
        check(
            s.screenRows().some((r) => r.includes("TERMMARK")),
            "the shell ran a command",
            s.screenRows(),
        );

        // A terminal with no visible cursor is unusable: the panel draws its own
        // block, because loop's hardware cursor is opt-in. It must sit inside the
        // panel, on the line being typed.
        await s.send("partial-line", 1.5);
        rows = s.screenRows();
        const headerRow = rowsWith(rows, "terminal —")[0]!;
        const cursors = s.inverseCells();
        const inPanel = cursors.filter(([y]) => y > headerRow);
        check(inPanel.length === 1, "exactly one block cursor is drawn inside the panel", cursors);
        const typed = rowsWith(rows, "partial-line")[0];
        check(
            typed !== undefined && inPanel.length > 0 && inPanel[0]![0] === typed,
            "the cursor sits on the line being typed",
            [typed, inPanel],
        );

        // ctrl+c must interrupt the child, not start loop's quit ritual.
        await s.send("sleep 30\n", 1.0);
        await s.send("\x03", 1.5);
        await s.send("echo AFTERINT\n", 2.0);
        rows = s.screenRows();
        check(
            !rows.some((r) => r.includes("Ctrl+C again")),
            "ctrl+c did not ask loop to quit",
            rows,
        );
        check(
            rows.some((r) => r.includes("AFTERINT")),
            "the shell survived ctrl+c",
            rows,
        );

        // The toggle still works while the panel holds the keyboard: the way out.
        await s.send("\x1b[47;5u", 2.0);
        check(
            !s.screenRows().some((r) => r.includes("terminal —")),
            "ctrl+/ closed it again",
        );
        await s.send("back in the editor", 1.0);
        check(
            s.screenRows().some((r) => r.includes("back in the editor")),
            "the prompt has the keyboard back",
            s.screenRows(),
        );
    });
}

/**
 * A slash command written in Lua: listed, completed, and actually run.
 *
 * Unit tests mock the extension API, and a mock accepts any event name — so
 * the handler emitting an event the CLI does not implement looked fine
 * everywhere except a real session, where the command ran and printed nothing.
 * Only a real terminal catches that, hence this.
 */
async function testLuaCommand(): Promise<void> {
    await withSession({ settings: NOIR, cols: 92, rows: 26 }, async (s) => {
        withLua(
            s,
            "cmds.lua",
            `
loop.cmd.register({
  name = "greet",
  description = "say hello to someone",
  handler = function(args)
    if args == "" then return "usage: /greet <name>" end
    return "hello, " .. args .. "!"
  end,
})
`,
        );
        await s.pump(8);

        // Registered at startup — no /reload needed for the command to exist.
        await s.send("/gre", 1.2);
        check(
            s.screenRows().some((r) => r.includes("say hello to someone")),
            "the Lua command is in the completion list at startup",
            s.screenRows(),
        );
        for (let i = 0; i < 4; i++) await s.send("\x7f", 0.15);

        // And it RUNS, with its argument, printing into the chat.
        await s.send("/greet shekhar", 0.8);
        await s.send("\r", 2.0);
        check(
            s.screenRows().some((r) => r.includes("hello, shekhar!")),
            "the Lua command ran and printed its result",
            s.screenRows(),
        );

        // An empty argument reaches the handler as "", not nil.
        await s.send("/greet", 0.8);
        await s.send("\r", 2.0);
        check(
            s.screenRows().some((r) => r.includes("usage: /greet <name>")),
            "the handler sees an empty argument string",
            s.screenRows(),
        );
    });
}

/**
 * A full-screen, keyboard-capturing widget — the shape a game needs.
 *
 * Three things have to hold together: the widget can size itself to the whole
 * terminal (render is told its width but never its height, so it asks), it
 * receives raw keys rather than the prompt, and a key it handles itself can
 * close it and hand the keyboard back.
 */
async function testLuaFullscreen(): Promise<void> {
    await withSession({ settings: NOIR, cols: 80, rows: 24 }, async (s) => {
        withLua(
            s,
            "full.lua",
            `
local G = { non_capturing = false, width = "100%", max_height = "100%", row = 0, col = 0, n = 0 }
local handle = nil

function G:render(width)
  local scr = loop.screen()
  local out = {}
  for y = 1, scr.rows do
    if y == 1 then out[y] = "FULLSCREEN " .. scr.rows .. "x" .. width .. string.rep(".", width - 20)
    elseif y == 2 then out[y] = "PRESSED " .. self.n .. string.rep(".", width - 12)
    else out[y] = string.rep(".", width) end
  end
  return out
end

function G:on_key(data)
  if data == "\\27" then handle:hide(); handle = nil; return true end
  self.n = self.n + 1
  loop.redraw()
  return true
end

loop.cmd.register({ name = "full", description = "full screen test",
  handler = function() handle = loop.widget.show(G); handle:focus(); return "opened" end })
`,
        );
        await s.pump(8);
        await s.send("/full", 0.8);
        await s.send("\r", 2.0);
        const rows = s.screenRows();
        const banner = rows.find((r) => r.includes("FULLSCREEN"));
        check(banner !== undefined, "the full-screen widget opened", rows);

        // It sized itself to the real terminal, and covered it.
        check((banner ?? "").includes("24x80"), "the widget knows the terminal size", banner);
        const filled = rows.filter((r) => r.trim() !== "" && r.trim().replace(/^\.+|\.+$/g, "") === "");
        check(filled.length >= 20, "it covers the screen", filled.length);

        // Keys reach the widget, not the prompt.
        await s.send("wasd", 1.2);
        check(
            s.screenRows().some((r) => r.includes("PRESSED 4")),
            "raw keys reach the widget instead of the editor",
            s.screenRows(),
        );

        // Esc is the widget's own key: it closes and returns the keyboard.
        await s.send("\x1b", 1.5);
        check(
            !s.screenRows().some((r) => r.includes("FULLSCREEN")),
            "esc closed it",
        );
        await s.send("back at the prompt", 1.0);
        check(
            s.screenRows().some((r) => r.includes("back at the prompt")),
            "the prompt has the keyboard back",
            s.screenRows(),
        );
    });
}

/** Recipes are discovered live; their input prompts can be cancelled cleanly. */
async function testRecipes(): Promise<void> {
    await withSession({ settings: NOIR }, async (s) => {
        s.writeHome(
            ".loop/recipes/endpoint.md",
            "# Endpoint workflow\n\nCreate {{resource}} and run the endpoint tests.\n",
        );
        const path = join(s.home, ".loop", "recipes", "endpoint.md");
        await s.pump(7);
        await s.send("/recipe list\r", 1.5);
        check(
            s.screenRows().some((r) => r.includes("/recipe endpoint")),
            "recipe file is listed",
            s.screenRows(),
        );
        await s.send("/recipe show endpoint\r", 1.5);
        check(
            s.screenRows().some((r) => r.includes("Endpoint workflow")),
            "recipe Markdown is visible",
            s.screenRows(),
        );
        await s.send("/recipe endpoint\r", 1.5);
        check(
            s.screenRows().some((r) => r.includes("resource (blank/Esc cancels)")),
            "missing input opens a prompt",
            s.screenRows(),
        );
        await s.send("\x1b", 1.0);
        check(
            s.screenRows().some((r) => r.includes("Recipe cancelled")),
            "Esc cancels without running",
            s.screenRows(),
        );
        await s.send("/recipe\r", 1.5);
        check(
            s.screenRows().some((r) => r.includes("choose a workflow")),
            "recipe picker opens after cancellation",
            s.screenRows(),
        );
        await s.send("\x1b", 1.0);
        await s.send("/recipe rm endpoint\r", 1.0);
        await s.send("\r", 1.0);
        check(existsSync(path), "delete defaults to keeping the recipe");
    });
}

/** A local model fixture drives extraction, review and the destination pickers. */
async function testHandoff(): Promise<void> {
    const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
            await req.arrayBuffer();
            return Response.json({
                id: "msg_fixture",
                type: "message",
                role: "assistant",
                model: "fixture",
                content: [
                    {
                        type: "text",
                        text: "## Objective\nFix endpoint validation.\n\n## Next steps\nRun the regression tests.",
                    },
                ],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 20, output_tokens: 15 },
            });
        },
    });
    try {
        const settings = JSON.stringify({ theme: "night", defaultModel: "custom:fixture/fixture" });
        await withSession({ settings, envExtra: { LOOP_SKIP_VERSION_CHECK: "1" } }, async (s) => {
            s.writeHome(
                ".loop/auth.json",
                JSON.stringify({
                    active: "custom:fixture",
                    customProviders: {
                        fixture: {
                            name: "fixture",
                            sdk: "anthropic",
                            baseURL: `http://127.0.0.1:${server.port}/v1`,
                            apiKey: "fixture",
                            auth: { kind: "apikey", apiKey: "fixture" },
                            models: [{ id: "fixture", contextWindow: 100000, maxOutput: 4096 }],
                        },
                    },
                }),
            );
            s.writeHome(
                "source.jsonl",
                JSON.stringify({
                    type: "message",
                    role: "user",
                    content: "Fix endpoint validation; tests remain to run.",
                    ts: 1,
                }) + "\n",
            );
            const transcript = join(s.home, "source.jsonl");
            await s.pump(7);
            await s.send(`/import ${transcript}\r`, 1.5);
            await s.send("/handoff validation\r", 3.0);
            check(
                s.screenRows().some((r) => r.includes("Review handoff")),
                "generated brief reaches the review menu",
                s.screenRows(),
            );
            await s.send("\r", 1.5);
            check(
                s.screenRows().some((r) => r.includes("Handoff model")),
                "destination model picker opens",
                s.screenRows(),
            );
            await s.send("\r", 1.0);
            check(
                s.screenRows().some((r) => r.includes("Handoff agent")),
                "destination agent picker opens",
                s.screenRows(),
            );
            await s.send("\r", 1.5);
            const rows = s.screenRows();
            check(
                rows.some((r) => r.includes("Handoff opened:")),
                "fresh session opens",
                rows,
            );
            check(
                rows.some((r) => r.includes("Original session:")),
                "source session reference is visible",
                rows,
            );
            check(
                rows.some((r) => r.includes("Ready for your next prompt")),
                "opening waits for the user's next prompt",
                rows,
            );
        });
    } finally {
        await server.stop(true);
    }
}

/**
 * The two surfaces an MCP server's resources and prompts reach the USER
 * through: `@mcp:` in the composer and `/mcp:<server>:<prompt>` in the command
 * list. Both are built from a live server's catalog, so neither can be tested
 * without actually connecting one.
 */
async function testMcpSurfaces(): Promise<void> {
    await withSession({ settings: mcpSettings(), cols: 100, rows: 30 }, async (s) => {
        // Servers connect in the background; the banner is the signal.
        await s.pump(10);

        // A prompt the server published is a real slash command, with the
        // server's own description on it.
        await s.send("/mcp:feat:", 1.5);
        check(
            s.screenRows().some((r) => r.includes("mcp:feat:review")),
            "a server prompt appears as a slash command",
            s.screenRows(),
        );
        check(
            s.screenRows().some((r) => r.includes("Review a diff")),
            "the command carries the server's description",
            s.screenRows(),
        );
        for (let i = 0; i < 10; i++) await s.send("\x7f", 0.05);
        await s.pump(0.5);

        // Resources complete in the composer. A bare `@` is still file-only —
        // that is what the `mcp:` prefix is for.
        await s.send("@mcp:", 1.5);
        const rows = s.screenRows();
        check(
            rows.some((r) => r.includes("feat:notes://standup")),
            "@mcp: completes a server resource",
            rows,
        );
        check(
            rows.some((r) => r.includes("Today's standup notes")),
            "the resource's description is shown",
            rows,
        );
        for (let i = 0; i < 5; i++) await s.send("\x7f", 0.05);
        await s.pump(0.5);

        // Opening either list must not have cost the frame anything.
        check(!hasDuplicates(s, "mcp:feat"), "the completion list printed nothing twice");
    });
}

/** The /mcp panel counts what a server actually contributes, not just tools. */
async function testMcpPanel(): Promise<void> {
    await withSession({ settings: mcpSettings(), cols: 100, rows: 30 }, async (s) => {
        await s.pump(10);
        await s.send("/mcp", 0.6);
        await s.send("\r", 3.0);
        const rows = s.screenRows();
        check(
            rows.some((r) => r.includes("feat")),
            "the server is listed in the panel",
            rows,
        );
        check(
            rows.some((r) => r.includes("resources") && r.includes("prompts")),
            "the row counts resources and prompts, not only tools",
            rows,
        );
        await s.send("\x1b", 1.0);
        check(
            s.screenRows().some((r) => r.includes("agent default (shift+tab)")),
            "esc closed the panel and gave the prompt back",
            s.screenRows(),
        );
    });
}


/** A reply the fixture model streams back, in Anthropic's event stream. */
function streamedReply(text: string): Response {
    const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const body =
        sse("message_start", {
            type: "message_start",
            message: {
                id: "msg_fixture",
                type: "message",
                role: "assistant",
                model: "fixture",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 20, output_tokens: 0 },
            },
        }) +
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
        sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 15 },
        }) +
        sse("message_stop", { type: "message_stop" });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * A session wired to a local model fixture that answers every request with
 * `respond()`, with one prompt already sent. A turn STREAMS, so a successful
 * fixture has to speak Anthropic's event stream (see streamedReply).
 */
async function withFixtureModel(respond: () => Response, body: (s: Session) => Promise<void>): Promise<void> {
    const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
            await req.arrayBuffer();
            return respond();
        },
    });
    try {
        const settings = JSON.stringify({ theme: "night", defaultModel: "custom:fixture/fixture" });
        await withSession({ settings, envExtra: { LOOP_SKIP_VERSION_CHECK: "1" } }, async (s) => {
            s.writeHome(
                ".loop/auth.json",
                JSON.stringify({
                    active: "custom:fixture",
                    customProviders: {
                        fixture: {
                            name: "fixture",
                            sdk: "anthropic",
                            baseURL: `http://127.0.0.1:${server.port}/v1`,
                            apiKey: "fixture",
                            auth: { kind: "apikey", apiKey: "fixture" },
                            models: [{ id: "fixture", contextWindow: 100000, maxOutput: 4096 }],
                        },
                    },
                }),
            );
            await s.pump(7);
            await s.send("does validation run before the write?\r", 4.0);
            await body(s);
        });
    } finally {
        server.stop(true);
    }
}

/** A conversation with one prompt and one reply — both selectable. */
function withConversation(body: (s: Session) => Promise<void>): Promise<void> {
    return withFixtureModel(() => streamedReply("Checked it. The validation runs before the write."), body);
}

/**
 * A turn the model fails closes with ONE line saying so — grok's TurnFailed.
 * It used to print `error: …` and then "Turn completed in 0s." under it, and
 * an error raised mid-turn was appended below the turn, so the rest of the
 * turn streamed in above it and the error stuck to the bottom of the screen.
 */
async function testTurnFailed(): Promise<void> {
    const failure = () =>
        Response.json(
            { type: "error", error: { type: "invalid_request_error", message: "fixture says no" } },
            { status: 400 },
        );
    await withFixtureModel(failure, async (s) => {
        const text = s.screenRows().join("\n");
        check(text.includes("Turn failed in"), "the turn closes as failed", s.screenRows());
        check(text.includes("fixture says no"), "and says why", s.screenRows());
        check(!text.includes("Turn completed"), "and never claims it completed", s.screenRows());
        const failed = s.screenRows().findIndex((r) => r.includes("Turn failed in"));
        const asked = s.screenRows().findIndex((r) => r.includes("does validation run before the write?"));
        check(asked >= 0 && failed > asked, "under the prompt it failed on", s.screenRows());
    });
}

/**
 * Navigation is FOCUS and nothing else.
 *
 * The transcript used to swap itself for a windowed viewport when it took the
 * keyboard: the same conversation re-laid-out around you, rows regrouping, the
 * page jumping — a second mode wearing the first one's clothes. Now the only
 * thing ctrl+e changes is who the arrows belong to, which is what these checks
 * are: the conversation must not move, and leaving must put the frame back
 * exactly as it was.
 */
async function testNavigationIsFocusOnly(): Promise<void> {
    await withConversation(async (s) => {
        const before = s.screenRows();
        const committedBefore = s.committed();
        check(
            before.some((r) => r.includes("validation runs before the write")),
            "the reply is on screen",
            before,
        );

        await s.send("\x05", 1.5); // ctrl+e
        const inNav = s.screenRows();
        check(
            inNav.some((r) => r.includes("▌")),
            "entering navigation marks an entry",
            inNav,
        );
        check(s.committed() === committedBefore, "and commits nothing to the terminal");
        // The conversation itself is untouched — the bar takes a column of the
        // selected entry and the hint replaces the status rows; nothing else
        // may differ, and in particular nothing may move.
        const text = (rows: string[]) => rows.map((r) => r.replace(/▌/g, " ").trimEnd());
        const movedRows = text(before).filter((line, i) => line.trim() && line !== text(inNav)[i]);
        check(movedRows.length <= 2, "and leaves the conversation exactly where it was", movedRows);

        await s.send("\x1b", 1.5); // esc
        const after = s.screenRows();
        check(
            !after.some((r) => r.includes("▌")),
            "leaving takes the mark with it",
            after,
        );
        check(after.join("\n") === before.join("\n"), "and puts the frame back as it was", {
            before: before.slice(-8),
            after: after.slice(-8),
        });
    });
}

/**
 * Inside navigation a click selects the entry under the pointer. Outside it a
 * click is the terminal's business and must not move focus or selection —
 * ctrl+e is the one way in.
 */
async function testClickSelectsAnEntry(): Promise<void> {
    await withConversation(async (s) => {
        const rows = s.screenRows();
        const target = rows.findIndex((r) => r.includes("validation runs before the write"));
        check(target > 0, "there is a reply to click on", rows);
        // SGR press + release on the same cell (one-based): a click, not a drag.
        const y = target + 1;

        await s.send(`\x1b[<0;6;${y}M`, 0.3);
        await s.send(`\x1b[<0;6;${y}m`, 1.2);
        check(
            !s.screenRows().some((r) => r.includes("▌")),
            "a click while typing selects nothing",
            s.screenRows(),
        );

        await s.send("\x05", 1.2); // ctrl+e — now clicks mean something
        await s.send(`\x1b[<0;6;${y}M`, 0.3);
        await s.send(`\x1b[<0;6;${y}m`, 1.2);
        const clicked = s.screenRows();
        check(
            clicked.some((r) => r.includes("▌") && r.includes("validation runs before the write")),
            "the clicked entry is the selected one",
            clicked,
        );

        await s.send("\x1b", 1.2);
        check(
            !s.screenRows().some((r) => r.includes("▌")),
            "and Esc hands the keyboard back",
        );
    });
}

const SCENARIOS: Record<string, () => Promise<void>> = {
    handoff: testHandoff,
    recipes: testRecipes,
    boot: testBoot,
    growth: testNoDuplicatesWhileGrowing,
    completion: testCompletionListCostsNothing,
    selector: testSelectorCostsNothing,
    "menu-anchor": testMenuAnchorsToTheFrameNotTheScreen,
    "menu-scrolled": testMenuFollowsThePromptWhenScrolled,
    "wheel-tail": testWheelTailYieldsToTyping,
    wheel: testWheelScrollsTheDocument,
    pinned: testPinnedInput,
    new: testNewSession,
    clear: testClearScreen,
    resize: testResize,
    "alt-screen": testAltScreenKeepsScrollbackClean,
    shells: testShellsPanel,
    "shells-esc": testShellsSurviveEsc,
    "lua-widget": testLuaWidget,
    "lua-dock": testLuaDock,
    "lua-drag": testLuaDrag,
    "lua-terminal": testLuaTerminal,
    "mcp-surfaces": testMcpSurfaces,
    "mcp-panel": testMcpPanel,
    "lua-command": testLuaCommand,
    "lua-fullscreen": testLuaFullscreen,
    nav: testNavigationIsFocusOnly,
    "turn-failed": testTurnFailed,
    click: testClickSelectsAnEntry,
};

async function main(): Promise<number> {
    const wanted = Bun.argv.slice(2).length ? Bun.argv.slice(2) : Object.keys(SCENARIOS);
    for (const name of wanted) {
        const fn = SCENARIOS[name];
        if (!fn) {
            console.log(`unknown scenario: ${name} (have: ${Object.keys(SCENARIOS).join(", ")})`);
            return 2;
        }
        console.log(`\n== ${name} ==`);
        await fn();
    }
    console.log(`\n${checks - failures.length}/${checks} checks passed`);
    if (failures.length) {
        console.log("failed:");
        for (const f of failures) console.log(`  - ${f}`);
        return 1;
    }
    return 0;
}

process.exit(await main());
