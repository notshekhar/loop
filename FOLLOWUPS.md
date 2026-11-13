# Known gaps, deliberately deferred

Work that was left undone on purpose, with enough context to pick it up cold.
Each entry says what is missing, why it was skipped, and where to start — so
nobody has to re-derive the reasoning from the diff.

Delete an entry when it lands. This file is for gaps we chose, not a wishlist.

---

## 1. Restarting to install an update can discard a running turn

**Where:** `apps/web/src/components/sidebar/SidebarUpdatePill.tsx` (the
`install` action) and `apps/desktop/src/updateManager.ts` (`install()`).

**What happens today.** When an update has been downloaded, the pill offers
Restart. It calls `installUpdate()`, which swaps the install and then
`app.relaunch()` + `app.quit()`. Nothing asks whether an agent turn is in
flight. loop persists a turn only when it ends (see the `foldLiveTurn` comment
in `apps/web/src/loop/handlers/thread.ts`), so quitting mid-turn loses whatever
that turn had produced — and the confirmation dialog the pill already shows
talks about restarting, not about losing work.

**Why it was left.** The updater shipped in v0.17.0 and the gap is narrow: the
user has to click Restart while a turn is running. Getting it right means
deciding the *policy* — block, warn, or wait — and that is a product call, not a
mechanical fix.

**Where to start.** The renderer already knows: a thread snapshot carries
`running`, and `activeTurnId` is non-null exactly while a turn is in flight. The
cheap version is to disable the Restart button with a tooltip while any session
is running. The better version is to keep the update staged and install on the
next quit, which costs nothing to the user — the download has already happened,
and `swapInstall` is fast because it is two renames.

---

## 2. The Windows update swap has never been run on Windows

**Where:** `writeWindowsSwapScript` in `apps/desktop/src/updater.ts`, and the
`win32` branch of `UpdateManager.install()`.

**What is unverified.** macOS and Linux swap in place, and both were exercised
against real archives — a real `ditto` zip through `extractRelease` and
`swapInstall`, with the bundle genuinely replaced. Windows cannot swap in place
because the loader keeps a running `.exe` locked, so it writes a `.cmd` that
polls `tasklist` for our pid, moves the directories, relaunches with `start ""`
and deletes itself. **That script's contents are unit-tested; the script has
never actually executed.** No Windows machine ran it.

**Specific things most likely to be wrong**, in rough order:

- `tasklist /FI "PID eq <pid>" | find "<pid>"` is a common idiom but its exit
  code behaviour is fiddly; a wrong sense on the `errorlevel` check turns the
  wait loop into either a spin or an immediate swap while the app is still
  holding its files.
- `move` across volumes fails on Windows where it would succeed on POSIX. An
  install on `C:` updating from a temp dir on another drive would hit this. The
  work dir comes from `makeWorkDir()` (`os.tmpdir()`), so this is plausible, not
  hypothetical — staging beside the install directory instead would avoid it.
- A path containing spaces is quoted throughout, but `%~f0` self-deletion while
  the script is still executing is timing-dependent on some Windows versions.
- The relaunch inherits the helper's environment, not the original app's.

**How to verify without guessing.** Package a win32 build (it cross-builds from
macOS — see `apps/desktop/package-app.ts`), install it on a Windows machine or
VM, publish a newer tag, and take the update. Watch that the app comes back on
its own and that no `.old` directory is left behind. Until someone does that,
treat Windows in-app updating as unproven; `install-desktop.ps1` still works and
is the fallback to tell a Windows user about.

---

## 3. The source-control UI is mid-redesign

**Where:** `apps/web/src/components/scm/`, plus the `scm` surface registered in
`rightPanelStore.ts`, `RightPanelTabs.tsx` and `ChatView.tsx`.

**What prompted it.** The first version rendered the file list as a strip above
the diff. That was wrong twice over: it competed for height with the patch it
describes, and it read nothing like the source-control view anyone who has used
VS Code expects.

**What has changed so far.** Source Control is now its own right-panel surface
alongside Files and Diff, with its own header, branch name and refresh, and it
polls so the agent's own commits show up. It owns its status rather than
borrowing the diff panel's. Rows are dense, and each row's status letter swaps
for its stage/discard buttons on hover, so the controls never widen the row or
push the filename around.

**What is still not right**, and is the reason this entry exists:

- **No tree view.** VS Code offers list *and* tree, with the tree collapsing
  common directory prefixes. With thirty changed files under `apps/web/src/...`
  the flat list is mostly repeated path.
- **No hunk affordances in the diff itself.** The engine is done and tested
  (`applyLineChanges.ts`, `parseHunks.ts`, `stageHunk.ts` — including line-level
  selection), but nothing in the diff view offers a gutter control to stage a
  hunk or a selection. That is the last piece of the staging feature.
- **No inline commit box.** VS Code's message field and Commit button live at
  the top of this view; loop's commit flow is still the header's stacked action.
- **The merge editor does not exist.** `conflictStages` reads base/ours/theirs
  out of the index and is tested; the three-pane view on top of it is not built.
- **The surface has not been confirmed on screen.** It typechecks and builds,
  and the panel underneath it has been driven end to end, but the last few
  attempts to open the new tab under automation clicked the wrong element. Open
  it by hand before trusting it.

---

## 4. The diff panel's scope picker was removed, and should come back deliberately

**Where:** `apps/web/src/components/DiffPanel.tsx`, where a `DropdownMenu`
offering "Working tree", "Branch changes", "Latest turn" and a specific turn
used to sit in the header.

**Why it went.** Turn-scoped diffs assume changes are followed turn by turn,
which is not how this project is worked on, so the picker mostly offered ways to
end up looking at something other than the work in progress — and a stored
selection of "branch changes" persisted across sessions, making the panel's
default state ambiguous.

**What is still there.** All of it, minus the control: `selectedTurnId`,
`selectTurn`, `orderedTurnDiffSummaries`, the checkpoint-diff query and the
branch-range source are untouched and working. `selectedGitScope` is pinned to
`"unstaged"`, which is the only line that has to change to offer the choice
again.

**If it returns**, two things to decide first: where the control lives now that
the header also carries commit/push, and whether a scope should persist across
sessions at all — reopening the panel to a half-remembered comparison is what
made the old one confusing.

---

## 5. Two halves of the cmux integration need a change on cmux's side

**Where:** `packages/cli/src/interactive/cmux-reporter.ts`.

**What happens today.** Inside a cmux pane loop mirrors its lifecycle events
into cmux's Feed and gets its approvals answered there — all of it over public
socket verbs, with nothing to install. Two things it cannot reach:

- **Feed rows are labelled `claude`.** `feed.push` honours the event's
  `_source` in cmux's event stream (`cmux events --category feed` shows
  `source: "loop"`), but the Feed *store* maps the source through a closed
  allowlist — `pi`, `amp`, `cursor`, `gemini`, `copilot`, `codebuddy`,
  `factory`, `qoder`, `hermes-agent` and the rest — and anything else falls
  back to `claude`. Measured by pushing one frame per candidate name and
  reading back `~/.cmuxterm/workstream.jsonl`.
- **The per-tab agent lifecycle dot stays empty**, and with it hibernation.
  That state lives in `~/.cmuxterm/<agent>-hook-sessions.json`, written only by
  `cmux hooks <agent> <event>`, which answers `Unknown hooks target: loop`.
  Session restore does not need it: loop sends `surface.resume.set` with
  `auto_resume` over the socket (`cmux-resume.ts`) plus `set_agent_pid
  loop.<session>`. Released cmux builds still demote that binding to manual
  within seconds, because their process scan cannot see a fresh `loop`;
  manaflow-ai/cmux#42639 makes the scan honour the registered PID.

**Why it was left.** Both are one entry in an allowlist in a closed-source Swift
app; nothing on loop's side can fix either. The integration was built to be
worth having without them, and the parts that need cmux are the cosmetic label
and the lifecycle dot, not the Feed cards or the decisions coming back.

**Where to start.** `docs/cmux-upstream.md` in this repo is a ready-to-file
issue for `manaflow-ai/cmux`: register `loop` as a natively-integrated agent
(no installer — like Campfire, the bridge ships in the agent), add it to the
feed source enum, and accept `cmux hooks loop <event>` with
`loop --session <id>` as the resume command. If it lands, the only loop-side
change is to stop sending `_source` through the generic path and start calling
`cmux hooks loop …`; the payloads are already the ones cmux expects.

---

## 6. Background shells are CLI-only

**Where:** `packages/core/src/tools/utils/shell-registry.ts` (the registry),
`packages/cli/src/interactive/components/shells-panel.ts` (the surface), and
everything that does NOT exist under `apps/web` / `packages/core/src/rpc`.

**What shipped.** `bash` takes `run_in_background`; the `shells` tool reads
(from a cursor), kills and lists; exits announce themselves through the
`prepareStep` seam next to the todo nudge; a pinned panel shows what is
running; `/shells` is the user's side of the same registry. Shells belong to
the session, not the turn — the abort signal is deliberately not wired, so esc
leaves a dev server running — and are killed on exit.

**What is missing.** The RPC server and the web/desktop app know nothing about
any of it. Two specific gaps:

- **No panel, so no promotion.** A foreground command that outruns its timeout
  is moved to the background instead of being killed, but only where
  `isShellPanelPresent()` is true — the CLI sets it, nothing else does. Print
  mode and RPC keep killing on timeout, on purpose: the timeout exists to stop
  an *invisible* long run, and promoting into a surface that cannot show the
  shell recreates exactly that. Give the web app a panel and flip the flag with
  it, not before.
- **No events.** `onShellChange` is a process-local listener set. The RPC layer
  needs to forward start/exit/output-throttle events to its clients the way it
  forwards turn events, or the web panel can only poll.

Cleanup is no longer one of these. `killAllBashChildren()` is the single call
every surface owes on its way out, and `RpcServer.dispose()` makes it for the
RPC ones — stdio (including SIGTERM, which is how the desktop stops a spawned
child), the socket daemon, `serve`, and embedded core in the Electron main
process. Print mode makes it directly, and `session.delete` kills that
session's shells, since deleting a session is the moment its shells become
unreachable.

**Deliberately not built, and not a gap to close casually:** shells are
process-lifetime. Nothing is persisted, and a resumed session does not adopt
the previous process's children. Adopting an orphan tree means owning reaping
and authorization; opencode pulled their model-facing background launch for
exactly this and left the preconditions in a TODO ("persist background job
status and define restart recovery before exposing remote observation").
Remote observation is where that bill comes due, so decide it before the RPC
layer starts reporting shells to a client that outlives them.
