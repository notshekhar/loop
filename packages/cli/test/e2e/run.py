#!/usr/bin/env python3
"""
End-to-end screen tests for the TUI.

The renderer's bugs do not show up in unit tests, because none of them are
about what a component renders — they are about where the terminal ends up
putting it. A conversation printed twice into the scrollback, a blank band
where a menu closed, /new leaving the previous session on screen: every one of
those is a correct frame, drawn wrong. The only way to catch them is to run
loop in a real pty and look at the screen.

Two invariants carry most of the weight:

  NOTHING IS EVER PRINTED TWICE. A line that has scrolled off is committed; the
  terminal cannot be made to move it, only to print it again. So a duplicate in
  the scrollback means the renderer tried to move history and made a copy.

  TRANSIENT UI COSTS THE FRAME NOTHING. Opening a menu or a completion list
  must not scroll the terminal, because the rows it scrolls off cannot come
  back when it closes — which is what leaves a band behind.

Run: python3 packages/cli/test/e2e/run.py [name ...]
"""

import sys
import os
import tempfile
import subprocess
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness import Session  # noqa: E402

NOIR = '{"uiMode": "noir"}'

failures = []
checks = 0


def check(cond, label, detail=""):
    global checks
    checks += 1
    if cond:
        print(f"    ok   {label}")
    else:
        print(f"    FAIL {label}")
        if detail:
            for line in str(detail).splitlines():
                print(f"         {line}")
        failures.append(label)


def duplicates(session, needle="filler "):
    """Lines printed more than once across scrollback + screen."""
    counts = {}
    for line in session.history_rows() + session.screen_rows():
        line = line.strip()
        if needle not in line:
            continue
        counts[line] = counts.get(line, 0) + 1
    return {line: n for line, n in counts.items() if n > 1}


def fill(session, n, settle=0.25):
    """A conversation taller than the screen, with identifiable lines."""
    for i in range(n):
        session.send(f"filler {i}\r", settle=settle)
    session.pump(0.8)


def blank_band(rows, size=3):
    """Index of a run of `size` blank rows, or -1 — the shape of a shrink gap."""
    for i in range(len(rows) - size + 1):
        if all(not rows[j].strip() for j in range(i, i + size)):
            return i
    return -1


# ---------------------------------------------------------------- scenarios


def test_boot():
    """The first screen: masthead, and a prompt block that is actually drawn."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        rows = s.screen_rows()
        check(any("Welcome back" in r for r in rows), "masthead is on screen")
        check(len(s.screen.history.top) == 0, "nothing scrolled off a fresh boot")
        check(any(r.strip().startswith("─") for r in rows), "the prompt block is on screen", rows)


def test_no_duplicates_while_growing():
    """A conversation past the fold is printed once, in order."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        dupes = duplicates(s)
        check(not dupes, "no line was printed twice while the transcript grew", dupes)
        printed = [r for r in s.history_rows() + s.screen_rows() if "filler " in r]
        order = [int(r.split("filler ")[1].split()[0]) for r in printed if r.split("filler ")[1].strip().isdigit()]
        check(order == sorted(order), "the transcript is in order", order[:40])


def test_completion_list_costs_nothing():
    """Typing `/` and deleting it must leave the screen exactly as it was."""
    for label, settings in (("noir", NOIR),):
        with Session(settings=settings) as s:
            s.pump(7)
            fill(s, 20)
            before = s.screen_rows()
            committed_before = len(s.screen.history.top)

            s.send("/", settle=1.6)
            open_rows = s.screen_rows()
            check(
                any("help" in r for r in open_rows),
                f"[{label}] the completion list is showing",
            )
            check(
                len(s.screen.history.top) == committed_before,
                f"[{label}] opening it scrolled nothing off",
                f"{len(s.screen.history.top) - committed_before} rows committed",
            )

            s.send("\x7f", settle=1.6)
            check(
                s.screen_rows() == before,
                f"[{label}] deleting it put the screen back exactly",
                "\n".join(f"{i:2}|{a!r} != {b!r}" for i, (a, b) in enumerate(zip(s.screen_rows(), before)) if a != b),
            )
            check(not duplicates(s), f"[{label}] and printed nothing twice", duplicates(s))


def test_selector_costs_nothing():
    """A menu opening and closing must not move the conversation."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 20)
        committed_before = len(s.screen.history.top)
        top_before = s.screen_rows()

        s.send("/settings\r", settle=3.0)
        rows = s.screen_rows()
        check(any("uiMode" in r for r in rows), "the settings menu is showing")
        # Running the command appends its own echo to the transcript ("/settings"
        # plus a blank), and on a full screen those two rows legitimately scroll
        # off. The MENU must cost nothing on top of that: inline it was fifteen
        # rows tall, and all fifteen came out of the top of the screen.
        echo_rows = 2
        committed = len(s.screen.history.top) - committed_before
        check(
            committed <= echo_rows,
            "the menu itself scrolled nothing off — only the command's echo",
            f"{committed} rows committed, at most {echo_rows} expected",
        )
        # Scrolling by the echo means row N of the new screen is row N+echo of
        # the old one — the conversation moved by exactly that and no more.
        check(
            s.screen_rows()[:6] == top_before[echo_rows : echo_rows + 6],
            "the transcript above the menu moved by exactly that echo",
            f"{s.screen_rows()[:3]}\n{top_before[echo_rows : echo_rows + 3]}",
        )

        s.send("\x1b", settle=2.5)
        after = s.screen_rows()
        check(blank_band(after[:20]) == -1, "no blank band where the menu was", after[:20])
        check(not duplicates(s), "and nothing was printed twice", duplicates(s))


def test_new_session():
    """/new on a long conversation starts clean: banner back, old chat gone."""
    for label, settings in (("noir", NOIR),):
        with Session(settings=settings) as s:
            s.pump(7)
            fill(s, 30)
            s.send("/new\r", settle=3.5)
            rows = s.screen_rows()
            check(any("Welcome back" in r for r in rows), f"[{label}] /new shows the masthead again", rows[:12])
            check(
                not any("filler " in r for r in rows),
                f"[{label}] /new leaves none of the old conversation on screen",
                [r for r in rows if "filler " in r][:5],
            )


def test_clear_screen():
    """/clear wipes the screen and starts the session's header again."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        s.send("/clear\r", settle=3.0)
        rows = s.screen_rows()
        check(any("Welcome back" in r for r in rows), "/clear shows the masthead again", rows[:12])
        check(not any("filler " in r for r in rows), "/clear leaves no old conversation on screen")


def test_shells_panel():
    """A background shell appears in the pinned panel without disturbing the
    conversation above it — and killing it does not strand a band."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 20)
        committed_before = len(s.screen.history.top)

        s.send("/shells run sleep 30\r", settle=2.0)
        rows = s.screen_rows()
        check(any("bash_1" in r for r in rows), "the shell shows up on screen", rows[-12:])
        check(not duplicates(s), "starting one printed nothing twice", duplicates(s))
        printed = [r for r in s.history_rows() + s.screen_rows() if "filler " in r]
        order = [int(r.split("filler ")[1].split()[0]) for r in printed if r.split("filler ")[1].strip().isdigit()]
        check(order == sorted(order), "the conversation above it is intact and in order", order[:40])

        # The panel grew the frame; growth is safe, but the rows it pushed off
        # must be exactly as many as it added, never a duplicated stretch.
        s.send("/shells\r", settle=1.5)
        check(any("bash_1" in r for r in s.screen_rows()), "/shells lists it")
        check(not duplicates(s), "listing printed nothing twice", duplicates(s))

        s.send("/shells kill all\r", settle=2.0)
        rows = s.screen_rows()
        check(any("Killed" in r for r in rows), "killing it is reported", rows[-12:])
        check(not duplicates(s), "killing printed nothing twice", duplicates(s))
        check(blank_band(s.screen_rows()) == -1, "no blank band was left behind", s.screen_rows())
        check(
            len(s.screen.history.top) >= committed_before,
            "history only ever grew",
        )


def test_shells_survive_esc():
    """esc ends a turn; it must not take a background shell with it."""
    with Session(settings=NOIR) as s:
        s.pump(7)
        s.send("/shells run sleep 30\r", settle=2.0)
        s.send("\x1b", settle=0.6)
        s.send("\x1b", settle=0.6)
        s.send("/shells\r", settle=1.5)
        rows = s.screen_rows()
        check(any("running" in r for r in rows), "the shell is still running after esc", rows[-14:])
        s.send("/shells kill all\r", settle=1.5)


def test_resize():
    """A resize re-wraps without losing or duplicating the conversation."""
    import fcntl, struct, termios, signal  # noqa: E401

    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 20)
        fcntl.ioctl(s.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 90, 0, 0))
        os.kill(s.pid, signal.SIGWINCH)
        s.screen.resize(24, 90)
        s.rows, s.cols = 24, 90
        s.pump(2.5)
        rows = s.screen_rows()
        check(len(rows) == 24, "the frame follows the new height")
        check(any(r.strip() for r in rows), "the screen is not blank after a resize", rows)



def test_alt_screen_keeps_scrollback_clean():
    """The chat is on the alternate screen: nothing is committed while it runs.

    This is the property the alt screen was adopted for. Committed rows were
    the source of the duplicated chat, the blank bands and the stranded frames,
    because a row that has scrolled off can only be reprinted, never moved. On
    the alternate screen there are no committed rows at all — and the
    conversation is not lost either, because leaving the screen prints it once,
    whole, into the terminal.
    """
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 40)
        check(
            len(s.screen.history.top) == 0,
            "40 messages committed nothing to the terminal's scrollback",
            len(s.screen.history.top),
        )
        check(
            any(r.strip().startswith("\u2500") for r in s.screen_rows()),
            "the prompt is still drawn after a long conversation",
        )

        s.send("\x03", settle=0.4)
        s.send("\x03", settle=2.5)
        s.pump(2.0)
        left = [
            "".join(c.data for c in line.values()).rstrip() for line in s.screen.history.top
        ] + s.screen_rows()
        check(
            any("Welcome back" in r for r in left),
            "quitting prints the transcript into the terminal instead of losing it",
        )



def test_menu_anchors_to_the_frame_not_the_screen():
    """A menu on a SHORT conversation must not cover the editor's status rows.

    Overlays are anchored to where the frame's content ends, not to the bottom
    of the terminal. Those are the same row once the conversation fills the
    screen, and differ by one while it does not — so this only reproduces on a
    short transcript, which is why the other selector scenario (20 messages,
    frame already full) cannot see it. The alt-screen move first reported the
    padded viewport height as the content height and landed every menu one row
    low, over the "agent … (shift+tab)" line.
    """
    for label, keys in (("settings", "/settings\r"), ("completion", "/")):
        with Session(settings=NOIR) as s:
            s.pump(7)
            fill(s, 2)  # deliberately short: the frame must not fill the screen
            s.send(keys, settle=2.5)
            rows = s.screen_rows()
            check(
                any("shift+tab" in r for r in rows),
                f"[{label}] the menu left the editor's status rows visible",
                rows[-5:],
            )
            check(
                any("session" in r and "ctx" in r for r in rows),
                f"[{label}] and the session line below them too",
                rows[-3:],
            )



def test_menu_follows_the_prompt_when_scrolled():
    """With pinning off, the prompt scrolls away with the transcript — and a
    menu belongs to the prompt, not to the screen.

    What broke: overlays anchored to `rows - contentHeight`, the document's
    length, which knows nothing about where the window onto it is. Scrolled
    back, the prompt was below the screen and `/` or `/settings` painted a
    menu floating over the transcript with no prompt under it.

    The contract now: a key brings the prompt back into view (a shell scrolls
    to the bottom on a keystroke), so a menu always opens ON the prompt; and
    wheeling away while one is open takes the menu along — it is hidden with
    the prompt and back when either the wheel or a key returns.
    """
    up, down = "\x1b[<64;20;10M", "\x1b[<65;20;10M"
    prompt_rows = lambda rows: [i for i, r in enumerate(rows) if "agent default (shift+tab)" in r]
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        for _ in range(3):
            s.send(up, settle=0.12)
        s.pump(0.6)
        check(not prompt_rows(s.screen_rows()), "scrolled back, the prompt is off the screen")

        s.send("/", settle=1.6)
        rows = s.screen_rows()
        at = prompt_rows(rows)
        check(bool(at), "typing brought the prompt back", rows[-4:])
        listing = [i for i, r in enumerate(rows) if "help" in r and "Show available commands" in r]
        check(
            bool(listing) and at and listing[0] < at[0],
            "and the completion list opened above it, not floating in the transcript",
            rows[-12:],
        )

        for _ in range(3):
            s.send(up, settle=0.12)
        s.pump(0.6)
        rows = s.screen_rows()
        check(not prompt_rows(rows), "wheeling away takes the prompt off again")
        check(
            not any("Show available commands" in r for r in rows),
            "and the completion list went with it instead of floating",
            rows[-12:],
        )
        for _ in range(6):
            s.send(down, settle=0.1)
        s.pump(0.6)
        rows = s.screen_rows()
        check(
            any("Show available commands" in r for r in rows) and bool(prompt_rows(rows)),
            "wheeling back shows both again",
            rows[-12:],
        )

        s.send("\x7f", settle=1.0)
        for _ in range(3):
            s.send(up, settle=0.12)
        s.pump(0.6)
        s.send("/settings\r", settle=2.5)
        rows = s.screen_rows()
        at = prompt_rows(rows)
        menu = [i for i, r in enumerate(rows) if "uiMode" in r]
        check(bool(menu) and bool(at) and menu[0] < at[0], "/settings opens on the prompt too", rows[-8:])


def test_wheel_tail_yields_to_typing():
    """A trackpad keeps sending wheel-up for a few hundred ms after the fingers
    lift. Scroll back, start typing: the first key jumps to the prompt, and the
    tail must NOT drag the view up again — that was the prompt and the
    completion list flickering, and the jump "only working on the second key".

    The wheel yields to a keyboard jump for a moment (extended while keys keep
    coming), and is back to normal once the typing stops.
    """
    up = "\x1b[<64;20;10M"
    prompt_rows = lambda rows: [i for i, r in enumerate(rows) if "agent default (shift+tab)" in r]
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        for _ in range(4):  # the flick
            s.send(up, settle=0.03)
        s.send("h", settle=0.05)
        check(bool(prompt_rows(s.screen_rows())), "the FIRST key brings the prompt back", s.screen_rows()[-4:])
        # The tail keeps coming while the user types on. (pump() polls at 50 ms,
        # so each "60 ms" here can run to ~110; keys are interleaved densely,
        # the way typing actually is, rather than after a long silent tail.)
        for ch in "ey":
            for _ in range(2):
                s.send(up, settle=0.06)
            s.send(ch, settle=0.05)
        for _ in range(2):
            s.send(up, settle=0.06)
        s.pump(0.3)
        rows = s.screen_rows()
        check(bool(prompt_rows(rows)), "the tail did not drag the prompt away again", rows[-4:])
        check(any(r.strip() == "hey" for r in rows), "and what was typed is on it", rows[-6:])

        s.pump(0.6)  # the hold has lapsed
        for _ in range(3):
            s.send(up, settle=0.12)
        s.pump(0.5)
        check(not prompt_rows(s.screen_rows()), "a real scroll afterwards still works")


def test_wheel_scrolls_the_document():
    """The wheel scrolls the conversation, the way the terminal's own
    scrollback would — and the prompt goes with it, because it is part of
    the same document, exactly as it is when a shell command's output is
    scrolled back over.

    On the alternate screen there is no terminal scrollback, so the wheel has
    to reach loop or there is no scrolling at all. What broke it: loop's
    Terminal.start() cleanses stale modes (`?1000l ?1006l`) AFTER the alt
    screen asks for mouse tracking, switching it straight back off.
    """
    up, down = "\x1b[<64;20;10M", "\x1b[<65;20;10M"
    with Session(settings=NOIR) as s:
        s.pump(7)
        fill(s, 30)
        rest = s.screen_rows()
        check(any("shift+tab" in r for r in rest[-5:]), "the prompt is drawn at rest")

        for _ in range(6):
            s.send(up, settle=0.12)
        s.pump(0.8)
        scrolled = s.screen_rows()
        check(rest[:6] != scrolled[:6], "the wheel scrolled the conversation", scrolled[:3])
        check(len(s.screen.history.top) == 0, "scrolling committed nothing to the terminal")
        # A real terminal only SENDS wheel reports to an app that asked for
        # them, and this harness sends them regardless — so the request itself
        # has to be asserted, or the cleanse switching mouse tracking back off
        # after startup goes unnoticed here.
        check(
            s.mouse_tracking_enabled(),
            "loop still has mouse tracking on after startup",
        )

        for _ in range(12):
            s.send(down, settle=0.1)
        s.pump(0.8)
        check(s.screen_rows() == rest, "scrolling back down returns to the live end")


def test_pinned_input():
    """`pinnedInput`: the prompt is held on the last rows from the first frame,
    the wheel scrolls only the transcript above it, and quitting still prints
    the whole conversation.

    The last point is the one that bit: the pinned frame is a VStack, and the
    exit path renders it WITHOUT a viewport, where a `basis: 0` transcript is
    zero rows — the conversation was gone from the terminal on quit.
    """
    up, down = "\x1b[<64;20;10M", "\x1b[<65;20;10M"
    # The status line under the editor, not the masthead's "shift+tab agents" hint.
    prompt_rows = lambda rows: [i for i, r in enumerate(rows) if "agent default (shift+tab)" in r]
    with Session(settings='{"uiMode": "noir", "pinnedInput": true}') as s:
        s.pump(7)
        boot = s.screen_rows()
        check(any("Welcome back" in r for r in boot), "masthead is on screen")
        at_boot = prompt_rows(boot)
        check(at_boot and at_boot[-1] >= len(boot) - 4, "the prompt is on the last rows from the start", at_boot)

        fill(s, 30)
        rest = s.screen_rows()
        for _ in range(6):
            s.send(up, settle=0.12)
        s.pump(0.8)
        scrolled = s.screen_rows()
        check(rest[:6] != scrolled[:6], "the wheel scrolled the transcript", scrolled[:3])
        check(prompt_rows(scrolled) == prompt_rows(rest), "and the prompt stayed put while it did")
        check(len(s.screen.history.top) == 0, "scrolling committed nothing to the terminal")
        for _ in range(12):
            s.send(down, settle=0.1)
        s.pump(0.8)
        check(s.screen_rows() == rest, "scrolling back down returns to the live end")

        s.send("\x03", settle=0.4)
        s.send("\x03", settle=2.5)
        s.pump(2.0)
        left = [
            "".join(c.data for c in line.values()).rstrip() for line in s.screen.history.top
        ] + s.screen_rows()
        check(any("Welcome back" in r for r in left), "quitting prints the whole transcript, masthead included")


def test_lua_widget():
    """A Lua script draws a widget and a Lua keymap summons it.

    This is the only test that proves the whole chain in a real terminal: the
    embedded wasm boots, ~/.loop/lua auto-loads with no install step, a Lua
    table satisfies the TUI's component contract, and a Lua-registered key
    binding reaches the input listener ahead of the editor.
    """
    with Session(settings=NOIR) as s:
        # Written after Session() built HOME, before loop has read anything.
        os.makedirs(f"{s.home}/.loop/lua", exist_ok=True)
        with open(f"{s.home}/.loop/extensions.json", "w") as fh:
            fh.write('{"builtins": {"lua": true}}')
        with open(f"{s.home}/.loop/lua/init.lua", "w") as fh:
            fh.write(
                """
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

-- Placement lives on the widget table itself, so `self` inside render is W.
W.anchor, W.width, W.offset_y = "center", 40, -2

HANDLE = nil
loop.keymap.set("ctrl+g", function()
  if HANDLE then HANDLE:hide(); HANDLE = nil
  else HANDLE = loop.widget.show(W) end
end)
"""
            )
        s.pump(8)
        rows = s.screen_rows()
        check(not any("LUAWIDGET" in r for r in rows), "no widget before the key is pressed")

        committed_before = len(s.screen.history.top)
        s.send("\x07")  # ctrl+g
        s.pump(2)
        rows = s.screen_rows()
        check(any("LUAWIDGET" in r for r in rows), "the Lua widget is on screen after ctrl+g", rows)

        # A widget is transient UI: showing it must not scroll the transcript,
        # because rows pushed off cannot come back when it closes.
        check(
            len(s.screen.history.top) == committed_before,
            "showing a widget scrolled nothing off",
        )

        # It is centred, not simply appended at the bottom.
        widget_rows = [i for i, r in enumerate(rows) if "LUAWIDGET" in r]
        check(
            widget_rows and 2 <= widget_rows[0] <= len(rows) - 3,
            "the widget is placed away from the screen edges",
            widget_rows,
        )

        s.send("\x07")  # toggle it back off
        s.pump(2)
        check(not any("LUAWIDGET" in r for r in s.screen_rows()), "ctrl+g hides it again")

        # Kitty protocol reports press, repeat AND release for one keypress.
        # A binding that fires on all three toggles twice, so whatever it opens
        # is visible only while the key is held down. Press + release must
        # leave the widget shown. ('g' = 103, modifier 5 = ctrl, ":3" = release)
        s.send("\x1b[103;5u", settle=0.5)
        s.send("\x1b[103;5:3u", settle=0.8)
        check(
            any("LUAWIDGET" in r for r in s.screen_rows()),
            "a press+release pair toggles once, not twice",
            s.screen_rows(),
        )
        s.send("\x1b[103;5u", settle=0.8)
        check(
            len(s.screen.history.top) == committed_before,
            "hiding the widget left the transcript where it was",
        )


def test_lua_dock():
    """A Lua dock takes rows from the transcript, and leaves nothing behind on exit.

    The exit half is the point. The pinned frame is rendered one last time
    WITHOUT a viewport on the way out, and that render is what lands in the
    user's scrollback — a panel still mounted would print a band of dead rows
    under the conversation, permanently.
    """
    repo = tempfile.mkdtemp(prefix="loop-gitrepo-")
    subprocess.run(
        "git init -q && git config user.email t@t && git config user.name t && "
        "echo one > a.txt && git add . && git commit -qm init && echo two >> a.txt",
        shell=True,
        cwd=repo,
    )
    with Session(settings=NOIR, cwd=repo) as s:
        os.makedirs(f"{s.home}/.loop/lua", exist_ok=True)
        with open(f"{s.home}/.loop/extensions.json", "w") as fh:
            fh.write('{"builtins": {"lua": true}}')
        with open(f"{s.home}/.loop/lua/git.lua", "w") as fh:
            fh.write(
                """
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
"""
            )
        s.pump(8)
        committed_before = len(s.screen.history.top)
        s.send("\x07")
        s.pump(2)
        rows = s.screen_rows()
        check(any("DOCKMARK" in r for r in rows), "the Lua dock is on screen", rows)
        check(any("a.txt" in r for r in rows), "the dock shows real git output", rows)

        # A dock reflows the frame; it must not push the transcript off the top.
        check(
            len(s.screen.history.top) == committed_before,
            "opening a dock scrolled nothing off",
        )

        # It sits below the input, where VS Code puts its panel.
        dock_row = next(i for i, r in enumerate(rows) if "DOCKMARK" in r)
        rule_rows = [i for i, r in enumerate(rows) if r.strip().startswith("─")]
        check(
            any(i < dock_row for i in rule_rows),
            "the dock is below the input box",
            (dock_row, rule_rows),
        )

        # Quit with the dock still open — the failure this test exists for.
        s.send("\x03")
        s.send("\x03")
        s.pump(3)
        after = s.history_rows() + s.screen_rows()
        check(
            not any("DOCKMARK" in r for r in after),
            "quitting with a dock open leaves no dead rows in the scrollback",
            [r for r in after if "DOCKMARK" in r],
        )


def test_lua_drag():
    """A Lua widget implements its own dragging from raw mouse events.

    loop routes the event and nothing more: the grab offset, the new position
    and the decision to consume are all script-side. The last check is the one
    that keeps the terminal usable — a widget that declines an event must leave
    the transcript's own text selection working.
    """

    def sgr(button, col, row, press=True):
        return f"\x1b[<{button};{col};{row}{'M' if press else 'm'}"

    with Session(settings=NOIR, cols=88, rows=24) as s:
        os.makedirs(f"{s.home}/.loop/lua", exist_ok=True)
        with open(f"{s.home}/.loop/extensions.json", "w") as fh:
            fh.write('{"builtins": {"lua": true}}')
        with open(f"{s.home}/.loop/lua/drag.lua", "w") as fh:
            fh.write(
                """
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
"""
            )
        s.pump(8)
        check(s.mouse_tracking_enabled(), "the terminal is reporting mouse events")
        s.send("\x07")
        s.pump(1.2)

        def find():
            for i, r in enumerate(s.screen_rows()):
                if "DRAGME" in r:
                    return i, r.index("DRAGME")
            return None

        start = find()
        check(start is not None, "the draggable widget is on screen")
        row, col = start

        # Press inside the box, move the pointer, release. SGR is 1-based.
        s.send(sgr(0, col + 2, row + 1), settle=0.4)
        s.send(sgr(32, col + 2 + 20, row + 1 + 5), settle=0.4)
        s.send(sgr(0, col + 2 + 20, row + 1 + 5, press=False), settle=0.6)

        moved = find()
        check(moved is not None, "the widget is still on screen after the drag")
        delta = (moved[0] - start[0], moved[1] - start[1])
        # The script moves the box by the pointer's travel, so the widget must
        # land exactly where the pointer went — not merely somewhere else.
        check(delta == (5, 20), "the widget followed the pointer exactly", delta)

        # A click nowhere near the widget is declined, so the transcript's own
        # selection still runs — losing that would make the terminal feel broken.
        s.send(sgr(0, 3, 2), settle=0.3)
        s.send(sgr(32, 30, 2), settle=0.3)
        s.send(sgr(0, 30, 2, press=False), settle=0.5)
        check(find()[0] == moved[0], "a click outside the widget does not move it", find())


def test_lua_terminal():
    """A real shell in a docked panel, and the ways out of it.

    The escape route is the point. A panel that takes the keyboard must still
    let its own toggle through, or the only way out is quitting loop — and
    ctrl+c has to interrupt the command in the panel rather than ask loop to
    exit.
    """
    with Session(settings=NOIR, cols=92, rows=26) as s:
        os.makedirs(f"{s.home}/.loop/lua", exist_ok=True)
        with open(f"{s.home}/.loop/extensions.json", "w") as fh:
            fh.write('{"builtins": {"lua": true}}')
        with open(f"{s.home}/.loop/lua/term.lua", "w") as fh:
            fh.write(
                """
local t = nil
local function toggle()
  if t and t:is_open() then t:close(); t = nil
  else t = loop.term.open({ size = 12, cmd = "/bin/sh" }) end
end
loop.keymap.set("ctrl+/", toggle)
loop.keymap.set("ctrl+-", toggle)
"""
            )
        s.pump(8)
        check(not any("TERMMARK" in r for r in s.screen_rows()), "no shell before the panel is opened")

        s.send("\x1b[47;5u", settle=3.0)  # ctrl+/ (kitty encoding)
        rows = s.screen_rows()
        check(any("terminal —" in r for r in rows), "the terminal panel opened", rows)

        # Below the input box, where VS Code puts its panel.
        header = next(i for i, r in enumerate(rows) if "terminal —" in r)
        rules = [i for i, r in enumerate(rows) if r.strip().startswith("─────")]
        check(any(i < header for i in rules), "the panel is below the input", (header, rules))

        s.send("echo TERMMARK\n", settle=2.0)
        check(any("TERMMARK" in r for r in s.screen_rows()), "the shell ran a command", s.screen_rows())

        # A terminal with no visible cursor is unusable: the panel draws its own
        # block, because loop's hardware cursor is opt-in. It must sit inside the
        # panel, on the line being typed.
        s.send("partial-line", settle=1.5)
        rows = s.screen_rows()
        header_row = next(i for i, r in enumerate(rows) if "terminal \u2014" in r)
        cursors = [
            (y, x)
            for y in range(s.screen.lines)
            for x in range(s.screen.columns)
            if s.screen.buffer[y][x].reverse
        ]
        in_panel = [c for c in cursors if c[0] > header_row]
        check(len(in_panel) == 1, "exactly one block cursor is drawn inside the panel", cursors)
        typed = next((i for i, r in enumerate(rows) if "partial-line" in r), None)
        check(
            typed is not None and in_panel and in_panel[0][0] == typed,
            "the cursor sits on the line being typed",
            (typed, in_panel),
        )

        # ctrl+c must interrupt the child, not start loop's quit ritual.
        s.send("sleep 30\n", settle=1.0)
        s.send("\x03", settle=1.5)
        s.send("echo AFTERINT\n", settle=2.0)
        rows = s.screen_rows()
        check(not any("Ctrl+C again" in r for r in rows), "ctrl+c did not ask loop to quit", rows)
        check(any("AFTERINT" in r for r in rows), "the shell survived ctrl+c", rows)

        # The toggle still works while the panel holds the keyboard: the way out.
        s.send("\x1b[47;5u", settle=2.0)
        check(not any("terminal —" in r for r in s.screen_rows()), "ctrl+/ closed it again")
        s.send("back in the editor", settle=1.0)
        check(
            any("back in the editor" in r for r in s.screen_rows()),
            "the prompt has the keyboard back",
            s.screen_rows(),
        )


def test_lua_command():
    """A slash command written in Lua: listed, completed, and actually run.

    Unit tests mock the extension API, and a mock accepts any event name — so
    the handler emitting an event the CLI does not implement looked fine
    everywhere except a real session, where the command ran and printed nothing.
    Only a real terminal catches that, hence this.
    """
    with Session(settings=NOIR, cols=92, rows=26) as s:
        os.makedirs(f"{s.home}/.loop/lua", exist_ok=True)
        with open(f"{s.home}/.loop/extensions.json", "w") as fh:
            fh.write('{"builtins": {"lua": true}}')
        with open(f"{s.home}/.loop/lua/cmds.lua", "w") as fh:
            fh.write(
                """
loop.cmd.register({
  name = "greet",
  description = "say hello to someone",
  handler = function(args)
    if args == "" then return "usage: /greet <name>" end
    return "hello, " .. args .. "!"
  end,
})
"""
            )
        s.pump(8)

        # Registered at startup — no /reload needed for the command to exist.
        s.send("/gre", settle=1.2)
        check(
            any("say hello to someone" in r for r in s.screen_rows()),
            "the Lua command is in the completion list at startup",
            s.screen_rows(),
        )
        for _ in range(4):
            s.send("\x7f", settle=0.15)

        # And it RUNS, with its argument, printing into the chat.
        s.send("/greet shekhar", settle=0.8)
        s.send("\r", settle=2.0)
        check(
            any("hello, shekhar!" in r for r in s.screen_rows()),
            "the Lua command ran and printed its result",
            s.screen_rows(),
        )

        # An empty argument reaches the handler as "", not nil.
        s.send("/greet", settle=0.8)
        s.send("\r", settle=2.0)
        check(
            any("usage: /greet <name>" in r for r in s.screen_rows()),
            "the handler sees an empty argument string",
            s.screen_rows(),
        )


def test_lua_fullscreen():
    """A full-screen, keyboard-capturing widget — the shape a game needs.

    Three things have to hold together: the widget can size itself to the whole
    terminal (render is told its width but never its height, so it asks), it
    receives raw keys rather than the prompt, and a key it handles itself can
    close it and hand the keyboard back.
    """
    with Session(settings=NOIR, cols=80, rows=24) as s:
        os.makedirs(f"{s.home}/.loop/lua", exist_ok=True)
        with open(f"{s.home}/.loop/extensions.json", "w") as fh:
            fh.write('{"builtins": {"lua": true}}')
        with open(f"{s.home}/.loop/lua/full.lua", "w") as fh:
            fh.write(
                """
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
"""
            )
        s.pump(8)
        s.send("/full", settle=0.8)
        s.send("\r", settle=2.0)
        rows = s.screen_rows()
        banner = next((r for r in rows if "FULLSCREEN" in r), None)
        check(banner is not None, "the full-screen widget opened", rows)

        # It sized itself to the real terminal, and covered it.
        check("24x80" in (banner or ""), "the widget knows the terminal size", banner)
        filled = [r for r in rows if r.strip().strip(".") == "" and r.strip() != ""]
        check(len(filled) >= 20, "it covers the screen", len(filled))

        # Keys reach the widget, not the prompt.
        s.send("wasd", settle=1.2)
        check(
            any("PRESSED 4" in r for r in s.screen_rows()),
            "raw keys reach the widget instead of the editor",
            s.screen_rows(),
        )

        # Esc is the widget's own key: it closes and returns the keyboard.
        s.send("\x1b", settle=1.5)
        check(not any("FULLSCREEN" in r for r in s.screen_rows()), "esc closed it")
        s.send("back at the prompt", settle=1.0)
        check(
            any("back at the prompt" in r for r in s.screen_rows()),
            "the prompt has the keyboard back",
            s.screen_rows(),
        )


def test_recipes():
    """Recipes are discovered live; their input prompts can be cancelled cleanly."""
    with Session(settings=NOIR) as s:
        directory = os.path.join(s.home, ".loop", "recipes")
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, "endpoint.md")
        with open(path, "w") as fh:
            fh.write("# Endpoint workflow\n\nCreate {{resource}} and run the endpoint tests.\n")
        s.pump(7)
        s.send("/recipe list\r", settle=1.5)
        check(any("/recipe endpoint" in r for r in s.screen_rows()), "recipe file is listed", s.screen_rows())
        s.send("/recipe show endpoint\r", settle=1.5)
        check(any("Endpoint workflow" in r for r in s.screen_rows()), "recipe Markdown is visible", s.screen_rows())
        s.send("/recipe endpoint\r", settle=1.5)
        check(any("resource (blank/Esc cancels)" in r for r in s.screen_rows()), "missing input opens a prompt", s.screen_rows())
        s.send("\x1b", settle=1.0)
        check(any("Recipe cancelled" in r for r in s.screen_rows()), "Esc cancels without running", s.screen_rows())
        s.send("/recipe\r", settle=1.5)
        check(any("choose a workflow" in r for r in s.screen_rows()), "recipe picker opens after cancellation", s.screen_rows())
        s.send("\x1b", settle=1.0)
        s.send("/recipe rm endpoint\r", settle=1.0)
        s.send("\r", settle=1.0)
        check(os.path.exists(path), "delete defaults to keeping the recipe")


def test_handoff():
    """A local model fixture drives extraction, review and the destination pickers."""
    class Model(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            payload = json.dumps({
                "id": "msg_fixture", "type": "message", "role": "assistant", "model": "fixture",
                "content": [{"type": "text", "text": "## Objective\nFix endpoint validation.\n\n## Next steps\nRun the regression tests."}],
                "stop_reason": "end_turn", "stop_sequence": None,
                "usage": {"input_tokens": 20, "output_tokens": 15},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        settings = json.dumps({"uiMode": "noir", "defaultModel": "custom:fixture/fixture"})
        with Session(settings=settings, env_extra={"LOOP_SKIP_VERSION_CHECK": "1"}) as s:
            with open(os.path.join(s.home, ".loop", "auth.json"), "w") as fh:
                json.dump({"active": "custom:fixture", "customProviders": {"fixture": {
                    "name": "fixture", "sdk": "anthropic", "baseURL": f"http://127.0.0.1:{server.server_port}/v1",
                    "apiKey": "fixture", "auth": {"kind": "apikey", "apiKey": "fixture"},
                    "models": [{"id": "fixture", "contextWindow": 100000, "maxOutput": 4096}],
                }}}, fh)
            transcript = os.path.join(s.home, "source.jsonl")
            with open(transcript, "w") as fh:
                fh.write(json.dumps({"type": "message", "role": "user", "content": "Fix endpoint validation; tests remain to run.", "ts": 1}) + "\n")
            s.pump(7)
            s.send(f"/import {transcript}\r", settle=1.5)
            s.send("/handoff validation\r", settle=3.0)
            check(any("Review handoff" in r for r in s.screen_rows()), "generated brief reaches the review menu", s.screen_rows())
            s.send("\r", settle=1.5)
            check(any("Handoff model" in r for r in s.screen_rows()), "destination model picker opens", s.screen_rows())
            s.send("\r", settle=1.0)
            check(any("Handoff agent" in r for r in s.screen_rows()), "destination agent picker opens", s.screen_rows())
            s.send("\r", settle=1.5)
            rows = s.screen_rows()
            check(any("Handoff opened:" in r for r in rows), "fresh session opens", rows)
            check(any("Original session:" in r for r in rows), "source session reference is visible", rows)
            check(any("Ready for your next prompt" in r for r in rows), "opening waits for the user's next prompt", rows)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


SCENARIOS = {
    "handoff": test_handoff,
    "recipes": test_recipes,
    "boot": test_boot,
    "growth": test_no_duplicates_while_growing,
    "completion": test_completion_list_costs_nothing,
    "selector": test_selector_costs_nothing,
    "menu-anchor": test_menu_anchors_to_the_frame_not_the_screen,
    "menu-scrolled": test_menu_follows_the_prompt_when_scrolled,
    "wheel-tail": test_wheel_tail_yields_to_typing,
    "wheel": test_wheel_scrolls_the_document,
    "pinned": test_pinned_input,
    "new": test_new_session,
    "clear": test_clear_screen,
    "resize": test_resize,
    "alt-screen": test_alt_screen_keeps_scrollback_clean,
    "shells": test_shells_panel,
    "shells-esc": test_shells_survive_esc,
    "lua-widget": test_lua_widget,
    "lua-dock": test_lua_dock,
    "lua-drag": test_lua_drag,
    "lua-terminal": test_lua_terminal,
    "lua-command": test_lua_command,
    "lua-fullscreen": test_lua_fullscreen,
}


def main():
    wanted = sys.argv[1:] or list(SCENARIOS)
    for name in wanted:
        fn = SCENARIOS.get(name)
        if not fn:
            print(f"unknown scenario: {name} (have: {', '.join(SCENARIOS)})")
            return 2
        print(f"\n== {name} ==")
        fn()
    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("failed:")
        for f in failures:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
