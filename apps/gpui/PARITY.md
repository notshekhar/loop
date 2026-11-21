# loop-gpui parity with loop desktop

What loop desktop (`apps/web` in Electron) has, and whether the GPUI app has
it yet. A tick means the feature exists — compare screens before calling it
the same. Paths are under `apps/web/src/` unless they start with `apps/` or
`packages/`.

Features the desktop app only stubs (`notPorted` in
`apps/web/src/loop/handlers/index.ts`) are listed at the end and are not
parity work.

## Build order

1. Terminal drawer (⌘J) — local pty via `alacritty_terminal`.
2. Finish the chat loop — approvals, queued turns, stash, slash menu, /btw,
   plan mode, image attachments, @-file mentions.
3. Thread management — row/project menus, add project, archived page.
4. Command palette (⌘K) and the keymap table.
5. Right panel host, then Changes (source control + diff), git actions and
   the commit dialog.
6. Files tree and editor (⌘P, ⌘S).
7. Settings — providers and auth first, then MCP, agents, toggles, appearance.
8. Usage page, artifacts, full insights.
9. Self-update.
10. Thread teams, Trajectory view.
11. GitHub — sign-in, publish, clone, Pull requests page.
12. Browser/preview — "open in system browser" first, embedded later.
13. Connections / remote pairing — deferred.

## 1. App shell

- [x] Rail (Home, Search, Usage, Artifacts, Pull requests, Settings)
- [ ] Command palette ⌘K — `components/CommandPalette.tsx`
- [ ] File picker ⌘P — `components/files/ProjectFilePicker.tsx`
- [ ] Keymap table — `loop/shared/keybindings.ts`
- [ ] Keybindings settings page (read-only)
- [ ] Right panel host: Changes / Files / Browser / Plan / Artifact tabs
- [x] Panel layout controls in the header (terminal toggle live, right panel pending)
- [ ] Toasts
- [ ] Connection status dot and reconnect
- [x] Draft hero / empty state

## 2. Projects and threads

- [x] Thread list grouped by project; Search page
- [ ] Add project (folder browser, create directory)
- [ ] Project menu: new thread, rename, copy path, remove
- [ ] Thread row menu: rename, archive, delete, copy path, mark unread
- [ ] Archive / delete confirmations
- [ ] Archived threads page
- [ ] Thread status indicators (running, waiting, unread, error)
- [ ] Paging of long thread lists
- [ ] Parent / side-thread crumbs
- [x] Session tree: branch and fork from any entry

## 3. Chat transcript

- [x] Messages, markdown, tool rows, todos, thinking
- [ ] Chat / Trajectory tabs
- [ ] Message external-link menu
- [ ] Expanded image viewer
- [ ] Changed-files tree in a turn
- [ ] Provider status banners
- [ ] Syntax highlighting in code blocks
- [ ] Artifact chips

## 4. Composer

- [x] Editor, model / effort / agent pickers, drafts, ask-user panel
- [x] Interrupt (`session.cancel`), compact now (`session.compact`)
- [ ] Slash-command menu (`/model`, `/agents`, `/mcp`, `/clear`, `/reload`, `/btw`, `/usage`)
- [ ] @-mentions for files and skills
- [ ] Image attachments (paste, drop)
- [ ] Queued turns
- [ ] Prompt stash ⌘S
- [ ] Approvals panel
- [ ] Runtime mode (supervised / full access)
- [ ] Plan mode
- [ ] /btw side threads
- [ ] Thread teams
- [ ] Pending context cards (terminal selection, preview picks, review comments)

## 5. Changes, source control, diff

- [ ] Source control panel: staged / unstaged, stage, unstage, discard, watch
- [ ] Hunk and line staging
- [ ] Merge conflict view
- [ ] Diff panel: split / unified, whitespace, base ref

## 6. Files

- [ ] File tree
- [ ] File viewer / editor with save
- [ ] Markdown preview with inline comments

## 7. Browser / preview

- [ ] Preview tabs with omnibox, history, zoom
- [ ] Local server discovery
- [ ] Element picker and annotate
- [ ] Screenshot / recording
- [ ] Device toolbar
- [ ] Mini-player
- [ ] Open terminal links in preview

## 8. Terminal drawer

- [ ] Drawer: toggle ⌘J, tabs, new, close, resize, per-thread
- [ ] Split horizontal / vertical
- [ ] Add terminal selection to the composer
- [ ] Project scripts

## 9. Git and GitHub

- [x] Initialize Git, Open in editor
- [ ] Git actions: commit, push, commit+push, PR
- [ ] Commit dialog with an AI-written message
- [ ] Default-branch guard
- [ ] Publish repository, clone
- [ ] GitHub sign-in
- [ ] Pull requests page
- [ ] Source control settings

## 10. Insights and usage

- [x] Header insights popover (context ring, cost, compact)
- [ ] Usage page (`cost.stats`, `cost.lifetime`, `usage.steak`)

## 11. Artifacts

- [ ] Artifacts page (`artifact.*`)
- [ ] Artifact right-panel tab

## 12. Settings

- [ ] Providers and auth flows (`auth.*`)
- [ ] Custom providers (`auth.custom.*`)
- [ ] Models per provider
- [ ] MCP servers (`mcp.*`)
- [ ] Agents (`agent.*`)
- [ ] Datasources (`datasource.*`)
- [ ] Extensions toggles
- [ ] loop feature toggles (`settings.list` / `settings.set`)
- [ ] General and appearance
- [ ] About and update track
- [ ] Connections — deferred

## 13. Updates and notifications

- [ ] Self-update (port `apps/desktop/src/updater.ts`)
- [ ] Provider-update notifications

## Stubbed in loop desktop — not parity work

Snooze/settle, checkpoint revert, project content search, `vcs.pull`,
worktrees, ref switching, PR thread dialog, `terminal.restart`, preview
automation, per-turn diffs, keybinding editing, diagnostics, cloud relay.
