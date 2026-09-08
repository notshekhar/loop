# Changelog

## [0.20.5] - 2026-09-08

### Fixed

- **A tool row cuts its content, never its verdict.** A row ends in the thing you most need from it — a running call's `· running`, a folded member's `2121 bytes`, a read's `:120-179` — and fitting a row to the terminal cut its END, so the verdict was the first thing lost and an ellipsis sat exactly where it had been. A call still going read as one that had stopped mid-word. Now the fixed parts are reserved and the summary between them gives way, which is the part there is always more of. Two things went wrong here at once: the status was pushed off single rows once commands were allowed their real length in 0.20.4, and a folded run of MIXED tools had always built its rows two columns too wide, because the space reserved for the tool column counted the tool's name but not the separator after it — the two characters the fit then removed came off the receipt, so `ok · 1 line` arrived as `ok · 1 l…`. The expand hint no longer shortens the row it is added to, either: it was appended to a line that had already been fitted, so it cut a second time.
- **A long tool title in the default mode wrapped instead of clipping.** Its title is an ordinary text child, and text wraps — so once 0.20.4 let a summary run to its real length, one call became a two-line title. It is one line again, cut to the width, and it is re-cut when the terminal is resized: the box was rebuilt only when the call's state changed, so the first width it was drawn at was the only one it was ever fitted to.

## [0.20.4] - 2026-09-08

### Added

- **A bash row's command is syntax-highlighted.** It is the one thing loop prints that you would have read in colour had you typed it, and it was a flat grey run — a four-stage pipeline, a quoted path with a space in it and a stray `&&` all looked alike. The program at the head of each pipeline segment now carries the function colour, with quoting, `$variables`, operators and redirections, comments and `FOO=bar` prefixes each taking the slot the code highlighter already uses, so it repaints with the palette and needs nothing per theme. Flags are dimmed rather than coloured: in a long command they are what you skim past to find the paths. Deliberately not highlight.js, which loop already bundles — its bash grammar colours shell built-ins and leaves the command name alone, so `echo` lights up and `git` does not, which is backwards for a row whose subject is which program ran. Keywords are only read as keywords at the head of a command, so `echo done` prints an argument rather than the end of a loop that was never opened.

### Fixed

- **Tool rows use the width of the terminal.** Every summary was cut to a fixed number of characters chosen where nothing knew how wide the window was: a bash command at 80, a subagent's prompt at 50, a SQL query at 60, a plan's heading and an MCP tool's arguments at 80. On a 200-column terminal a bash row stopped a little past 80 with a hundred columns of nothing beside it, and no setting could widen it, because the cut had already happened by the time the renderer was told how much room there was. The renderers have always fitted a row to the real width — noir's rows, the folded run's table, and the box in the default mode all clip — so the earlier cut only ever subtracted. What remains is a ceiling far past any terminal, there to keep a minified one-liner out of per-frame layout rather than to decide what you see. The subagent prompt was three copies of one line in three files disagreeing about the number; it is one now. The `/tree` rows had the same two cuts at 80 and lost them too.

## [0.20.3] - 2026-09-08

### Fixed

- **An OAuth login to an MCP server could never complete on a server that follows the spec closely.** loop never sent a `state` parameter. The provider is asked to mint one and hand it back to be saved; loop returned the *stored* value instead, which on a first login is an empty string — falsy, so the SDK skipped saving it and left the parameter off the authorization URL entirely. Any authorization server that requires `state` refused the request, and because nothing was stored, the check that binds a callback to the request that started it was skipped on every login. loop now mints a fresh, unguessable value per authorization, which closes both. It also asks for the scopes the server says it needs, read from the `scope` in its `WWW-Authenticate` challenge or the `scopes_supported` in its protected-resource document — previously nothing was requested unless you wrote the scopes into the config by hand, so consent was granted for nothing.
- **A remote server waiting to be signed in to reported itself as broken.** The SDK only raises a typed unauthorized error when the transport was given an auth provider to recover with, and loop only attached one when the entry carried `auth: "oauth"` — a flag almost nobody sets, since a server announces its need for a login by refusing the first request. So "you have not signed in" arrived as `MCP HTTP Transport Error: POSTing to endpoint (HTTP 401)`, parked at `error`, where the settings panel offers reconnect and nothing else. A 401 from a remote server is now `needs authorization`, which is what puts the sign-in action in front of you. Relatedly, a server you *had* signed in to still connected anonymously unless that same flag was set, leaving its tokens unused on disk.
- **`http` versus `sse` is no longer a guess you have to get right.** The two share a URL shape and nothing in it says which a server implements, so picking wrong looked exactly like the server being down. A connect that fails because the server speaks the other transport is now retried on that one. A 401 is excluded: the transport was right and the credentials were not, and retrying would replace an actionable message with a confusing one.
- **A server that blocks automatic OAuth registration now says whether you can do anything about it.** The advice was always "register an OAuth app and set `clientId`". For Figma that is a dead end — its registration endpoint matches the client name against the Figma MCP Catalog and refuses everything else, the `mcp:connect` scope is not offered to self-serve apps, and personal access tokens are not accepted either. The message now names the allow-list and points at Figma's local Dev Mode server (`http://127.0.0.1:3845/mcp`, no auth), instead of sending you to make credentials that would also be refused.
- **Servers declared in `~/.loop/settings.json` no longer wait on project trust.** Trust exists so a repo you just cloned cannot run its own hooks and skills; it has no business withholding a server you declared in your own config, which no repo can influence. It did, silently — in an untrusted folder nothing connected and nothing was printed, including in folders where the trust prompt never appears at all, which left no way to fix it from inside loop. Project-scoped servers in `.loop/mcp.json` still wait for trust, and anything held back is now named at startup rather than simply missing. `/mcp` follows the same rule: its reconnect and authorize actions used to refuse on every server in an untrusted folder, including ones already running, and pointed at a `/trust` command that does not exist.
- **Two tools from one server could collapse into a single name, and one of them would vanish.** A tool's key is `mcp__<server>__<tool>`, sanitized into the provider's character set and shortened to 64 characters — neither of which is reversible. A server exposing `get-issue` and `get_issue` produced one key for both, and shortening keeps only a long name's head and tail, so two verbose names differing in the middle produced one key as well. The second silently replaced the first: the tool count under-reported the server, one tool became unreachable, and the model was handed a name whose schema belonged to a different tool. A server name long enough to fill the budget was worse still — the shortener fell back to trimming the whole string, taking the `mcp__<server>__` prefix with it, and that prefix is how a dead server's tools are withdrawn, so they stayed in every later turn instead.
- **MCP follows `/cd`.** The manager captured the working directory when it first connected and never let go, so after changing directory the project's `.loop/mcp.json` was still read from wherever loop was launched, the trust decision was evaluated against that folder too, and the servers belonging to the directory you actually moved to never connected. The same applied to a remote client that reconnected with a different cwd. User-scope servers are left alone — they belong to no directory.
- **`loop mcp get` no longer prints credentials.** A literal bearer token in `--header`, or a `clientSecret` written into the entry, went straight to the terminal — into scrollback, screen shares and pasted bug reports. Secret-shaped headers and environment values are masked; a `${env:VAR}` reference is left legible, since it names a secret rather than reveals one, and hiding it would obscure the very thing that says the secret is being kept out of the file.
- **`${env:VAR}` is resolved in a remote server's URL**, as it already was in headers and stdio environments. A server whose endpoint carries a per-tenant token was the one place where keeping that token out of the config produced a request to a literal `${env:...}` host. Adding a server over the RPC now also requires an `http://` or `https://` URL, which `loop mcp add` has always required — a `file://` URL was accepted and written to settings.json, then failed at connect time as a transport error that said nothing about the cause.
- **A configured server that nothing has connected says why.** The panel had one status for it, `error`, which reads as an accusation against a server that is merely idle. It now distinguishes MCP being off, a project file that has not been trusted, and simply not having connected yet. A server you disabled is also no longer listed among those held back for trust.

## [0.20.2] - 2026-09-06

### Fixed

- **The terminal panel now works beyond the first one, and on Linux.** Three faults, all in the same direction — silence rather than an error. The winsize ioctls are not the same number on every platform: BSD encodes the struct into the request, Linux uses small constants, and using the BSD pair on Linux left `resize` returning success while doing nothing, so a panel kept wrapping at its old width forever. Worse, output was read through a stream, and a read on a pty master blocks until the child writes — libuv serves those from a pool of four threads, so every terminal opened permanently consumed one and the third or fourth simply received nothing. Reading now asks `poll(2)` whether anything is waiting before reading, which blocks nothing and holds no thread, and writes go straight to the descriptor so they can no longer be reordered into `ech` + `o`.

## [0.20.1] - 2026-09-06

### Added

- **Lua scripting.** Drop a `.lua` file into `~/.loop/lua/` and it runs at startup — no package, no `npm install`, no build step, the way a Neovim or wezterm config works. It is real Lua 5.4, embedded in the binary, and it exists because the extension system asks for a package for things that should be a file: a status-line segment, a shortcut, a bit of glue nobody will publish. Enable it with `loop enable lua`; `/lua` lists what loaded and where anything failed, and `/reload` re-runs them live. Scripts get slash commands, status-line segments, timers, subprocesses, settings, and `require` for splitting a script across files. `io`, `os`, `package` and `debug` are not in the sandbox, each VM has a 32 MB ceiling and a 250 ms per-call timeout, so a runaway script raises instead of taking the session with it — guardrails against mistakes, not a security boundary, which is why only your own `~/.loop/lua` is ever loaded and nothing project-local is.
- **Widgets, and panels docked to the bottom.** A widget is a table with `render(width)`: it draws over the chat at any of nine anchors, may take the keyboard or leave you typing underneath, and can size itself to the whole terminal. A dock instead takes rows *from* the transcript, VS Code's bottom panel, so nothing is covered. Both are on the extension API too (`api.widgets`, `api.docks`), so TypeScript extensions can open windows — which they could not do before.
- **A terminal in a panel.** `loop.term.open{}` runs a real shell in a dock: a pty, a terminal emulator interpreting its output, and its own cursor. Everything you type goes to the shell, including `ctrl+c`, which interrupts the command rather than loop — keys you bound in Lua still come through, which is how you close it again.
- **Mouse events, and dragging.** A widget's `on_mouse` receives presses, drags and releases with both widget-local and absolute coordinates. Dragging is about ten lines of Lua and loop ships no drag API at all: it routes the event, the script decides what it means. Declining an event leaves the terminal's own text selection working.
- **`api.keymap` and `api.screen`.** Global key bindings that see a key before the editor, and the terminal's size in cells — `render(width)` is told how wide it may draw but never how tall, which anything filling the screen needs to know.

### Fixed

- **`/reload` now reloads extensions.** It re-applied their slash commands but never re-ran the extensions themselves, so an edited extension — a Lua script above all — needed a restart to take effect.

## [0.20.0] - 2026-09-06

### Added

- **A finished tool call says what it returned.** In noir a folded call was one line naming what was *asked for* — `read src/app.ts` — and nothing about what came back, so a scrolled-back turn was a list of attempts rather than a record of what happened. Every finished call now carries a receipt: `580 lines`, `exit 1 · 214 lines`, `+12 −4 · 2 blocks`, `4 matches · 3 files`, `background sh_3`. Under it sits a short peek of the real output, taken from whichever end answers — a command's last lines, where its verdict is; a search's first, where its ranking is; a diff's changed lines with the context skipped; and nothing at all for a file you named yourself, whose receipt already sized it. A failure always peeks, whatever the tool, because an error reachable only by expanding the row is the whole of the problem this fixes.
- **A folded run of calls lists what it swallowed.** Live mode collapsed a run into `Read 3 files`, which hid not just the output but which files — a fold that loses the identities. The header keeps its count and every member now gets a line under it: what was called, and what came back, right-aligned in a shared column so the eye finds the odd one out. A mixed run gains a tool column, since the header cannot say which member was the listing. Members stay strictly one line each — an edit shows `+12 −4`, not its hunk — because the fold's value is that every row in it has the same shape, and the detail is one `→` away rather than gone.
- **`toolDetail`, and `d` to cycle it.** `compact` is the old one-line-per-call density, `normal` adds the receipt and the peek, `full` opens every call's output. Set it in `/settings` or press `d` inside transcript navigation, where the key hint shows the current level.
- **`!<command>` runs a shell command from the prompt.** For the things faster done than described — an interactive login, a `git status`, a one-off script. It runs in the session's cwd, its output lands in the transcript, and the model reads it on the next turn rather than being made to answer this one. Deliberately not routed through the bash tool: that tool's permission rules and deny list exist to gate what the *model* may run, and here the author is the person typing.

### Changed

- **Reminders fire on Bun's cron instead of a one-second poll.** A reminder used to depend on the shared status-line pulse running at all, and could only be as precise as that pulse. Each is now registered with `Bun.cron` and arrives on its own. The built-in takes five fields, so sub-minute expressions — which loop has always stored — stay on the old path rather than being dropped, and one-shots are timers, which keeps the rule that a deadline lapsed while loop was closed never fires.
- **The transcript rail is a solid mark.** A settled block wore a thin `│` held 40% off the canvas, on the theory that weight should carry state; since a finished transcript is almost entirely settled blocks, that made the common case a page of grey hairlines, and the distinction was never visible anyway because the two weights are never on screen together. State is carried by colour, and the rail is now one solid glyph at a readable strength. The selection bar stays heavier still, so a selected block is a change of weight and not only of colour.
- **An answered question folds like any other call.** `ask` was held out of grouping so a question could never be reduced to a count — but a question still waiting on you is a running call, and running calls never group. The rule only ever applied to questions already answered, which are history. An answered `ask` now joins the run behind it, carrying the answer in its receipt. Plans still keep their own row: a plan is not answered and finished, it is a document the rest of the turn is judged against.

### Fixed

- **A truncated row ended in two ellipses.** Every clipped line in noir — a long bash command in a header, a wide path — rendered as `…` appended to a truncation that had already added `...` of its own.
- **The update check compared versions by splitting on dots.** It read only `major.minor.patch` and dropped any suffix, so a release did not count as newer than its own prerelease and `beta.10` sorted below `beta.2`. Not reachable with the tags loop publishes today, which are always plain `x.y.z`; the comparison is now `Bun.semver`, and an unreadable tag reports "no update" instead of throwing during the startup check.

### Internal

- CI and release workflows build on Bun 1.4.2.

## [0.19.29] - 2026-09-05

### Fixed

- **Sending a message in pinned-input mode scrolls the transcript to it.** Pinned, the prompt holds the last rows and the transcript scrolls in its own window above it — so scrolling back to read something, then sending, left the transcript where it was. Typing was visible because the prompt is pinned, so the message looked sent, but it landed off-screen and so did the reply. Sending now jumps the transcript to its newest line and resumes following it, so the reply streams in without chasing it. Scrolling back and *typing* still leaves your position alone; only sending moves it.

### Added

- **Relay: context windows without summaries.** A new built-in extension (off by default — turn it on in `/extensions` or with `/relay`). At the context threshold loop normally spends a full model call summarizing the conversation, at the moment context is fullest. Relay starts a fresh window instead and carries a recovery record built from the transcript: every request you made in the window, the todo list as it stands, the files it touched, the commands it ran, and any tool results that arrived too late for the model to read. No model call, so it is free, cannot invent a summary that never happened, and works when the summarizer is unreachable. The old conversation is not deleted — it stays in the session, and a `history` tool searches and reads it, pages against what context is actually left, and puts real matches ahead of its own echoes. `new_context` starts a fresh window on demand, `get_context_remaining` reports the budget, and one best-effort checkpoint reminder arrives before the line.
- **`api.context` for extensions** (API `0.3.1`, additive): own the context boundary with `registerPolicy`, ask for a fresh window with `requestBoundary`, read the live budget with `read()`, and reach entries that have left the model's context with `branch()`. `TurnContext` gains `contextWindow` and `contextUsed`, and `onAdditionalContext` contributes text to one turn's request without it ever entering the transcript.

## [0.19.28] - 2026-09-05

### Fixed

- **Resuming a compacted session shows the whole conversation again.** Replay skipped every message below the compaction's cut, so reopening a compacted thread showed the summary and nothing else — a session compacted at 21,388 tokens opened on a bare `[compaction]` line with the entire conversation missing above it. The entries were never gone: `/tree` listed them and both web surfaces rendered them, so the same session read as two different conversations depending on where it was opened. The transcript now replays in full. The compaction marker also moves to the cut itself rather than the top of the screen — the compact entry is written when compaction runs, so it sits later on the branch than the cut it records, and drawing it at its own position put the surviving messages above their own boundary.

## [0.19.27] - 2026-09-03

### Fixed

- **`/trace`'s hover detail no longer leaves the screen.** The bubble was positioned inside the overview section, so it was clamped against that box's width and never clamped vertically at all — hovering a bar low on the page pushed it below the fold, and the per-turn strips, which sit far down the ledger, placed it against a box they are not in. It is now one bubble on the page itself, positioned in viewport coordinates: it slides back inside at the right edge and flips above the cursor rather than run off the bottom. Every hover target that used the browser's own slow yellow tooltip — the mode buttons, the time breakdown, the tool table, the cost bars, the truncated tool arguments and the slowest list — now uses the same bubble, with a heading and its detail under it.

### Changed

- **Messages in `/trace` render as markdown.** Prompts, replies, reasoning and subagent briefs were printed as preformatted text, so a reply that was a numbered list with a table and a code block in it arrived as a wall of asterisks and pipes — the one thing on the page you actually read. They now render: headings, lists (nested, and task lists with their checkboxes), tables, fenced code with its language, block quotes, rules, emphasis and links. Model output is put on the page as text and never as markup, so nothing in a reply can become an element, and only http, https, mailto and in-page links are clickable. Searching still works over it — a match is marked inside the rendered prose rather than flattening it back to plain text.
- **A tool call in `/trace` shows its arguments, not its JSON.** The row read `{"command":"cd /repo && git status"}`; it now reads `cd /repo && git status`. The argument the call is named by comes first without its key — a search leads with what it searched for, not where — and the rest follow as `key: value`.

## [0.19.26] - 2026-09-02

### Changed

- **`/trace` gets an overview of the whole session, and filters that reach it.** The page used to be a timeline per turn and nothing above them, so a session's shape — which turns were slow, where the tools clustered, when it sat idle — was something you scrolled to find. There is now one axis over the entire session with prompts, model and tool lanes on it: wheel to zoom anchored under the cursor, right-drag to pan, drag to select a slice, and the ledger below narrows to whatever that slice covers. A wall clock is only one of four ways to read it — idle can be removed so a session with a coffee break in it is legible, durations can be packed end to end, or every record can take one equal slot when the sequence matters more than the length. A minimap under the axis keeps the whole session in view while zoomed, hovering a bar gives its exact clock, duration and first-token/decode split, and clicking one opens the step it belongs to. Search covers prompts, replies and tool input and output, with filters for a single tool, errors only, and a minimum duration; the count, the bars and the ledger all read from one list, so they cannot disagree. Keyboard throughout — `j`/`k` between records, `J`/`K` between turns, `/` to search, `1`-`4` for the projections, `?` for the rest.
- **`/trace` says where the time and the money actually went.** A breakdown splits the session into waiting for the first token, streaming, tools and idle; a table gives every tool its call count, total, median, p95, slowest call and errors, and clicking a row filters the page to that tool; the slowest handful of records are listed and clickable, with cost per turn beside them. Timing provenance is unchanged and still drawn rather than guessed: a step recorded before this existed is one hatched bar, never an invented split.
- **The trace page dropped its graph-paper background.** The grid was tiled over the entire page, fixed to the viewport, texturing prose that had nothing to do with time. It now appears only inside the timing tracks, spaced on the ruler's own ticks, so the lines mean something and re-space themselves as you zoom.

## [0.19.25] - 2026-09-02

### Changed

- **The chat runs on the alternate screen.** Every turn used to be written into the terminal's own scrollback, and a row that has scrolled off can only be reprinted, never moved — which is the single cause behind the duplicated chat, the blank bands and the frame that could not be pulled back down. There are no committed rows on the alternate screen, so that class of bug has nowhere to happen. Nothing is lost by the move: leaving the alternate screen prints the transcript once, whole, into the terminal, so quitting still leaves the conversation behind. Measured at 0 scrollback lines during a 40-message session, with the full transcript in the terminal afterwards. The wheel, `PgUp`/`PgDn`, `Home`/`End`, `Ctrl+↑`/`Ctrl+↓` between prompts and `Ctrl+Shift+F` to search now move loop's own window over the conversation rather than the terminal's.
- **`packages/tui` is synced with pi-mono, for the first time since the fork.** 28 shared files brought from the fork point (f2e9d75, between v0.80.2 and v0.80.3) up to v0.84.4 by three-way merge, and the monolithic TUI class split the way upstream split it: an interface over a base, a main screen that renders differentially into scrollback, and the alternate screen with its layout engine, scroll views and search. loop's local parts were re-attached where they now belong rather than carried as a diff — both halves of the committed-rows work on the main screen, and on the base the callable overlay margin, the frame bookkeeping and loop's own brand paths. Two upstream behaviours were deliberately not taken: OSC 11 reports are stripped out of any chunk rather than only while a query is pending (two replies can arrive batched, a reply can arrive after its query timed out, and such a reply ends in BEL — which is ctrl+g, which loop binds to "continue"), and the width model stays probe-calibrated, because upstream's zero-width regex includes `Mc` and would undo the Devanagari fix.
- **`pinnedInput` says where the prompt sits, and applies the moment you toggle it.** It used to mean "start held at the bottom rather than sinking there", which was a difference you could only see in the first few seconds of a session. Now it picks between two layouts. Off — the default — the prompt sits directly under the last message the way a shell prompt follows a command's output, sinks to the bottom as the conversation grows, and scrolling back moves the whole page, prompt included. On, the transcript gets its own window above a prompt that never moves, and the wheel scrolls only that window while the status line and panels stay put. It is a layout swap, not a boot-time flag, so `/settings` → pinned input repaints on the spot.

### Added

- **`/trace` — where this session's time and money went, as a page in your browser.** The cost ticker tells you the total and the transcript tells you the order, but neither answers which step spent the ninety seconds, or whether it went to the model thinking or to a tool call waiting on the network. The turn loop now stamps each step's wall clock onto the entry it persists — start, first token, model end, end, and every tool call's own start and end — and `/trace` renders the session from it: turns, the steps inside them, the tools inside those, each with its own bar, its tokens and its dollars. It writes one self-contained HTML file and opens it, or writes to a path you give and leaves it alone, printing the path either way so it survives an SSH session. Timing provenance is on the page rather than smoothed over: steps recorded by this version get real split bars, older entries carry only an end timestamp so their wall time is drawn as a single hatched bar, and a step with no anchor to measure from says "timing not recorded" instead of inventing one. A malformed timing block on a session entry is dropped, never repaired.

### Fixed

- **The wheel did nothing on the alternate screen.** loop's terminal setup clears stale modes on the way up — including `?1000l ?1006l` — because a predecessor killed with SIGKILL never ran its exit handlers and leaves the shell echoing raw key reports. That cleanse runs after the screen has asked for mouse tracking, so it switched the tracking straight back off, and with no terminal scrollback to fall back on that was the whole of scrolling. The sequences are idempotent, so they are re-asserted after the terminal starts rather than reordered around a cleanse that has to run late. The wheel also moves three lines per notch now, which is what terminals themselves do; the library's default of one reads as a stuck wheel.
- **A menu opened one row low, or floated in the transcript with no prompt under it.** Overlays anchor to the bottom of the frame's content, and the alternate screen was reporting the layout's line count — already padded out to the viewport, so always the terminal height and always one row short of the real gap, which put `/settings` and the completion list over the editor's own row. Separately, that measurement knows the document's length but not where the window onto it sits: scrolled back with pinning off, the prompt is below the screen entirely, and a menu anchored to the last row was drawn over the transcript alone. Typing now brings the prompt back into view first — a shell scrolls to the bottom on a keystroke — so a menu always opens on the prompt, and wheeling away while one is open takes the menu with it.
- **Scrolling back and starting to type made the prompt flicker.** A trackpad keeps sending wheel-up events for a few hundred milliseconds after the fingers lift, so the first key jumped to the end, the tail dragged the view back up, and the next key jumped again. Terminals send no scroll phase, so the tail can only be told from a hand on the wheel by time: after a keyboard-driven jump the wheel yields briefly, and each key typed inside that window extends it. Nobody types and flicks at once, so a real scroll pays nothing for it.
- **A long path in the startup banner could exit loop at boot.** Truncating with an ellipsis appended by hand could still leave the row a cell wider than the terminal, tripping the width-overflow guard — a silent exit. The truncation now includes the ellipsis in what it measures.

## [0.19.24] - 2026-08-31

### Fixed

- **A background shell no longer outlives every surface except the terminal.** Shells are process-lifetime by design — the registry holding them is in memory, nothing is persisted, and a resumed session does not adopt the previous process's children — but only the terminal ever acted on that. `killAllShells()` had exactly one caller in the repository, on the TUI's exit path, while `run_in_background` is gated on the `backgroundShells` setting and not on the surface. So a shell started through `loop serve`, `loop rpc`, print mode or the desktop app kept running after the process that owned it was gone, and what was left behind was not a stray `sleep` but a dev server holding a port that no later session could list, read or kill, because the only handle on it died with the registry. Every surface now reaps on its way out: the RPC server does it for stdio (on stdin end and on SIGTERM, which is how the desktop stops a spawned child), for the socket daemon, for `serve`, and for core embedded in the desktop app — where a background shell is a child of Electron itself and survives the app quitting. Deleting a session kills that session's shells too, since the registry is keyed by session id and deleting the session is the moment they become unreachable.
- **`loop serve` had no exit path.** It printed "Ctrl+C to stop" and left the default signal disposition to end the process, which unwinds nothing — so the surface most exposed to other machines was also the one least able to clean up after them. Ctrl+C is handled now.

### Added

- **A blocked pane shows on the MacBook notch.** A background pane waiting on an approval is invisible: nothing about it reaches you until you look at that terminal, which is the one thing you are not doing while it waits. herdr and cmux each solve this inside their own multiplexer; this solves it for every pane at once, on the one surface that is always in view without being looked for — above every app, inside fullscreen. The same working / blocked / idle state the herdr reporter sends is drawn there alongside the session's name and the last thing the agent said. It is gated on `~/.notch/notch.sock` existing rather than on an environment variable, because a desktop app cannot inject env into a terminal that is already open — so starting the notch app half an hour into a session works, and the next transition appears. Default on and completely inert when the notch is not running; turn it off with `"notch": false` or in `/settings`.

## [0.19.23] - 2026-08-28

### Changed

- **Background shells are something you turn on now.** Shipping the feature on by default decided for everyone that the agent may leave processes running past the turn that started them, which is a choice that belongs to you. `backgroundShells` now reads like `artifacts` and `webSearch`: unset means off, so out of the box nothing the agent runs outlives its own tool call. Off, the `shells` tool is never offered, `bash` refuses `run_in_background`, and a command that outruns its timeout is killed rather than moved to the background — promotion is part of the capability, not a separate mercy. `/shells` is untouched either way: the setting governs what the *agent* may start, not what you can. Turn it back on in `/settings` or with `"backgroundShells": true`. The system prompt no longer tells the model to reach for a background shell when there is no shells tool to reach for.
- **The repository typechecks itself.** Neither bundler here checked types — `bun build` and `vp build` both transpile — so the desktop app had been carrying seven type errors that nothing was reading, including a value used but never imported. `bun run typecheck` now covers every workspace and runs ahead of the tests. Asking the same question of every symbol turned up 153 exports that nothing referenced anywhere, and removing them cascaded until about four thousand lines of unreachable code were gone.

### Fixed

- **A run of `shells` calls was labelled "Called 2 tools" in the app.** The desktop and web UI carry their own copy of the vocabulary that turns a run of tool calls into one line of English, because they are a browser bundle and cannot import the terminal's. The copy was never given the `shell` entry that shipped with background shells, so the same run read "Checked 2 shells" in the terminal and "Called 2 tools" — the wording reserved for tools loop did not write — in the app. Both copies are now held to identical behaviour by a test, rather than by a comment asking to be kept in sync.

## [0.19.22] - 2026-08-26

### Added

- **bash can start work that outlives the turn.** Every run was bounded by a timeout, so a dev server, a watcher or a ten-minute build could only be started by giving the turn up to it or by watching it die at the deadline — which closed off the loop the work is actually judged on: run the app, look at it, fix it. `bash` now takes `run_in_background` and returns a shell id immediately. The new `shells` tool reads what one has printed **since the last look** (a cursor, not a replay of the startup banner), kills it, or lists them, with a regex `filter` for processes that will not stop talking. Exits announce themselves instead of waiting to be polled, so the model is told a build failed rather than sleeping in a loop to find out. Running shells are pinned above the editor, and `/shells` is the same registry from your side — `/shells run <cmd>` to start one yourself, `/shells <id>` to read it, `/shells kill <id>|all`. Gated by the `backgroundShells` setting, default on.
- **A long command is moved to the background instead of being killed.** A foreground command that outruns its timeout used to die at the deadline with its output thrown away. It is now handed to the registry with the lines it had already printed, and keeps running — but only where the shells panel is mounted to show it, because the timeout exists to stop an *invisible* long run and promoting into a surface that cannot show the shell would recreate exactly that. Print mode and RPC keep killing.

### Changed

- **A background shell belongs to the session, not the turn.** The turn's abort signal is deliberately not wired to it: esc ends the turn and leaves your server running. It does not outlive loop itself — everything still running is stopped on exit, which is also the first time `killTrackedDetachedChildren()` has ever been called. It has been exported since detached spawning existed and had no caller anywhere in the repo, so a plain foreground bash child could already survive a crash.

## [0.19.21] - 2026-08-25

### Changed

- **`edit` stops making you pay for its own diff, for the rest of the conversation.** The tool handed its unified diff back to the model, and the AI SDK persists whatever a tool returns — so the diff was not sent once but re-sent on every later step of the turn and on every resume after it, while the call's own arguments already carried every `oldText`/`newText` pair the diff was built from. Measured across the twelve largest sessions on one machine: 201k chars of edit arguments against 227k chars of edit results, the echo costing slightly more than the request that produced it, and 3.2M prompt tokens spent carrying it forward where 240k would have done. `edit` now cuts the diff on the way to the model, exactly as `write` has since it shipped, and the two share one definition of where the cut falls instead of `write` keeping a private copy. A fuzzy match is the one exception: there the text that was replaced is not byte-for-byte the `oldText` that was asked for, so the file does not read the way the model thinks it does, and that result reaches it whole — named edit, reason, and diff.
- **A reloaded edit still shows what it changed.** The diff rides the live tool-result event, which is real while the turn is on screen and gone when the thread is replayed from history — the same gap `write` has had all along. The terminal and the desktop both rebuild it now from the call's own arguments, which do survive. Without line numbers, deliberately: the arguments never said where in the file the blocks landed, and invented numbers sitting in the same gutter as a live edit's real ones would be read as real ones.

## [0.19.20] - 2026-08-23

### Changed

- **Gateways run inside loop now, instead of each forking a detached daemon.** Opening loop used to spawn `loop gateways <id>` as its own separate OS process per enabled gateway, bound to the TUI's lifetime by a watchdog that polled every five seconds to see whether its owner still existed. Nothing about a gateway ever needed that: the Telegram bridge is a fifty-second long poll driving its own in-process `RpcServer` — idle I/O, the same shape `loop serve` already hosts in the process you are sitting in. What the daemon did add was a way to lose one. A detached process whose shutdown signal never arrived kept polling, and a Telegram bridge that keeps polling keeps running shell commands from a chat nobody is watching; each one also re-invoked the whole loop binary just to sit in a socket read. Enabled gateways now come up in the TUI's own process and stop with it, so there is no longer a process that can outlive the loop that owns it.
- **Turning a gateway on tells you whether it actually started.** Setup spawned a child and then polled its pidfile for up to eight seconds, so the only honest thing the screen could say was whether something had appeared; a rejected token surfaced in a logfile you had to know to go and read. `start()` is awaited now — "running" means the token validated and the poll loop is up, and a failure names its reason on the screen it happened on. The daemon logfile is gone with the daemon, and gateway diagnostics go to the transcript.
- **`loop gateways stop` will not take your session down with it.** The pidfile records how a gateway is being served, not just which pid serves it, because the same SIGTERM that correctly stops a dedicated daemon would kill an entire interactive loop. An in-process gateway is reported and left alone, with `/gateways` named as the way to turn it off. Pidfiles written by older versions still read correctly and stay stoppable.

## [0.19.19] - 2026-08-22

### Changed

- **noir's `system` theme asks the terminal what colour it is once, and never again.** The watcher that enabled unsolicited colour-scheme reports (`?2031h`) and re-measured on every flip is gone. It was never worth its keep: following a flip only repainted half the screen — live components re-resolve their colours, but every line whose ANSI was already baked into the scrollback keeps the old ink, so a flipped session read as two palettes stacked — and it was the shape that made v0.19.17's flood possible in the first place, since the reply to a scheme query is itself a scheme report. Asking once cannot loop. A terminal that flips mid-session is a `/reload` away, and that gives you a whole screen in one palette instead of half of one.

## [0.19.18] - 2026-08-22

### Fixed

- **noir's `system` theme flooded the terminal with queries, and some of them came back as keystrokes.** The reply to a colour-scheme query (`CSI ? 996 n`) is itself a colour-scheme report — so a watcher that re-measures whenever a report arrives re-asks forever. Measured on a terminal that answers: **101,022 queries in ten seconds**, where there should be one. Two things fell out of that. The replies arrived batched into single chunks, which the report handling — matching a whole chunk against exactly one reply — no longer recognised, so they went through to the key handling instead; an OSC 11 reply ends in BEL, `\x07`, which is ctrl+g, which loop binds to "continue". Sessions sent prompts nobody typed. And whatever was still in flight at exit was answered into the SHELL, printing `^[]11;rgb:…` where the prompt should be. The scheme query is asked once now, at startup, never from the watcher; a live flip re-measures with the background query alone; probes are single-flight and stop before the TUI lets go of stdin, with the terminal's unsolicited reports turned back off on the way out.
- **A terminal report can no longer reach the keyboard at all.** Both reports are now stripped from anywhere in an input chunk, batched or not, whether or not a query is still pending — because neither can ever be something a person typed, and one getting through is not a stray character but a prompt sent on your behalf. This also covers the case that needed no bug to reproduce: a slow terminal answering after its query timed out.

## [0.19.17] - 2026-08-22

### Added

- **noir has a third theme, `system` — noir with no canvas of its own.** `night` and `day` wash the terminal's background (OSC 11/10) and paint noir's own dark grey behind every row, which is the point of them and wrong when your terminal already has a background it means: a true black, a transparency, an image. `system` washes nothing and hands the background back, then rebuilds its palette to suit it. Pick it in `/settings` → theme.
- **It asks the terminal what it is, and follows it live.** OSC 11 for the background colour and `CSI ? 996 n` for the colour-scheme report, with `?2031h` notifications so flipping your terminal to light mid-session repaints the transcript. Nothing to configure, and nothing is asked unless `system` is the theme you are on.
- **Its whole palette holds its contrast against your background, not noir's.** noir's colours are not their hexes because the hexes are special — each is a ratio against noir's own `#141414`: text at 16.9:1, muted at 5.3:1, dim deliberately faint at 2.9:1, the accent at 6.9:1. Reuse the same hexes on a `#262626` terminal and every one of them loses about a fifth of its contrast at once — dim lands at 2.4:1 and the quiet half of the UI, the banner's values and the hints and folded tool rows, goes to mush. Every slot is checked against the canvas that is really there — greys, semantic hues, the syntax set — and any that fell below its designed ratio is lifted back to it by tinting, so a hue stays its hue. The lift is one-sided: a terminal darker than noir's canvas already reads better and is left exactly as it is.
- **The background colour decides light-vs-dark, not the terminal's report.** `CSI ? 996 n` reports the user's colour-scheme _preference_ — on macOS, the OS appearance — so a light desktop running a dark-themed terminal answers "light" perfectly correctly, and a theme that trusts it puts near-black text and a near-white input bar on a dark screen. OSC 11 has no such gap: it is the surface being drawn on. The report is the fallback for terminals that will not name their background, and the live signal to come back and re-measure.
- **Until the terminal answers, the ramp is solved for the lightest background a dark terminal plausibly has.** The reply lands a moment after the first frame, by which time the banner and the startup notices have baked their colours; assuming a canvas that is too light only makes those a little brighter than designed, while assuming one that is too dark is exactly the unreadable screen this is here to prevent.

## [0.19.16] - 2026-08-22

### Fixed

- **An MCP server that died stayed "ready", and loop kept handing the model its tools.** The AI SDK reports transport _errors_ through a hook loop was swallowing, and a clean close — an stdio child exiting, a socket hung up — never reaches that hook at all, so loop simply never learned. Kill a connected server and its tools stayed in every later turn's tool set: the model kept calling them, every call came back "Attempted to send a request from a closed client", and `/mcp` insisted the server was fine. loop watches the connection now. A server that goes away is marked with what happened, its tools are withdrawn from the next turn, and `/mcp reconnect` brings it back.
- **`/mcp reconnect` never re-read your config.** It reconnected from the copy in memory, and the one function that reads the file is a no-op after the first call — so the thing everyone reaches for after fixing a server in `settings.json` applied none of it. Corrected arguments reconnected with the old ones; a newly added server never showed up at all. Reconnect now means what it says: match what is on disk, including servers you have added or deleted since launch.
- **A connect that failed after the handshake left the server process running.** The client was already live by the time `tools/list` failed, and nothing closed it — so every retry against a half-broken server orphaned another subprocess.
- **Deleting a server while it was still connecting brought it back.** The connect finished afterwards and wrote itself in as ready, tools and all, holding a connection nothing would ever close. Same race for disable and reconnect.
- **A re-authorization that didn't finish signed you out.** The login cleared the stored session before starting, so cancelling it — or a timeout, or a flaky network — destroyed a session that was working, on a server you were only trying to refresh. The old session goes back if the attempt doesn't complete.
- **A server whose name had a dash in it showed no tools**, and a server whose name was a suffix of another's showed the other's too — the tool list was matched against the raw name instead of the namespaced prefix.
- **`loop mcp remove --scope project <name>` removed nothing** and complained about a server called "project": the flag's value was being read as the server name. Writing the flag after the name worked, which is a miserable thing to have to discover. Affected `get`, `remove`, `enable`, `disable` and `add-json`; an unrecognized `--scope` is now refused instead of quietly meaning `user`.
- **One long tool name broke every request.** `mcp__<server>__<tool>` had no length limit while providers cap tool names at 64 characters, so a single verbose MCP server made the whole turn fail. Names are shortened to fit, keeping the server prefix.
- **Two servers whose names differ only in punctuation** (`my-fs` and `my.fs`) silently overwrote each other's tools, and removing either dropped both. The collision is reported now.
- **`headers` and `env` are validated when they are accepted**, rather than being written to `settings.json` and failing at connect time with `value.replace is not a function`.
- **Removing one scope's copy of a server no longer forgets the other's OAuth session**, and a tool call that hits the timeout is actually aborted instead of being left running.

### Changed

- **`/mcp` lists servers this process hasn't connected.** In an untrusted project — where loop deliberately doesn't auto-connect — the panel was empty while `loop mcp list` showed your servers, with no way in to reconnect or sign in to any of them. They are listed as "not connected" now, and every action that would actually spawn a server asks the same trust question startup does.

## [0.19.15] - 2026-08-22

### Fixed

- **The installed binary was killed on launch, on some Macs.** `loop` printed nothing and the shell said `killed`; the installer's own smoke test failed with an empty error, because a process that dies of SIGKILL has nothing to say. `bun build --compile` appends the JavaScript payload after the Mach-O has been ad-hoc signed, so every binary loop has ever shipped carried a signature that does not describe its own bytes — `codesign -v` on a fresh build says so outright. Most Macs only hash the pages they map and never notice, which is why this survived every release and every CI smoke test; a Mac that does check kills it at exec. The macOS binaries are re-signed after compilation now, and the build verifies the signature rather than trusting it, so a bad one fails the build instead of shipping. Already have a killed install? `codesign --force --sign - ~/.loop-bin/loop` fixes it in place, and so does re-running the installer.
- **The installer said "✓ Up to date" about a binary that could not run.** It read the version out of `package.json` next to the binary and never asked the binary anything — so once an install was broken, every subsequent run cheerfully reported nothing was wrong and exited, which is a dead end with no way out but deleting `~/.loop-bin` by hand. Being up to date is now a claim about the binary: the installer runs it. One that does not run gets its quarantine cleared and its signature rebuilt, and if that fails it is reinstalled. A fresh install that turns out not to run on this machine is rolled back to the one it replaced, so an upgrade can no longer leave you with no working `loop` at all.
- **`/new` and `/clear` left the old session's title on the terminal tab.** The tab kept advertising work that had been thrown away — in cmux, a pane card describing a session that no longer exists. A title belongs to a session and cannot outlive one: `/new` and `/clear` hand the tab back its standing name now, `/name` renames it, and `/resume` moves it to the session that is actually live.

### Changed

- **An untitled session's tab says `Loop Agent`.** It used to say the folder's name, which the status line and your prompt are already telling you; the one thing a tab can say that nothing else does is which agent this pane is. Same rule Claude Code follows — a fixed product name as the floor, the session's own title the moment it earns one.

## [0.19.14] - 2026-08-21

### Added

- **The tab shows what loop is doing, not just what it is called.** A spinner runs in the terminal title while a turn is going — loop's own braille frames, the ones the working indicator uses — with a filled diamond while a prompt is waiting on you, and nothing at all when it is idle. In cmux, tmux or any tab bar, a row of loop panes now tells you which one is thinking and which one needs you without opening any of them.

## [0.19.13] - 2026-08-21

### Added

- **Sessions name themselves.** A session was a ULID and a folder, which is fine while you are looking at it and useless the moment you are not — in a terminal tab, in cmux's sidebar, in a notification on your phone. Now the first turn earns it a title: one short call to the model you already have selected, asked for six words starting with a verb and naming the thing being worked on ("Add loop awareness to cmux terminal"). It becomes the session's name — the same one `/name` sets — and the terminal's title, which is where cmux, tmux and every tab bar read it from. Generated once from the opening exchange, because that is what a session is about and a name that keeps changing is worse than one slightly stale, and never over a name you set yourself. Billed to the cost ledger as `session-title`.

### Fixed

- **loop's terminal tab said whatever your shell last put there.** `setTitle` had been sitting in the TUI unused since it was written, so a loop pane in cmux rendered as `p dev` next to a Claude Code pane describing its actual task. loop names its tab now: the session's title once it has one, the folder before that.
- **cmux notifications ended in `|c=turn-complete;p=0;a=loop`.** That trailing field is cmux's own gating metadata, and it only counts as metadata when it parses as the exact grammar the running build knows — anything else is deliberately folded back into the body, so you read it. Current cmux accepts an `;a=<agent>` tail; shipped builds do not.

## [0.19.12] - 2026-08-21

### Added

- **loop shows up in cmux's sidebar, and tells you when the turn is done.** v0.19.10 taught loop to report into cmux's Feed, which turned out to be the half you cannot see: the status chip in the pane's sidebar and the notification when a turn finishes come from a different channel entirely, and loop drove neither — so from the outside it still looked like nothing was reporting. It drives them now, under its own name, with cmux's own icons: a bolt while it works, a bell at top priority while a prompt is waiting for you (which floats that pane up a sidebar full of agents), a grey pause when it goes idle, and nothing left behind once it exits. The finish notification carries the agent's actual closing sentence, and both notifications are tagged with cmux's own categories, so your Settings > Notifications switches govern loop's exactly as they govern Claude Code's.

## [0.19.11] - 2026-08-21

### Fixed

- **`loop upgrade` looked like it hung.** It printed `Install method: binary` and then nothing: no progress bar, no download, for long enough that the only thing to do was kill it. The installer was drawing its bar out of `curl --trace-ascii`, which makes curl write a hex-and-ascii transcript of every byte of the 27 MB tarball into a pipe, and then asks bash to parse the hundred-odd megabytes that come out one line at a time. Measured in a real terminal: 82 seconds for a download that takes 3, sitting at `0%` for the first chunk of it. It reads the size up front and watches the file grow instead — 82s to 3s, on the one path every upgrade takes. (Piping the installer's output hid this completely, which is why it survived a release: the fancy bar only runs on a terminal.)
- **loop opened two entries per launch in cmux.** `SessionStart` fires when loop boots, but loop has no session until you send the first prompt — so that one row was filed against the pane and everything afterwards against the session, leaving a near-empty second workstream beside the real one every time. Events from before the session exists are held and replayed into it now, so a launch is one entry: session start, your prompt, the tools, the turn ending.

## [0.19.10] - 2026-08-21

### Added

- **cmux knows what loop is doing, and can answer it.** Run loop inside [cmux](https://cmux.com) and it was just a shell process: the Feed sidebar stayed empty and cmux's approval cards — the ones you can answer from a notification without going back to the terminal — never appeared, because they only exist for agents that report themselves. loop reports itself now. Every lifecycle event it already emits as a hook (session start and end, your prompt, each tool call and its result, the todo list, the end of a turn with what the agent said) is mirrored into cmux's Feed over its socket, and the prompts that stop the agent — bash, file-access and plan approvals, and the ask tool's questions — go out as actionable cards. Answer one in cmux and the menu on screen closes with that answer; answer it on screen and the card is withdrawn. Whichever side is faster wins, so the terminal is never waiting on a decision that was already made somewhere else, and cmux being slow, gone, or not running costs a turn nothing at all. loop also registers `loop --session <id>` with the pane, so cmux can offer to bring the session back when it restores that terminal. On by default inside cmux, `"cmux": false` to turn it off, and completely inert everywhere else.

### Changed

- **The AI SDK moved up a patch line** (`ai` 7.0.73, every `@ai-sdk/*` provider to latest), which is what these binaries are compiled against. Nothing in loop changed with it — the upgrade is done every release so the diffs stay small enough to read, and this one paid for itself: 7.0.70 stopped running tools after a model call whose finish reason it cannot parse, which caught five test mocks still sending the pre-v3 shape.

## [0.19.9] - 2026-08-21

### Fixed

- **Your conversation could be printed into the scrollback twice.** Scrolling back replayed whole stretches of the chat, in order, as if the session had happened again. v0.19.6 taught the renderer to repaint the visible window from the frame in memory when that frame got shorter, and it filled the rows a shrinking frame gave up with lines from above the top of the screen — but a line that has scrolled off is committed: the terminal cannot be made to move it, only to print it a second time under the copy already in the history. A turn full of collapsing tool groups asked for a few more each time. The repaint now stops at the last committed row and never reaches above it.
- **Typing `/` or `@` and deleting it again left a gap in the chat.** The completion list was appended to the editor, so it made the whole frame taller for as long as it was open; a frame that reaches the bottom of the screen pays for that by scrolling, and those rows cannot come back when the list closes. One keystroke was enough to leave a band behind. The list is painted over the transcript now and costs the frame no height at all — measured in a pty, `/` typed and deleted went from six rows scrolled off plus a band to zero and none, with the screen byte-identical to before it was typed.
- **Opening a menu no longer costs you rows off the top of the screen.** Same cause: a selector swapped in for the editor made the frame taller than the terminal, pushing the top of the conversation into the scrollback for as long as the menu was open. Selectors are painted over the frame too, anchored to the bottom of the frame rather than the bottom of the screen so a short transcript keeps the menu on the prompt.
- **Turning `pinnedInput` off and on again left the prompt in the middle of the screen.** The setting looked broken; pinning was on the whole time. The menu it is toggled from was itself inline in the frame, so opening it pushed twelve rows off a thirty-row screen, and when it closed the frame shrank by that much and took the prompt up with it. With menus no longer changing the frame's height, toggling it scrolls nothing at all.
- **The scoped-models panel would not accept a space, and could not find a model by name.** Space was bound to toggling the highlighted row, so it could never reach the search box — and the search was a plain substring test, which cannot match a model id anyway: `custom:pronto-gpt/openai/gpt-5.6-sol` has punctuation where you would type a space, so "openai sol" found nothing and "gpt5sol" found nothing. Both read as the search being broken rather than the query being wrong. Every printable character builds the query now, space included, and Enter is the toggle (it always was, as well as space).
- **Every picker searches the way the editor's completion menu always has.** `/model`, `/provider`, `/settings`, `/scoped-models` and the rest share one filter: tokens split on whitespace and slashes, each matching as a subsequence, ranked so word-boundary and consecutive hits come first — "claude sonnet" and "gpt5sol" both land on the model you meant, and `sol` puts `gpt-5.6-sol` above anything that merely contains those letters. Descriptions keep their substring match and sort after the ranked results, so prose in `/settings` cannot bury the ranking.
- **A rebuilt transcript tells the renderer it is a new frame.** `/new`, `/clear`, `/ui` and `/theme` throw the transcript away and build another one, which shares no lines with it — so diffing the two by index compares unrelated rows, and the renderer can conclude the top of the screen is fine as it is and leave the previous conversation sitting there under a fresh prompt. It cannot be detected from the renderer's side either, because a line inserted ABOVE the window (a late MCP notice) looks exactly the same and must not clear the screen. `ChatHistory.reset()` says which one it did.

### Added

- **Screen tests.** The renderer's bugs are all correct frames drawn in the wrong place, which no unit test can see, so there is now a suite that runs loop in a real pty and asserts on the terminal: `bun run test:screens`, or `LOOP_E2E=1 bun test`. Boot, a growing transcript, the completion list, menus, the `pinnedInput` toggle, `/new`, `/clear` and resize — checking both the screen and the scrollback, in pinned and unpinned modes. It is validated by failing on the previous release: six of its thirty checks catch bugs fixed above. Each run gets its own HOME, only ever signals the process it started, and answers loop's terminal probes (CPR, device attributes, cell size, background colour) so it exercises the real path instead of the timeout fallback.

### Added

- **Scoped models are pickable from `/model`, not just cycleable with Ctrl+P.** The models named in `scopedModels` are the handful you actually work with, and the only way to reach one was to cycle. They sit at the top of the picker now, marked with a star and carrying their full id — the list is otherwise scoped to the active provider, and these are not all under it. Choosing one that belongs elsewhere switches the provider with it, so the status line and the next turn agree about who is serving the model.
- **`exit_plan_mode`: the agent can ask its way back out of plan mode.** Plan mode was a one-way door for the agent — it could flip the gate on itself with `enter_plan_mode`, but only you could lift it, through the plan tool's implement/talk follow-up, which ends the turn and hands the plan to a fresh agent. Everything the planning agent had just worked out went with it. The new tool closes the loop: the agent presents its finished plan, you approve, the gate lifts mid-turn and the same agent implements it immediately with its investigation intact. Gated on the same approval bridge as entering, and only offered to unrestricted agents in an interactive session while plan mode is on — a restricted agent has no edit or write tools, so lifting the gate would buy it nothing. Its plan renders as full markdown and never folds into a tool group, the same as `plan`.

### Changed

- **The completion list opens above the prompt**, with a rule across the top. Below it was where the editor's own bottom border separated it from the chat; above the prompt is where the room is now that it is not allowed to make any.

### Known

- A tool group collapsing to its summary row still moves the prompt up a few rows until the next output arrives. That one is not a bug with a fix: the rows it gives up can only be filled from above the top of the screen, and those are committed. Blank rows, a duplicated conversation, or a prompt that moves — a terminal offers no fourth option.

## [0.19.7] - 2026-08-16

### Fixed

- **A long answer no longer slows the whole UI down while it is being written.** Every token re-parsed the entire message from the top, so a frame cost 4.4ms at 8k characters, 9.5ms at 20k and 27ms at 50k — past roughly 30k the renderer could no longer fit a frame in its budget and typing went stiff, and the spinner's own 80ms tick kept paying that price even between tokens. The markdown renderer now keeps a settled head while a message streams: everything up to the last blank line whose block cannot change any more is kept as rendered lines, and only the tail is parsed again. Measured on paragraph-shaped answers, the same frames are 0.034ms at 8k and 0.045ms at 50k — the cost stops growing with the message. The head only ever advances to a boundary nothing later can reach back through (a list is never crossed, because "- a" and "- b" separated by a blank line are one list, not two), and the finished message is always rendered once, whole, so what you end up reading is the same text it always was.
- **A finished thinking block stopped being re-rendered on every token of the answer below it.** Each delta rebuilt every block of the message, which meant re-parsing text that could no longer change: with a 20k-character thinking block above the reply, a single frame cost 5.8ms doing nothing but that. Blocks are now carried across deltas — 0.022ms for the same frame.
- **`loop --session <id>` put the header's own status lines under the whole conversation.** Workspace context, project skills and active extensions are collected with an await, and that await happened after the transcript was replayed, so resuming a chat printed "workspace context: …" and "extensions: …" below the last thing you had said instead of under the masthead. They are collected before the replay now. The same block also survives `/ui` and `/theme`, which rebuild the transcript from the session and used to drop it entirely.
- **The hooks and MCP summaries join that block too, however late they arrive.** Neither can be written at startup — the hooks list waits on the trust prompt, MCP servers report when they connect — so both used to land at the bottom, under the conversation. The startup block stays open for them. On a conversation long enough to have pushed the masthead off the screen they join it up there, which is where the rest of it is; `ctrl+e` shows them in place.
- **Inserting a line above the visible screen no longer destroys your scrollback.** Any change above the window was answered with a full redraw, which clears the screen _and_ the terminal's history, so the fix above would have cost a scrollback wipe per late notice. Two cases now come first: when the visible rows are unchanged — which is what inserting something above them means — nothing is written at all, since only loop's own line bookkeeping moved; and when they did change, the window is repainted from the frame in memory, the same way a shrinking frame has been handled since v0.19.6. Only Kitty images still take the redraw.

### Changed

- **`pinnedInput` measures the chrome under the transcript once per frame instead of twice.** The measurement is not free at every size — the editor re-lays out the whole draft each time it is asked, 0.31ms on a 4k-character draft — and a pinned frame asked for it twice. It is memoized within a single frame and dropped the moment that frame ends, so the height is still measured fresh on the frame where the editor grows a line.

## [0.19.6] - 2026-08-16

### Fixed

- **Closing a menu leaves the prompt where it was, in every mode.** Open `/model`, `/agents`, `/tree` or anything else with a panel, press Esc, and the prompt used to be somewhere other than where you left it — sitting in the middle of the screen with a blank band beneath it, and the conversation stranded higher up. It got worse the more menus you opened: measured on a 44-row terminal, three panels in a row walked the prompt from row 39 to 37 to 34 to 27. The cause was one line of renderer behaviour rather than anything to do with any particular command: a frame that gets shorter had its trailing rows cleared where they were, instead of the content being pulled back down. Those lines were never lost — they are in the same array being rendered — so the renderer now repaints the visible window from them with the frame's last line back on the last row. That is exactly what clearing the screen and the scrollback and redrawing everything was buying, without destroying the terminal's history to get it. Being a renderer fix it needs no per-command patch, so the `/settings`-only repaint added in v0.19.5 — which cost two `ESC[3J` and your scrollback each time you toggled `pinnedInput` — is gone.
- **The same fix reaches unpinned sessions**, where the prompt has always crept up the screen after a panel closed and nobody had a setting to turn on to avoid it.

### Known

- **Opening a menu still scrolls the conversation up.** A region anchored to the bottom of the screen has to push the rows above it out of the way to grow, and a terminal cannot pull them back afterwards; ratatui's inline viewport — grok's — does the same `scroll_up` for the same reason. What changed here is the other half: closing the menu now brings the view back down instead of leaving it stranded.

## [0.19.5] - 2026-08-16

### Fixed

- **Turning `pinnedInput` on mid-chat left the prompt stranded in the middle of the screen.** Closing any selector shrinks loop's frame, and the renderer clears the rows it no longer needs where they are rather than pulling the content back down, so the prompt was left sitting wherever the shorter frame ended with a blank gap beneath it — measured on a 44-row terminal as the prompt dropping from rows 39-41 to 27-29 with thirteen empty rows under it. Turning on a setting about where the prompt sits and watching the prompt move away from the bottom is the worst possible moment for it, so `/settings` now repaints from scratch on the way out when that setting was touched, which reprints the frame whole and scrolls its last line back onto the last row. The same gap appears after any selector closes and always has; this fixes the case where it directly contradicts what you just asked for.

## [0.19.4] - 2026-08-16

### Fixed

- **A pinned prompt no longer costs you the mouse.** Turning `pinnedInput` on took text selection away: loop asked the terminal for mouse reporting so the wheel would reach it, and a terminal that is reporting the mouse does not treat a drag as a selection — so drag-to-select silently stopped working for the whole session, and the only ways back were a modifier key or `/select`. That trade was never worth making, and it turned out not to be necessary: grok's TUI has a fixed prompt, native selection and native scrolling at the same time, because it does not own the scroll at all — it prints the transcript into the terminal's real scrollback and keeps only a small live region at the bottom. loop now asks for no mouse modes whatsoever outside `Tab`'s entry navigation, which is a mode you enter and leave rather than a session-long state. Selection, the wheel and your terminal's scrollback all behave exactly as they do with the setting off.

### Removed

- **The transcript window, and everything built on top of it.** The window loop was clipping the transcript into was scrollback taken away from the terminal, which is what made the mouse capture necessary in the first place. It is gone, and with it the `▲/▼` clip indicators, the `PgUp`/`PgDn`/`Home`/`End` transcript scrolling, the jump-to-live-edge on send, and `/select` — every one of which existed only to give back, badly, something the terminal was already doing well. Scrolling is the terminal's scrollback again. `Tab` still opens the full entry navigation, which keeps its own window and its own keys.

### Known

- **`pinnedInput` does not hold the prompt down yet.** What is left of it pads a short transcript, and a real session outgrows that within the first screenful — measured at 21 rendered lines against 16 rows of space during startup alone — after which the setting has no effect and the prompt sits wherever the transcript leaves it, exactly as it does with the setting off. Holding it down for real needs the other half of grok's design, committing settled transcript lines to scrollback so the live region stays smaller than the screen; that is the next piece of work. This release is worth having on its own because it takes the mouse back.

## [0.19.3] - 2026-08-16

### Added

- **The pinned prompt knows how to get you back to the live edge.** Three ways, because scrolling away from a running turn is the normal thing to do and there was no way home short of wheeling back the same distance you came. Sending anything returns the window to the newest line first — a message submitted from two hundred lines up used to be answered entirely below the fold, which made the send look like it had done nothing at all. `End` on an empty prompt goes there deliberately, and `Home` goes to the top; `PgUp`/`PgDn` page as before. All four belong to the transcript only while the prompt is EMPTY — the moment there is a draft the editor takes them back, because it needs them to move around a long message. `Esc` is deliberately not one of them: it is the interrupt, and a key that kills your turn when you meant to scroll back to it is not a key worth having.
- **`/select` hands the mouse back to the terminal for one selection.** A terminal that is reporting the mouse does not treat a drag as a text selection, which is the standing cost of a pinned prompt, and the only way to copy a line out of the transcript was to turn the setting off and on again. `/select` drops mouse reporting until your next keystroke: select, copy with your terminal's own shortcut (which sends loop nothing), and the wheel is back the moment you type — which is exactly when you stopped wanting the selection.

### Fixed

- **Resizing no longer walks the transcript away from what you were reading.** The scroll position was a line index, and a width change re-wraps every line underneath it, so the same number silently came to mean a different place: measured on a transcript of wrapped messages, narrowing from 70 to 46 columns moved the top of the window five entries, to 34 nine entries, and to 26 fourteen — further the harder you resized. The window now remembers the entry at its top and re-finds it after the reflow, so the most it moves is onto the start of the entry that was straddling the edge. A window that was following the live edge is unaffected; it was already going to land in the right place.

### Changed

- **`scripts/tui-probe.py` drives the TUI in a real pty.** Every bug in the pinned prompt so far has been invisible from inside the process — a request for wheel reports wiped by a startup cleanse, a terminal left reporting after a clean quit, a layout that only pinned once the transcript was tall enough. They are properties of the byte stream between loop and the terminal and of where things land on a fixed-size screen, so they need a terminal to see. Four checks (`screen`, `modes`, `exit`, `wheel`) against a throwaway HOME, each with a verdict rather than a wall of output. It also refuses to draw the obvious wrong conclusion: a prompt sitting on the bottom rows proves nothing on its own, since a full transcript scrolls the terminal and puts it there regardless, so what it actually reports is whether the transcript is a clipped window that loop is scrolling itself.

## [0.19.2] - 2026-08-16

### Added

- **The prompt can hold the bottom of the terminal.** `"pinnedInput": true`, or the **pinned input** row in `/settings`, stops the transcript from growing the screen and turns it into a window that scrolls underneath a prompt that never moves: the mouse wheel any time, `PgUp`/`PgDn` while the prompt is empty (a draft in it keeps them for paging through the draft), and it follows the newest line again the moment you scroll back to the bottom, so a turn streaming in does not drag the view off whatever you had stopped to read. The window is exactly as tall as the rows the rest of the screen is not using, measured every frame rather than assumed — the editor grows a row per line of draft, and the loader, the todo panel and queued messages come and go mid-turn, so a fixed guess is the difference between a pinned prompt and one shoved off the bottom by its own chrome. A short or empty session pads instead of clipping, because a promise about where the prompt is that only held once the transcript got tall enough would put the prompt under the banner on a fresh session and sink it to the bottom at some unannounced message count; the transcript sits at the bottom of that window, so the newest line stays next to the caret. `Tab` still opens full entry navigation on top of it. Off by default, and worth knowing before turning it on: loop has to ask the terminal for wheel reports while this is on, and a terminal that is reporting the mouse stops treating a drag as a text selection — most need Shift held to select, iTerm2 and Ghostty need Option.

### Fixed

- **A terminal loop has quit no longer answers the mouse with garbage.** Teardown reset the kitty keyboard protocol, `modifyOtherKeys` and bracketed paste unconditionally, and mouse reporting not at all — it removes the exit safety net before it starts, so whatever it misses there is not reset by anything else on a clean quit. This was invisible for as long as the only thing that ever turned mouse reporting on was navigation mode, which also turned it off on its way out; a prompt pinned for a whole session holds it until teardown, at which point the shell inherits a terminal that answers every scroll and every click with a raw `\x1b[<64;20;5M` on the command line. Reset now, in the same unconditional spirit as the two keyboard protocols beside it and for the same reason.

## [0.19.1] - 2026-08-15

### Changed

- **The desktop app stops working when you are not looking at it.** Four things ran on a timer regardless of whether anyone could see the result, and on a laptop that is the difference between an app you leave open and one you close. A thread that is running re-read its diff every second and a half — a real `git diff` subprocess each time — behind a hidden window, on another Space, or with the lid shut; the elapsed-time labels on running threads and streaming turns each ticked once a second forever; and the git progress toast kept counting for a toast nobody was reading. All four now stop with the window and catch up the moment it comes back, so leaving the app open in the background costs close to nothing. A backgrounded window is throttled by the browser but not stopped, and work it hands to a subprocess is not throttled at all, which is why this had to be handled rather than left to the platform.
- **A preview tab you are not looking at goes to sleep.** Inactive preview tabs were moved offscreen but deliberately left CSS-visible, which is not the same as hidden: as far as the renderer is concerned the page is still on screen, so it kept running its animation frames, servicing its timers and keeping a compositor busy — three background previews of a dev server cost about what the same three pages cost open in a browser, for as long as the app is running. They are now genuinely hidden, which lets the renderer throttle them the way it throttles a background tab. The exception is a guest something is still reading: a tab being recorded, or one the agent is driving through preview automation, stays awake, because those read tabs that are not on screen and a hidden page will not answer them. Note that a sleeping preview knows it is hidden — a page playing video will pause it until you switch back.

### Fixed

- **A chatty terminal no longer burns a core rebuilding its own scrollback.** Every chunk a shell produced rebuilt the entire 256KB scrollback buffer as a new string, twice — once to append and once to trim. That is invisible at a prompt and severe under anything that writes continuously: an install or a build emits thousands of small chunks a second, so the work grew with the length of the buffer rather than the size of what arrived, and a single noisy terminal could hold a core at full tilt and keep the garbage collector busy behind it. Scrollback is now kept as the pieces it arrived in and collapsed only when it outgrows its cap, which is the same answer for a few hundred times less work — measured at roughly 570× faster over a realistic build's worth of output, and about 100GB less memory allocated and immediately thrown away.
- **A recording that starts on a preview tab you are not watching still captures its first frame.** The index of which tabs are recording was published only after startup finished, though the recording is registered well before the screencast begins. Nothing depended on the ordering until preview tabs began sleeping, at which point it would have let a tab go to sleep during the exact window its recording was waiting for a frame.
- **The command palette no longer re-renders every two seconds while it is open.** It polls for locally-attached backends, and the poll returned a freshly-built list every time even when the answer had not changed, which was enough to redraw the whole palette — the most expensive surface in the app to redraw — twice a second for nothing. The web build, which never has any such backends to find, was doing this too. The poll now reports a change only when something has actually changed.
- **Moving the mouse no longer makes the compositor wait on the main thread.** The listener that notices you are active was registered on `pointermove` and `keydown` without marking itself passive, unlike the scroll and touch listeners beside it, so the browser had to assume every one of those events — at the pointer's full sample rate — might cancel the gesture, when the handler only ever stamps a timestamp.

## [0.19.0] - 2026-08-15

### Added

- **Ask the desktop app to check for updates, from wherever you are.** The update pill only appears once there is already something to install, which is right for news but leaves no way to _ask_ — until now the only ways to find out were to wait up to six hours for the automatic check or to quit and reopen. There are three ways in, and they are the same action: a **Check for updates** row at the bottom of the sidebar, a **Check for updates** entry in the command palette (found by "upgrade" or "version" too, since that is what people search for when they do not know the app calls it a check), and the button in **Settings → General → About**. Every one of them reports what happened, including finding nothing: a check that says "loop is up to date" is the whole point of pressing the button, and a control that answers only when something is wrong is indistinguishable from a broken one. An update already downloaded and waiting for a restart is reported as that, rather than as the "nothing newer" this particular check found. All three are absent in the browser build and in a development run, neither of which can replace an install.

### Fixed

- **The Check for Updates button in Settings did nothing at all.** It has been there for a while and it never once worked. The row reads its state through loop's own bridge, so it rendered correctly and looked live — the version, the button, the enabled state, all right — but the click handler reached for `window.desktopBridge`, the upstream global that loop's shell deliberately does not expose (exposing it would flip the renderer into upstream's desktop mode and route auth and connection setup down paths this app has never had). The handler found nothing there and returned, silently, on every press. It now uses the same bridge the rest of the update UI does.
- **A manual check can no longer look like a no-op when it genuinely did nothing.** The main process reported every check as having run, including the two cases where no request goes out: a build that was not installed by the updater, and a check that was already in flight. The first now says so plainly instead of implying you are up to date, and the second stays quiet and lets the check already running do the reporting, rather than showing you two answers to one question.

## [0.18.16] - 2026-08-15

### Added

- **`loop run` can be read by a program.** `--output-format json` prints a single object when the run ends — the reply, the session id, the model, the step count, the duration, the token usage and the cost — and `--output-format stream-json` prints one JSON object per line as the run happens, driven by the same exhaustive event list the RPC server forwards, so an event added to the agent loop appears here without anyone having to remember this file. Until now the only structure a script could get was `[tool:name] {...}` lines scraped out of stderr, which was neither stable nor complete. In both JSON formats stdout carries JSON and nothing else: the model's text, hook messages, and a hook's terminal escape sequences become fields or events rather than being written through, so a hook that sets the terminal's background colour can no longer corrupt the parse. A failure before the turn starts — an unknown `--session`, no model selected — is reported as a result object too, instead of as prose on stderr and no output at all.
- **Run mode says which session it made.** On stderr, before the turn, so a run that dies halfway still tells you what to pass to `--session` to pick it back up. Chaining a second `loop run` onto the first was previously impossible.

### Changed

- **An invocation loop does not understand is refused, not reinterpreted.** `loop sesions` opened an interactive chat session, because every unknown command fell through to the TUI; `loop run --modle gpt-5` ran the whole turn on the default model and billed it, because an unrecognised flag was kept and then never read. Both now stop, naming the near miss. The parser also learned things it never knew: which flags take a value, so a switch no longer swallows the token behind it (`--all extra` keeps `extra` as an argument); that `--` ends flag parsing, so a prompt may begin with a dash; that a single-dash flag it has never heard of is an error rather than part of your prompt, which is what `loop run -p "…"` had been silently making it; and that flags may precede the command. Commands, their flags and their permitted values now come from one table that the shell completions and the man page read as well, so those three can no longer drift from what the CLI actually accepts — and a test fails if a command in that table has no handler, or is missing from `loop help`. Completion offers each command's own flags rather than one global list. `loop --version` is still disk-free and instant: the table imports nothing.

### Fixed

- **A turn survives the provider dropping its stream.** A 529, a rate limit, or a socket that dies mid-body ended the turn where it stood — on a long turn that is eighteen finished steps of work discarded, every one of them already persisted and already paid for. The turn now reopens the stream over the conversation those steps left behind and carries on: twice by default (`maxStreamResumes`; 0 restores the old behaviour), with a jittered backoff, because a provider-wide overload means every client saw the same error at the same moment and a fixed delay walks them all back in step. Ctrl+C interrupts the wait. What is retried is deliberately narrow — the SDK's own verdict on an error decides, in both directions, so a provider that says "do not retry this" on a 5xx is believed, and an unrecognised error is not retried at all: a bad request, a bad key, or an over-long context fails once and says so rather than being paid for three times. A resume only ever happens _between_ steps. With half a sentence already on screen the model would regenerate it and you would read it twice, so that case reports the error exactly as it always did. A turn that recovers reports no error at all — it says that it is retrying, and then gets on with it.
- **Leaving navigation gives you your view back.** Expanding is a navigation affordance: `e`, →, and Enter only exist inside it. The opens survived the trip back to the prompt anyway, leaving the transcript in a shape you never chose and had no way to undo, since those keys are gone the moment you are typing again. Everything now returns to the mode's own default on the way out — groups closed, tool output folded, per-block overrides dropped. The larger half of the same bug was underneath it: leaving navigation turned the live variant _off_ unconditionally, ignoring the `uiLive` setting, so anyone who works in live mode was dropped out of it every time they left — which reads as the transcript un-grouping itself. It now returns to the live state you actually chose.

## [0.18.15] - 2026-08-15

### Fixed

- **Sending a message in the desktop app lands where you would expect it to.** Sent from halfway up a thread, the transcript stayed exactly where it was and the reply streamed in off-screen; sent from the bottom, it sometimes walked _up_ instead — and the second one only happened when the message you had just typed ran to more than one line, which is what made it look random. Both were the same defect. The transcript treated every loss of the live edge as "the reader scrolled away" and dropped out of follow mode, but the list reports that for two unrelated reasons, and a send triggers the harmless kind three times over: the message lands, the reply streams, and the composer collapses back to one line as its draft clears — that last one moving the view by exactly the height the composer gave up. Follow mode was torn down one frame before the correction that would have re-pinned it ran, so the correction read the teardown and refused to move. Position now only ever opts _in_ to following the stream: reaching the live edge by any means resumes it, and only an actual scroll gesture hands the view back. Dragging the scrollbar counts as one — clicking a tool call or selecting text in a reply still does not, which is why it was not simply reinstated.

## [0.18.14] - 2026-08-15

### Fixed

- **One leftover `Loop.app.old` could stop the desktop app updating, permanently.** Cleaning up the previous copy after a swap is best-effort by necessity — the app is still running out of it when that runs, so a leftover backup is the normal state after any update. Deleting that backup was then the first thing the _next_ swap did, unguarded, so the moment one would not delete, every update afterwards failed on its first line with `ENOTEMPTY … Loop.app.old/Contents/Resources` and nothing was ever swapped. Re-downloading could not help: the download was fine, the swap never started. Removing the old backup is still attempted, but a failure now moves the swap aside to a free name and carries on, sweeping what it could not remove on a later run. Every tree removal also retries the errors that mean "busy right now" — the ones `fs.rm` documents `maxRetries` for — so a bundle that is merely open or being indexed no longer reads as permanently stuck.

## [0.18.13] - 2026-08-15

### Added

- **Artifacts open beside the chat that made them.** A new artifact used to leave nothing in the transcript but whatever the model chose to type — usually a raw `file:///Users/…/index.html`, unclickable in a terminal and, in the app, a string sitting next to nothing that opened it. The model is no longer told that URL at all; it goes to the renderer, which draws a card you click. It opens in the right panel, next to Browser, Terminal and Files, rather than in the OS browser or by navigating away from the conversation you are reading it against. The panel's "+" menu also gains an Artifacts surface listing what this chat has produced — scoped to the session exactly, translating the thread's id the way every other call to loop does, so a thread whose ids have diverged still finds its own work.
- **More kinds than a web page.** Alongside `html`, artifacts can now be `markdown`, `svg`, `json`, `csv` or `text`, and the app renders each properly — markdown as prose, JSON pretty-printed, CSV as a table — instead of showing you its source. The split that governs this is not the file extension but whether the content can execute: `html` and `svg` can carry script and are shown only inside a sandboxed view with its own partition and no preload, while the inert kinds are rendered by the app itself. `svg` counts as executable, which is the part that is easy to get wrong.
- **Download a copy, from either client.** A download button on every artifact row and in the viewer, and `loop artifacts export <id> [dir]` plus a Download action in `/artifacts` for the terminal. On disk every artifact is `index.<ext>` so a path follows from its kind; exporting is where the title becomes the name, so a Downloads folder gets `q3-revenue-report.html` rather than a fourth `index.html`. It never overwrites — a second export is `report-2.html`.

### Changed

- **Live mode folds edits and writes too.** The rule is simpler than it was: everything folds — reads, listings, searches, commands, edits, third-party calls — except the surfaces you have to act on, `ask` and `plan`, which a count would hide. The detail is still one key away.
- **Artifacts never cross the network.** `loop serve` binds every interface by design, and an artifact is a page the agent wrote out of the contents of a repo, so the whole `artifact.*` family is refused over it. That is a property of the server rather than a habit of one UI: the bytes are never sent, not merely never rendered.

### Fixed

- **An artifact card survives reopening the thread.** loop keeps a tool's UI payload out of the model's context, and the SDK persists the model-facing value — so the card appeared while the turn ran and was gone the next time the thread was opened. It is now rebuilt from the summary, which still names the artifact, and a card needs nothing more: it opens by id.

## [0.18.12] - 2026-08-14

### Added

- **Artifacts: the agent can write you a page, and you can open it.** Ask for a report, a summary or a write-up and the result no longer has to land as a file in your repo or as a wall of text in the transcript. The agent reserves an artifact, gets an ordinary path back, and writes it with the same `write` and `edit` it uses for everything else — so permission rules, hooks and the diff view all apply unchanged, and revising an artifact is an edit rather than a re-publish. They live under `~/.loop/artifacts`, outside any working tree, so a report drafted in a repo still opens after that repo is cleaned or switched branches. The metadata sits beside the content rather than in a database: nothing can list an artifact that is no longer on disk, and copying the folder copies the artifact. `/artifacts` in the terminal lists them and opens one in your browser; `loop artifacts` prints them for scripting. The desktop app gets an Artifacts page in the sidebar with search, pagination, and its own browser pane to read them in. **Off by default** — turn it on in `/settings`, or from the app's Artifacts page, which asks rather than showing an empty list it can never fill.

### Changed

- **Live mode folds commands and third-party calls too, and stops guessing what a tool does.** A run of bash commands, MCP calls or extension tools now collapses into the same one-line header reads and searches already did — only edits keep their own rows, because which file changed is what gets reviewed. The bigger fix is underneath: an unrecognised tool used to be classified by reading a verb off its name, which made folding a lottery on spelling — `sentry__list_errors` folded and `sentry__get_error` did not, from one server in one run — and borrowed a builtin's noun on the way, so a run of Sentry lookups rendered as "Listed 2 dirs". A tool we did not write is now described by the only thing we actually know about it, where it came from: "Called 2 MCP tools". Extensions that want a builtin's grammar can still say so explicitly. loop's own tools are named properly rather than falling through — `sql`, `ask`, `plan` and `enter_plan_mode` had all been missing from that table.

## [0.18.11] - 2026-08-14

### Added

- **The desktop sidebar comes in three shapes, and one project is now the default.** The panel used to be one list of every thread under every project. It can now be that, or a list of folders you open one at a time, or — the new default — one project filling the panel with its threads sectioned by what they need from you: waiting on you, working, recent, settled. Settings → Appearance → Sidebar style switches between them and every option says what it gives you. The shapes differ in what the panel is a list of, not in how a row looks: a row says the same four things everywhere, and it says more than it used to. A thread now carries its real state — pending approval, awaiting input, working, plan ready, completed-and-unread — in the same colours the command palette has always used, so a thread blocked on a question stops looking exactly like an idle one. It carries its branch too, and marks a worktree, so two threads on two branches of the same repo are finally distinguishable. Threads waiting on you are lifted out of their folders into a shelf of their own, oldest ask first, and that shelf stays cross-project even in the one-project view — nothing can sit blocked in a folder you are not looking at. "Settled" now means settled: the thread's own `settledAt`, snooze and override, rather than "everything past row twenty".
- **A queued message can be sent now, without losing it.** The terminal has always had this — Esc stops the turn and what you typed while it worked goes next — while the app could only wait. A message sat behind a turn you had already decided was going the wrong way, and the only way to act on that was Stop, which threw the message away with it. Each queued row now offers to stop the running turn and send that message instead.
- **Project controls, in every sidebar shape.** loop's own project lists could only ever be added to: renaming and removing a project existed in the inherited sidebar and nowhere else, so a folder added by mistake stayed forever. Every project row now carries new thread, rename, copy path and remove — on right-click as well as on a menu — and renaming happens in the row rather than in a dialog. Removal keeps its confirmation and says how many conversations go with it. Thread rows answer a right-click too, with settle, archive, copy path, copy branch and delete, and archive is one click on the row itself.

### Fixed

- **Restarting after an update works on macOS, and no longer silently reverts on Windows.** The app relaunched itself by executing the binary inside its own bundle — a launch macOS never performs itself, and the bundle had just been replaced on disk, so the app quit and nothing came back. It now asks macOS to open the bundle the way a double-click does. Windows was worse than a failed restart: the swap helper waits for the app to exit before moving any directory, but the app relaunched itself on the way out and re-locked the install directory a moment before the helper tried to move it — so the move failed, the helper restored the backup, and the update reverted while reporting success. Windows now quits and leaves the relaunch to the helper, which is what the helper was always for.
- **`/steak` and `/cost` belong to the theme.** Their headings and figures were painted bold in whatever foreground the terminal happened to use, so those blocks ignored `/theme` and `/uimode` entirely and stayed put while everything around them moved — most visibly against the heat grid underneath the steak wall, which was themed the whole time. `/doctor` and `/context` had the same defect in four more places. All of them now read from the theme's own heading colour.

## [0.18.10] - 2026-08-13

### Fixed

- **An MCP server can be signed into again, at any time, in both the terminal and the app.** The authorize action was offered only to a server that had already broken — `needs-auth` or `error` in `/mcp`, and in the app only to one whose config carried `auth: "oauth"`. So a server that signed in once had no way back in, which is precisely the wrong shape for OAuth: the session expires on the provider's clock, the status still reads "ready", and every call is being refused. Signing in is now offered to any server it could apply to — configured for OAuth, or asking for auth, or signed into before — and reads "re-authorize" when it is replacing a session rather than starting one. A server added as a plain URL, which is how most are added, is covered: only the 401 on first connect ever says it wanted OAuth.
- **Signing in no longer needs a connect first.** The settings page lists servers from disk without connecting — connecting costs up to 30 seconds per server — so the login refused with "reconnect first" for anything this process had not already reached. The config on disk is all a login needs, and the project's path travels with the request so a project-scoped server is found too.

## [0.18.9] - 2026-08-13

### Added

- **The desktop app folds runs of tool calls, and you open the ones you want.** A turn that reads six files put six rows between the question and the answer, and none of them was what anyone came to read. A run of finished calls whose individual detail is noise — reads, listings, searches, subagents — is now one row saying what the run did, "Read 3 files, Listed 1 dir", which opens on a click to the real rows underneath. It is the same fold the terminal's live mode makes and it speaks the same vocabulary, so the two surfaces describe a run identically. The rules carry over with it: a command or an edit keeps its own row because which command ran is the point, a tool the vocabulary cannot classify stays visible rather than being hidden under a label that might misdescribe it, a call still running is never folded away, and a header that hides a failure says so.

## [0.18.8] - 2026-08-13

### Fixed

- **A tool call in live mode keeps its own row until it finishes.** 0.18.6 folded a running call into its group header to hold the transcript's height still, which meant a call was hidden for exactly as long as it was the one thing worth watching — the group said "Reading 3 files" without saying which. Live mode is the base look plus folding, so a call in flight now renders the row noir renders normally, naming the file and its status, and joins the header the moment it lands. The height moves as a turn streams; seeing the live call is worth it.

### Changed

- **The desktop app ships only when the desktop app changed.** Every tag repackaged five Electron bundles across five runners whether or not a line of the app had moved, which is most releases, since the CLI is what usually changes. The release now builds the desktop matrix when `apps/desktop`'s own version has moved since the previous tag (or on demand from the workflow), so a CLI-only release publishes binaries alone. `install-desktop.sh` and `install-desktop.ps1` walk back from the latest tag to the newest release that actually carries a build for your platform, so installing is unaffected; pinning a tag with `--version` never falls back, because a pin is a request for that exact build.

## [0.18.7] - 2026-08-13

### Changed

- **The desktop app's dark theme is one surface hierarchy, and the terminal is part of it.** The workspace, the panels and the terminal each carried their own hand-written grays, so the terminal read as a different application sitting inside this one — and every time the palette moved, it stayed behind, because its colors were written into the renderer's TypeScript rather than read from the theme. The terminal now takes its surface, its ink, its cursor and its selection from the same CSS tokens as everything else, so it is a panel like the sidebar is a panel and it follows any future retune on its own. Its ANSI sixteen are VS Code's terminal defaults, which separate the yellows and greens that `git status` leans on; the muted set they replaced was mixed for a black background and went flat on a lifted one.

### Fixed

- **The terminal cursor is no longer blurry.** The canvas is scaled by the display's pixel ratio and a cell is a fractional number of CSS pixels — 7.2 at the default size — so filling the cursor at its raw offset put the block's edges mid-device-pixel and the browser anti-aliased them. Measured across one pixel row, the cursor came out as fourteen solid columns plus one at 48% alpha, and because the fraction changes with the column, that soft edge crawled from side to side as the cursor advanced. Both edges are now snapped onto the device grid, which also keeps each block flush with the next cell rather than leaving a gap or an overlap. The glyph inside a block cursor is deliberately left unsnapped: text is positioned sub-pixel everywhere else, and rounding it here would shift the character sideways the moment the cursor landed on it. Outlines and bars are one device pixel now, so they stay hairlines on a retina panel instead of drawing double-thick.
- **The whole title bar drags the window, not just the sidebar's corner of it.** Every header asked whether `window.desktopBridge` existed to decide if it owned window chrome, and this shell has never exposed that name — it exposes `window.loop`. So the test was false everywhere it was asked, and the chat header, the right panel's tab strip, and the diff and preview panel headers were all dead to a drag; only the sidebar header, which asked the right question, worked. They ask one flag now, named for what it actually means.
- **An HTML file opened in the browser panel loads, and its stylesheets and images load with it.** The panel was handed a `blob:` URL minted in the app's own document, and the panel's guest is a separate web contents on its own session — it cannot resolve one, so the page came back not found. Even had it loaded, every relative stylesheet, script and image would have resolved against `blob:` and failed too. Local files are opened by path now, so a generated report renders the way it does in a browser, reload works, and the address bar shows where the page came from. PDFs render in the panel instead of downloading.
- **Following a link from a reply opens it in the panel, and reuses the tab.** A link in the transcript went to the system browser on a plain click, with the panel reachable only through the right-click menu — and each open minted a new tab, so following three links from one answer left three tabs of the same trail behind. A click now lands in the panel's current tab, the way a browser behaves; a modified or middle click still goes out to the real browser, and the "+" button is what makes a new tab.
- **Sending a message returns to the bottom of the transcript.** Both send paths recorded the intent to follow the live edge and then never moved the list, leaving that to the stick-to-bottom behaviour — which only holds a transcript that is already at the bottom. Sending from halfway up a long thread stayed exactly where it was while the reply streamed in off-screen.

## [0.18.6] - 2026-08-13

### Fixed

- **The transcript stops twitching as a turn streams in live mode.** Every tool call changed the height twice: it popped out its own row while running, then vanished into the group header the moment it landed, so a turn of four reads moved everything above it eight times. A running call now counts toward its group and the header reads present tense — "Reading 3 files" — so the count increments and nothing moves. Measured across a four-call turn, the transcript holds exactly one height from the first call to the last. Which file is being read is no longer visible while it reads, which is the trade: only kinds whose detail is noise group at all, and a command or an edit still keeps its own row.

## [0.18.5] - 2026-08-13

### Changed

- **Live is a variant of a mode, not a mode of its own.** 0.18.4 registered "live" beside "loop" and "noir", which put a second entry in the picker for something you reach with a key, and let a mode's live look drift from its normal one. A mode now declares its own live variant and ctrl+e switches between them, so live can only ever add to the mode you are already in — noir has two variants, loop has one. `/settings → uiMode` asks which variant after you pick a mode with more than one, and remembers it as the one you start in.

### Fixed

- **A billion tokens reads as `1.4B`, not `1000M`.** The token formatter stopped at millions, so crossing a billion just kept counting up in four-digit Ms. It also never carried between the tiers it did have — 999,600 rendered as `1000k`. Both are fixed, and the formatter itself now lives in one place: it had been copied into five (the status line, the statusline extension, `/context`, `/steak`, the Telegram renderer), which is why the ceiling was wrong in all of them at once.
- **A denied search says which rule denied it.** Grep fetched ripgrep before checking whether the path could be read at all, so on a machine without it the answer to a blocked search was "ripgrep is not available" — the wrong reason entirely. The rule is checked first now, which also means a path you were never allowed to search no longer triggers a download to find that out. The deny itself always held; only the message was misleading.

## [0.18.4] - 2026-08-13

### Added

- **The transcript has a left rail that shows what is happening.** Every block now hangs off a vertical line, and that line carries the block's state as motion rather than as more text: while a call runs a wave travels down it, and if the call has stopped to ask you something the wave freezes into a slower pulse, so "working" and "waiting on you" are never the same thing on screen. The bullet pulses in step with the top of its own rail, so the two read as one mark. When a call lands the rail settles static in its outcome colour and stays there — green for a call that worked, red for one that did not — held down toward the background so a long transcript reads as a calm ladder and only the live rail sits at full strength. The frame clock runs only while something is actually running, so an idle prompt costs exactly what it did before.
- **A live mode, on ctrl+e.** The transcript holds the keyboard, the prompt keeps its place, and runs of finished tool calls fold into one aggregated line — "Read 1 skill, Listed 2 dirs, Searched 1 pattern" — naming every kind with its own count instead of an anonymous total. A hidden failure is still reported on the header, because folding must never be a way to lose bad news. That makes the transcript a two-level fold: → opens the group to show which calls it was, → again opens a call to show what it returned, and ← walks back out the same way. Opening a call no longer makes its siblings snap shut. It carries the same palette as noir, so flipping in and out mid-turn changes the frame and the folds and nothing else.
- **Leaving prints the command to come back.** A session's id is the only handle on it, and it was never shown anywhere you could copy it from once loop had exited — you had to go and find it in `loop sessions`. Closing now leaves `loop --session <id>` in your scrollback, which is exactly where you want it the moment you realise you have just closed the thing you needed. Nothing is printed for a conversation that was never saved, since it has no id to resume by.
- **Calls whose detail is the point keep their own rows.** Reads, listings and searches fold, because which four files were read is rarely what you want to know. A command or an edit does not, because which command ran is the entire information. Tools from extensions and MCP servers degrade sensibly rather than disappearing: one that names itself plainly (`search_issues`, `list_repos`) is classified and grouped, one that does not keeps its own visible row, and a tool can declare its own grammar to be grouped precisely. An unrecognised tool staying visible is the safe failure — a slightly longer transcript beats silently hidden information.

### Fixed

- **cmd+→ no longer drops you into the transcript.** Ghostty binds cmd+→ to the same byte legacy ctrl+e sends, and nothing told the two apart, so reaching for the end of a line kept flinging you into navigation. Under the modern keyboard protocol a real ctrl+e arrives as its own sequence and only a terminal shortcut still sends the bare byte, so the bare byte no longer counts as ctrl+e there. Terminals without that protocol are unaffected.
- **The vertical bars render as continuous lines in macOS Terminal.** The selection bar and the welcome banner's rule are block-element glyphs, which Terminal's default font draws short of the cell — so both came out as columns of separated ticks rather than one bar. They are painted as a background there, which fills the cell and cannot gap. The transcript's rails use box-drawing glyphs instead, which every font tiles, since a full-cell background is far too heavy a mark for a hairline.

## [0.18.3] - 2026-08-12

### Fixed

- **Adding a project in a folder that does not exist yet works.** The picker offers "Create & Add" as soon as the typed path has nothing at it, and nothing ever created the folder — the only filesystem step in the flow was the check that validates one, which answered "no such folder", so the add failed with "loop could not run project.create" every time. The folder is now created, then resolved the same way an existing one is, so the project records the real path rather than what was typed.
- **A command that fails says what went wrong.** The toast reported only which command failed — "loop could not run project.create" — and threw away the sentence underneath it, so a permissions error and a typo in a path looked identical. The reason now travels with it.
- **Editors installed as applications are detected, not just ones on PATH.** An editor dragged into /Applications has no `code`-style shim until its own "install the shell command" action is run, so "Open in…" listed VS Code as missing while it sat right there. The menu now also looks inside installed .app bundles, and opens the one it found. Where a fork ships the same command — Cursor carries `code` as well as `cursor` — the app named after the command wins, so picking VS Code no longer opens Cursor.

## [0.18.2] - 2026-08-10

### Added

- **The browser's address bar remembers where it has been.** Type "local" and it completes to `localhost:3000`, with only the guessed part selected so the next keystroke replaces it rather than appending to it, and a list of matching pages sits underneath — ranked by how the query matches (the URL from the start, then the host, then anywhere in it, then the page title) and then by how often and how recently each was visited. Focusing the bar with nothing typed offers recent pages. History is kept per environment, so one project's local servers stay out of another's suggestions, and only pages that actually loaded are remembered: a URL that never resolved is not somewhere you have been, and should not come back as a suggestion.
- **The Annotate button in the browser panel works.** It never did — the desktop shell answered the request with a rejection, and the panel treats a rejection as a cancelled pick, so the button lit up and went out again with nothing to show for it. Hovering now highlights the element under the cursor with its tag and size, clicking sends it to the chat composer with a screenshot cropped to it, the arrow keys widen and narrow the selection when the deepest element is not the one you meant, and Escape or a second press of the button cancels. The page cannot react to the click that picks, so a link no longer navigates out from under the screenshot. Regions, freehand drawing and elements inside iframes are not covered.

### Fixed

- **Searching the Files panel and then collapsing one of the matching folders no longer throws the search away.** The filter vanished, the text disappeared from the box, and the tree sprang back to its unfiltered self — and the folder did not collapse either. The tree's own search assumed it owned the search box, closing itself on any click on any row, and it re-applied its expansion on every change including the collapse it had just been given. Both are patched. The search box also keeps what you typed: it used to echo back a lowercased version, so "README" became "readme" as you typed it.
- **The window opens at the size of the screen** instead of a fixed 1440x900, which on a larger display left the app in a small box in the middle of it.

## [0.18.1] - 2026-08-09

### Changed

- **The diff panel is plainer.** The source-control sidebar introduced in 0.18.0 is gone, and so is the scope picker that offered "working tree", "branch changes" and a turn to compare against. What is left is the diff, one revert button on each file's header, and a commit control at the top — which is the same control the chat header already carries, so committing has one implementation and one set of behaviours rather than two. Turn-scoped diffs assume changes are followed turn by turn, which is not how this is worked on; the panel shows the working tree.
- **A folder of repositories opens several times faster.** Every row in that list is one repository, and building it went through the full status read — seven `git` invocations each, answering questions about remotes, upstreams and default branches that a row showing a name and a file count never asks. A row now costs two. Separately, counting changes no longer enumerates every untracked file: a repository holding an unignored `node_modules` was being walked in its entirety to produce a number, and an untracked directory now counts as the one entry it is. Measured on a thirty-five repository folder: 1100ms to roughly 300ms, and on the worst single repository in it, 533ms to 178ms.

### Added

- **Discard a file from the diff itself**, with a revert button on the file's header, rather than through a separate surface. It appears only where it can mean something — a working-tree scope in a real repository, never over a historical turn diff — and asks first, because git keeps no copy of a working-tree edit it has thrown away.

## [0.18.0] - 2026-08-09

### Added

- **Source control in the diff panel.** A repository's diff tab now has a Source Control toggle at the top. Turned on, it opens a sidebar down the right-hand side listing what has changed, split into Staged Changes and Changes the way an editor's source-control view does — and a file that has been staged and then edited again appears in both, each row showing only that side's line counts. That last part was impossible before: the panel read the working tree and the index fused into one answer, so it could only ever show a flat list of files with no notion of what was about to be committed.
- **Stage, unstage and discard**, per file or per group, from buttons that appear on a row as you reach it. Discarding asks first, because git keeps no copy of a working-tree edit it has thrown away.
- **Commit and Commit & Push**, from a message box at the foot of the sidebar. It commits what is staged and nothing else — it will not quietly sweep in a file that was deliberately left out — and reports git's own words when a hook or a missing upstream stops it.
- **Clicking a file shows that file**, and shows it whole: the source-control view asks git for the entire file with its changes marked inside it, rather than the usual three lines of context around each hunk. Comments, annotations and every other affordance still work, because the patch goes through the same renderer the review pane has always used.
- **Merge conflicts are recognised** as their own group, rather than being mixed in with ordinary changes where the staging buttons would not mean anything.
- **Opening a repository from a folder of repositories opens it as its own tab**, instead of navigating in place — so two repositories can be compared without losing the first. Such a tab drops the scope picker and the back link, neither of which has anything to say about a single repository.

### Fixed

- A folder of repositories no longer flashes "Working tree" for a frame before replacing it with "Repositories".
- A panel tab whose kind no longer exists is discarded on load, rather than coming back as an empty tab over a blank panel with no way to close it.

## [0.17.1] - 2026-08-09

### Fixed

- **Launching loop when it is already running raises the window it already has, instead of starting a second copy.** Nothing stopped a second instance, so opening the app again — from the Dock, from Spotlight, or by anything scripted running `open -a Loop` — left two icons and two entirely separate applications. The duplicate icon was the visible half. Underneath it were two cores answering RPC, two sets of terminals drawing on the same system-wide pty pool, and two processes writing the same session database, which is the half worth caring about. A second launch now brings the running window forward, restoring it first if it was minimized. Running a deliberately separate profile is unaffected.

## [0.17.0] - 2026-08-09

### Added

- **The desktop app updates itself.** When a newer release exists, a row appears above Settings in the sidebar: click it to download, and when that finishes it becomes a Restart button. No terminal, no reinstall script. It checks shortly after launch and every six hours after that, and when there is nothing to install it shows nothing at all.
- The download is **verified against the checksum published with the release before anything is replaced**, and a mismatch throws the download away rather than installing it. This is the difference between a failed update and no working app left to retry from — the archives are ~170MB and a truncated one that installed would leave nothing behind to fix it with.
- The swap keeps the old copy until the new one is in place, and puts it back if the move fails, so an interrupted update cannot leave the machine without an application.
- All three platforms. macOS and Linux swap in place, which is safe because a running process keeps the files it is using alive under the backup name. Windows keeps a running executable locked, so it hands the swap to a small script that waits for the app to exit, replaces it, and starts it again.
- Updating is off in a development build, where "replace the install directory" would mean renaming a checkout out from under whoever is working in it.

### Note

Electron's own updater is not what does this. On macOS it requires a Developer-ID-signed app and these builds are ad-hoc signed, so it would refuse — the app instead performs the same steps `install-desktop.sh` already did, in-process.

## [0.16.11] - 2026-08-09

### Fixed

- **A thread no longer goes silent for good when loop's core restarts.** loop tracks event subscribers per connection, so when the desktop app's core exits and is restarted the subscription that belonged to the old one is gone. The recovery for this already existed — the thread view re-attaches whenever the connection reopens — but it could never run in the desktop app: the hook it listens on was hardcoded to do nothing there, and the shell was announcing the restart on a channel that stopped dead at the preload boundary with nothing on the other side. Until the window was reloaded the transcript stayed frozen: turns ran to completion and the chat showed none of it, which is exactly the shape of a chat that "only renders once loop stops". The announcement is now delivered and the reattach happens on its own. Verified by killing the core out from under a live thread: the app reconnects within a second and the next turn streams normally.

## [0.16.10] - 2026-08-09

### Fixed

- **The desktop app's terminal opens your login shell, not always zsh.** It read `$SHELL` to decide, and `$SHELL` is only set when a program is started from a terminal — an app launched from the Dock, Finder or Spotlight inherits launchd's environment, which does not have it. So the packaged app fell through to a hardcoded zsh for everyone, and anyone whose login shell is fish, bash or anything else got the wrong one. It now reads the passwd database, the same source `dscl` reports, which is right however the app was started. An explicitly set `$SHELL` still wins.
- **That shell now starts as a login shell on macOS, so your PATH is really your PATH.** The same empty GUI environment that hides `$SHELL` hides `PATH` too, leaving a pane that started from a bare `/usr/bin:/bin`. zsh only reads `.zprofile` — where Homebrew's `shellenv` and most PATH setup lives — for login shells, so the terminal came up looking correct while missing much of what you had installed. Measured here, it went from 10 PATH entries to 18. This is what VS Code and Terminal.app do, and it is applied only to shells known to accept the flag, so an unusual shell still starts rather than failing on an argument it does not understand.
- **Electron's own variables no longer leak into the terminal.** `ELECTRON_RUN_AS_NODE` makes any Electron binary run as plain node, so inheriting it quietly broke Electron-based tools run from the pane — including loop's own desktop app.

## [0.16.9] - 2026-08-09

### Fixed

- **Terminals in the desktop app stopped opening after a few hundred of them, and said `posix_spawnp failed`.** Nothing was wrong with the spawn. node-pty leaks two `/dev/ptmx` file descriptors on every terminal it starts on macOS — its cleanup loop is written so that in the ordinary case it closes nothing, and the parent's end of the pty is never closed at all — and macOS caps the number of ptys for the whole machine, not per process. So the app quietly consumed ptys until there were none left, and from that point every terminal failed, permanently, until it was restarted. Measured here: 242 terminals to exhaustion against a limit of 511 shared with every other terminal program running. The error message was misleading because node-pty reports that same string for five different failures, including the one that was actually happening — running out of ptys. Upgrading node-pty fixes the leak; 700 terminals now come and go leaving nothing behind.
- **A shell that cannot start says so in the pane instead of failing an IPC call.** The shell is spawned when the terminal panel first reports its size, so a failure surfaced as a rejected `loop:pty.resize` — an error naming an internal method, over a pane that then stayed blank forever while every subsequent resize tried the spawn again. The reason is written into the terminal itself now, the pane settles instead of waiting for a shell that is never coming, and reopening it is what retries.

### Changed

- **The Linux desktop build no longer has to be packaged on Linux.** node-pty publishes prebuilt bindings for Linux as of the version this release moves to, so every platform is now cross-packageable from any machine.
- **The model catalog was refreshed from models.dev** — pricing corrections across several Gemini and Vercel entries, and one model upstream has withdrawn.

## [0.16.7] - 2026-08-09

### Added

- **The browser panel actually opens a browser now.** The renderer paints a `<webview>` per preview tab, but a guest webview is driven from the main process — the embedder only gets a DOM element and a `getWebContentsId()`. That main-process half did not exist, and the renderer refuses to mount a webview until `preview.getPreviewConfig()` resolves, so the panel enabled its Browser tab, accepted a URL, recorded the tab, and created nothing: typing an address did nothing at all, silently. It is implemented, along with the navigation, zoom, reload and screenshot IPC behind it. The bridge is read from `window.loop.preview` rather than `window.desktopBridge`, since exposing the latter would flip `isElectron` and route auth, connection setup and the updater down upstream paths this shell has never had.
- **Comments can be left on rendered markdown, not just on source.** A comment is a line range, and rendered prose has no line numbers — which is why commenting only worked in the source view. The mdast positions survive into hast, so every top-level block now carries the source lines it came from and a selection resolves back to a range.
- **A folder of repositories shows its repositories instead of one enormous diff.** Concatenating every child's patch came to 34 repositories and 17k added lines on a real workspace: past the preview cap, slow to parse, unreadable. The rows come from `numstat` counts alone, with the dirty ones sorted up, and exactly one repository's diff is fetched when its row is opened.
- **Images in the Files panel load.** `assets.createUrl` had nothing behind it — upstream mints a URL against its own HTTP server, which loop does not have — so every workspace image rendered as "Unable to load workspace image". The bytes now come across the preload bridge and are wrapped in a blob URL.
- **`/reload` works in the desktop app, not only the terminal.** loop serves its settings from an in-memory cache and caches the model catalog for the life of the process, so editing `settings.json`, an agent, a skill or an MCP entry on disk stayed invisible until the app was restarted — there was simply no way to pick a config change up. There is now: a `config.reload` RPC re-reads every config surface, rebuilds the command registry from disk, re-fetches the catalog and reconnects MCP, reachable as `/reload` in the composer or "Reload configuration" in the command palette. It reports what it re-read, because a bare "Reloaded" is indistinguishable from a no-op. Note that it refreshes what the app knows without re-deciding what an already-open conversation is running: a thread mid-flight keeps its model, and new threads pick up the new default.
- **Usage moved out of Settings and into the sidebar.** Spend and streak are something you check, not something you configure — a report that changes nothing has no business behind a settings page that takes over the window. `/usage` is its own destination now, opening in the main body with the sidebar still on screen, and `/cost` and `/steak` both find it since those are the terminal's names for its two halves. The old `/settings/usage` path redirects rather than dying, so bookmarks still land.

### Changed

- **Sidebar thread rows are shorter when there is nothing to say.** The third line carries branch, terminal, PR and diff — all of which the worktree/PR workflow fills in and a plain loop thread does not, so a short list of threads was spending 18px per row on an empty strip with two icons parked at its right edge. The line now renders only when it has content, and the provider and remote icons ride along with the title when it doesn't.

### Fixed

- **A folder full of repositories was told it had a detached HEAD.** loop reports such a folder as a repo so the diff surface can span its children, but it has no branch of its own — and `refName: null` reads to the git control as a detached HEAD, so a plain directory that happened to hold checkouts was advised to "create and checkout a refName" when what it actually needed was `git init`. The status now says _why_ it is a repo, and the control offers to initialize one.
- **Three source files were invisible to search below their first NUL byte.** `ChatComposer.tsx`, `handlers/preview.ts` and `telegram/render.ts` used raw NUL bytes as key separators inside template literals. grep, ripgrep and git all classify a file containing a NUL as binary and stop at the first one, which silently hid the last 1200 lines of the composer — including its entire slash-command list — from every search. The separators are now written as `\u0000`: identical string at runtime, and the files are text again.

## [0.16.6] - 2026-08-09

### Changed

- **The AI SDK is current again, and the installed tree now matches what loop declares.** `ai` moves to 7.0.58 and all eleven `@ai-sdk/*` providers to their latest — Anthropic, OpenAI, Google, Bedrock, Gateway, Groq, xAI, Mistral, Cerebras, DeepSeek and MCP. The installed packages had drifted further than the manifests implied, so this is as much a resync as an upgrade. Staying current is deliberate: the one time loop fell behind, a field rename inside the SDK broke tool-input streaming quietly and it took weeks to notice, so every release now checks that pair by name before shipping.
- **The model catalog was rebuilt from models.dev** — 728 models across 10 providers, so pricing and context limits reflect what the providers currently publish rather than what they published at the last release.

### Note

- **MCP stays on the `2025-11-25` protocol for now.** The specification's `2026-07-28` revision is a large, deliberately breaking one — it removes the `initialize` handshake, drops protocol-level sessions, and replaces server-initiated requests with a retry-based pattern. loop speaks MCP through the AI SDK's client, which has not yet adopted it, so there is nothing to switch on here. Servers are required to keep supporting existing clients through a twelve-month deprecation window, so connections are unaffected.

## [0.16.5] - 2026-08-09

### Changed

- **Noir has its own ink now, not loop's colours on a darker background.** `loop` mode keeps the classic vivid palette — gold heading, magenta inline span, green block — which is right for a mode drawing on whatever background your terminal happens to have. Noir washes its own canvas, so it can afford one deliberate set: every colour sits at a single lightness and a shared chroma, with hues spread far enough apart to stay distinguishable. Markdown, syntax highlighting, the semantic colours, the `/context` chart and the list bullet all come from it, so a screen reads tonal rather than primary and nothing shouts over its neighbours.
- **Two colours are deliberately louder than the rest.** A heading has to lead its section and an error has to alert, so both carry extra chroma — never extra brightness, which would break the single-lightness rule the set depends on. Every hue is still anchored to what it means: success green, error red, numbers cool. The set is normalised, not arbitrary.
- **The brand blue got the same treatment in noir.** At full chroma it was the one vivid mark on an otherwise tonal screen — as a list bullet, a prompt, or a typed `/command` it read as a mistake. It now sits at the set's lightness, still unmistakably the brand blue.

### Fixed

- **The same missing git identity, one file further along.** The web app's seam test drives the desktop's real git action against a real repo, so it failed on CI for exactly the reason the desktop's own tests did — the code under test spawns its own git and has no identity to use on a fresh runner. Fixed the same way, in the repo's own config. Both suites now pass with no ambient git config at all, which is the condition CI actually runs in.

## [0.16.4] - 2026-08-09

### Changed

- **The charts are themed too, and generate their colours rather than storing them.** `/context`'s category grid carried its own seven hexes, `/steak`'s usage wall was pinned to GitHub's greens, and injected context — session-start hook output, the active agent badge — had an orange of its own. All three now come from the theme. The categorical swatches cycle through seven hues the palette already keeps distinct because each is doing another job elsewhere (heading gold, link blue, type magenta, number cyan, success, error, variable orange), so no theme has to declare chart colours and a custom one gets a matching chart for free. The usage ramp walks the theme's own success colour out of the canvas, which also means it finally reads correctly on a light background — the fixed dark greens used to sit on white looking like four shades of the same square.

### Fixed

- **The desktop app's git tests only passed on a machine that already had a git identity.** They create real repos and commit into them, and while the test helper set an author through its env, the code under test spawns its own git and inherits none of it — so a developer machine quietly fell back on its global `user.email` while a fresh CI runner failed nine tests with "Author identity unknown". Each temp repo now carries the identity in its own config, so the tests bring what they need. They had never actually run on CI before this: the job hung ahead of them.

## [0.16.3] - 2026-08-09

### Changed

- **The CLI now wears the desktop app's colours.** Both halves of loop shipped their own palette and looked like two products. The terminal's themes are now built from the same design tokens the desktop renders with — including the syntax colours, which come from the very `pierre-dark` / `pierre-light` themes the desktop highlights code blocks with — so a diff, a heading, or a failed command reads the same in either place.
- **Not every web value survives the trip to a terminal, and the ones that don't were pulled back rather than copied.** The brand blue drops from full chroma to 0.16 at the same lightness and hue: in the desktop it sits behind a button, in a TUI it lands on borders, bullets, gutters, thinking ladders and the prompt all at once, and at full strength it stops reading as meaningful. The semantics are muted for the same reason — a whole output line in emerald glares in a way a small badge on a white card does not. Loop mode keeps its own tool-box fills exactly as they were, because a hand-picked fill is not something a linear blend reproduces.
- **Themes are now generated, not transcribed.** A theme is ~55 slots, and four of them meant four near-identical tables that drifted the moment one was edited — with every new UI mode copying them again. Each built-in theme is now about twenty primitives, and one derivation builds the slot table from them, so a change to how a slot relates to its palette reaches every theme in every mode at once. The `ThemeJson` shape is untouched as the wire format: custom themes in `~/.loop/agent/themes/` and themes contributed by extensions still load exactly as before, and still fill any slot they omit from the built-in dark theme.
- **Colour stopped leaking around the theme.** `chalk.yellow` and its siblings paint the terminal's own ANSI palette, which has nothing to do with the active theme — so everything reaching for them ignored `/theme` and `/uimode` entirely and stayed on the terminal's defaults. That was most of what is not a chat message: the `theme → day` line confirming a theme change, selector headings like `Settings (type to filter, Esc to close)`, the `search:` prompt, the working spinner, the todo panel, the login flow. All of it resolves through theme slots now, and resolves per render, so switching a theme repaints it live instead of at next launch.
- **The composer follows the theme too.** The rules above and below the input, and the tint on a `/command` as you type it, were hardcoded cyan inside the TUI package. They are theme slots now (`inputBorder`, `inputCommand`), reached through an optional hook on the editor's theme so an embedder that does not theme its composer still gets the highlight it had.
- **Markdown keeps its five colours.** Deriving every markdown slot from the accent flattened a rendered message into one blue: heading, link, inline `code` and bullet all the same. A heading and an inline span now have hues of their own in the palette, so the old spread is back — gold headings, blue links, a magenta inline span, green for a fenced block whose language loop cannot identify, and muted text under a dim gutter for quotes. The magenta is the syntax palette's own type colour, so an inline `Foo` matches the `Foo` in the code block beneath it.
- **The startup banner is a gradient rule instead of a spinning ring.** The pixel-art loop and its animation are gone; identity now sits beside a vertical rule drawn from the theme's own accent, over aligned `version` / `model` / `branch` / `cwd` / `session` rows. `branch` is new. Being static, it also stops costing renders once it has scrolled into scrollback.

### Fixed

- **Three CI runs sat "in progress" for up to two hours each.** A bare `bun test` walks the whole workspace, which since the desktop release includes the web app's suite — and that suite is written for vitest. Under bun it throws on `vi.waitFor` and `vite-plus/test`, then never exits, so the job held its runner until the six-hour timeout rather than failing. The run is scoped to the bun-native packages now, the web app uses its own runner, and both jobs carry a timeout so the next hang costs minutes.
- **`loop-review` had never run.** Not broken — unreachable: it fires on `pull_request`, and this repo's work lands as direct pushes to `main`. It takes a `workflow_dispatch` with a PR number now, and fails on an empty diff instead of spending a model run reviewing nothing.
- Model catalog refreshed from models.dev.

## [0.15.11] - 2026-08-02

### Added

- **A sixth built-in extension, `wayfinder`** — a port of Matt Pocock's [`/wayfinder`](https://www.aihero.dev/skills-wayfinder) skill, for the effort that is too big for one agent session and still wrapped in fog: you can feel the shape of the work but cannot yet write it down as a spec. It charts the effort as a **map** — one issue labelled `wayfinder:map` whose children are **decision tickets** — and then works those tickets one per session until the way to the destination is clear. Every ticket resolves a _decision_, not a slice of a build, so the map is finished when nothing is left to decide before someone goes and builds the thing. Tickets are either HITL (grilling, prototype — resolved in conversation with you) or AFK (research — fired off as parallel subagents), and whatever cannot yet be phrased sharply stays on the map as fog until an answer clears it. `loop enable wayfinder`, then `/wayfinder <a loose idea>` to chart a map or `/wayfinder <map url>` to work the next ticket.
- **It is a command, not a persona — which is why it is built differently from `ponytail` and `caveman`.** Those two shape every turn through `onSystemPrompt`. Wayfinder ships `disable-model-invocation: true` upstream, meaning the model must never reach for it on its own, so it registers a slash command that emits the same `inject-skill` event loop's own `/skill:<name>` commands use: the skill body renders as a skill card and submits as a turn, and nothing about it touches a session you did not ask it to.
- **The skill's missing dependencies are supplied rather than left to fail.** Upstream expects a "Wayfinding operations" doc laid down by a companion setup skill, and calls out to `/grilling`, `/domain-modeling`, `/research` and `/prototype` — none of which exist here, so the skill would have run aground on its first ticket. The extension appends its own operations section instead: **GitHub Issues** through the `gh` CLI (labels, sub-issues, `--add-assignee @me` to claim a ticket, a frontier query for what is takeable), or **local markdown** under `.wayfinder/` when there is no tracker to speak to. `/wayfinder tracker github|markdown|auto` chooses; `auto` probes for a github.com remote and an authenticated `gh` and falls back to markdown when either is missing, because a half-working `gh` fails in the middle of a map rather than up front. The four sibling skills are mapped onto what loop actually has — one-question-at-a-time turns for the human-in-the-loop tickets, the `task` tool for research subagents — and the mapping defers to the real skills if you install them later.

### Changed

- AI SDK packages upgraded (`ai` 7.0.40 → 7.0.48 and every `@ai-sdk/*` provider alongside it). Verified against the checks that exist because of the v7 field rename: the tool-input stream parts still carry `id` and `delta`, and a live run confirms `tool-input-start` arrives with its id before the `tool-call` and the deltas carry bytes — the write/edit live preview is intact.
- Model catalog refreshed from models.dev.

## [0.15.10] - 2026-08-01

### Changed

- **The `lsp` tool asked for a column number, which is the one thing an agent cannot see.** Every position operation — `goToDefinition`, `findReferences`, `hover`, the call hierarchy — required `character`, a 1-based column. But `read` and `grep` report line numbers and nothing else, so supplying a column meant counting characters into a line by eye. A guess that landed a few characters off hit whitespace or a comma and the server answered "No results found", which is indistinguishable from the symbol genuinely having no definition. The tool looked broken rather than mis-aimed, and one such miss is enough for an agent to fall back to text search for the rest of a session — the operations were there, correct, and largely unused. Position operations now take `symbol` instead: the name at that line, whose column is resolved from the line's own text. `lsp({ operation: "findReferences", filePath: "src/agent/turn.ts", line: 142, symbol: "runTurn" })`. Word boundaries are applied only where the symbol's own edges are word characters, so `run` will not match inside `rerun` while `#private` and `foo!` still match at all. `character` is unchanged and still accepted — it is now the way to reach the second occurrence of a name on one line, since the first wins otherwise — and `symbol` takes precedence when both are given.
- **A missed position now says what went wrong.** `["runTurn" is not on line 3, which reads: }]` quotes the line back, so an off-by-one line number corrects itself on the next call instead of being read as an empty result.
- **The tool's description was a list of nine operations and their arguments.** It described the mechanism and never the job, so nothing in it told an agent which question each operation answers or when the answer is worth a call. It now opens with the questions themselves — where is this defined, who uses this, what breaks if I change it, what implements this interface — and names the moments precision is what the task needs: before renaming a symbol, changing a signature, deleting something that looks dead, or tracing how a value flows. `prepareCallHierarchy` is explicitly demoted, since `incomingCalls` and `outgoingCalls` already perform that step themselves and exposing it as a peer only added a choice with no use.
- **The call summary follows the new shape.** A symbol-named position renders as `goToDefinition · src/main.ts:4 greet`, and a call carrying a line but no column no longer degrades to the bare file path.

## [0.15.9] - 2026-07-29

### Fixed

- **Thinking never appeared for OpenAI models reached through a gateway.** `@ai-sdk/openai` decides whether a model reasons by matching its id against a prefix allowlist — `gpt-5`, `o1`, `o3`, `o4-mini` — and gateways such as bifrost and LiteLLM advertise their catalogue with a vendor segment in front, `openai/gpt-5.6-terra`. loop persists the ids a custom provider's `/v1/models` discovery hands back, so the id that reached the SDK stopped starting with `gpt-5` and the allowlist quietly stopped matching. From there the SDK drops the whole `reasoning` block out of the request and files a warning nothing surfaces: the model still thinks, still bills for the reasoning tokens, and returns an encrypted reasoning item with no summary attached — so the pane stays blank and the request looks, from every angle loop could see, like it succeeded. The failure was invisible precisely because nothing errored.
- **The fix is the provider's own escape hatch, not a workaround around it.** `@ai-sdk/openai` documents `forceReasoning` for exactly this case ("useful for 'stealth' reasoning models (e.g. via a custom baseURL)"), so loop now sets it rather than rewriting model ids or second-guessing the gateway's naming. It is gated twice — the catalogue must positively know the model reasons, and the id must actually carry a vendor segment — because forcing the flag onto a model that does not reason earns a 400. Unprefixed ids and first-party OpenAI models therefore send byte-identical requests to before; only the ids that were already broken change. Thinking level is unaffected and, as before, rides across provider and model switches untouched.

## [0.15.8] - 2026-07-28

### Added

- **Seven more language servers install themselves, instead of asking you to.** `clangd`, `zls`, `lua-language-server`, `terraform-ls`, `texlab`, `tinymist` and `jdtls` ship as prebuilt release archives rather than npm packages, so until now they had to already be on your PATH — open a `.c` or `.java` file without them and the `lsp` extension simply had nothing to say. loop now fetches the build for your platform on first use and unpacks it into `~/.loop/servers/`. The previous release drew this line at "downloading a compiler's language server behind your back is worse than saying it isn't there", which was the right instinct aimed at the wrong target: the line is really between a self-contained editor tool and a face of a toolchain you installed on purpose. `rust-analyzer`, `dart`, `julia` and `sourcekit-lsp` are still found and never fetched, because installing our own beside your rustup one buys a version skew you would then have to debug.
- **Nothing is downloaded that your machine could not have run.** `zls` is version-locked to the Zig compiler, so it is only installed if `zig` is already present; `jdtls` needs a Java 21 runtime and is only installed if `java` reports one — a check that costs milliseconds and saves a 28MB download on a machine where the server could never have started. Platform support is decided before any network call, so an architecture upstream doesn't publish for is a quiet "no server" rather than a failed download.
- **`LOOP_DISABLE_LSP_DOWNLOAD=1` turns every install route off.** For an airgapped machine, a locked-down CI image, or simply a preference to manage your own toolchain. Discovery in `node_modules/.bin` and on PATH is unaffected — loop just stops installing anything, including the npm and `go install` routes it already had.
- **You can add downloadable servers yourself.** `~/.loop/servers/servers.json` entries take a `download` block — a release source (a GitHub repository, HashiCorp's build index, or a fixed URL), an asset-name template, and the platform and architecture words that project happens to use. A new `java` runtime covers servers that are an executable jar rather than an executable. See the extensions documentation for a worked example.

### Fixed

- **`jdtls` was launched with a configuration for the wrong architecture.** Recent Eclipse snapshots ship `config_mac_arm` and `config_linux_arm` beside the x86 ones; loop now probes for the architecture-specific directory and falls back to the generic one, rather than handing an Apple Silicon JVM an x86 configuration and watching it fail to load its native components.
- **A slow download mirror was treated as a broken one.** Eclipse serves the jdtls snapshot from mirrors that run at around 120KB/s, so a healthy transfer of it takes about four minutes. Downloads are now bounded by silence rather than by total elapsed time: a connection that stops sending for a minute is abandoned, while one that is merely slow is left alone to finish.

## [0.15.7] - 2026-07-28

### Fixed

- **`lsp workspaceSymbol` refused a directory, which is the natural thing to ask it about.** The operation lists symbols across a whole project, so an agent names the project — `example-ts-snake`, or the repo root — rather than an arbitrary source file inside it. Servers were matched by file extension, a directory has none, and the answer was "no language server available for this file type" even where the project plainly had one. Every other operation worked, so the failure looked arbitrary. A directory target is now resolved by looking inside it: a bounded, breadth-first scan (skipping `node_modules`, `.git`, `dist` and friends) picks one representative file per language and starts those servers, so a polyglot project gets all of them and a huge repo costs no more than a small one. `filePath` is also optional for `workspaceSymbol` now — omitting it means the workspace.
- **`workspaceSymbol` returned nothing from a server that had just started.** A tsserver-style server builds its program from the documents that have been opened, so querying the symbol index of a freshly spawned server returned an empty result even when the server itself was healthy and the symbol was right there. The representative file is opened before the query, which loads the project.

## [0.15.6] - 2026-07-28

### Fixed

- **The `lsp` extension found no language server in most TypeScript projects.** `tsc` has lived in `node_modules/.bin` for a decade as the compiler, but only TypeScript 7 answers `--lsp`. loop preferred the project's own binary — correct in principle, since a project should get the version it pins — and then launched a TypeScript 5 or 6 with LSP flags it doesn't understand. The handshake failed, the client was dropped, and the whole language went with it: `lsp` reported "no language server available for this file type" and diagnostics silently stopped after every edit. Any project with TypeScript installed locally hit this, which is nearly all of them, and it happened whether loop was started inside the project or above it. A discovered binary is now version-checked before loop speaks LSP to it: a project pinning TypeScript 7 or newer is used as-is, an older one is skipped, and loop falls through to the TypeScript 7 it provisions itself. Only `tsc` declares a minimum today, so no other server pays for the check.

## [0.15.5] - 2026-07-28

### Added

- **The `lsp` extension now answers questions about code, not just complains about it.** It shipped as diagnostics-only with exactly one language server; it now carries an `lsp` tool with nine operations — `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls` — and **37 language servers covering 75 file extensions**. This is the difference between asking "where is this defined" and grepping for a name: the answer comes from the compiler's model of the program, so it skips comments, strings, and unrelated symbols that happen to share a spelling, and `incomingCalls` answers a question grep cannot express at all. Line and character are 1-based, exactly as an editor shows them. The tool is granted to the read-only `plan` agent too, since navigation is the bulk of what planning does and it cannot mutate anything. Enable with `loop enable lsp` or `/extensions`.
- **TypeScript is served by TypeScript 7 itself, with nothing in front of it.** TS7 is a native Go binary that speaks LSP directly (`tsc --lsp --stdio`) and advertises hover, definition, implementation, references, document and workspace symbols, call hierarchy, and diagnostics. loop provisions `typescript@7` on first use and resolves the per-platform native binary inside it, skipping the JS shim — so there is no `typescript-language-server` wrapper and no Node process between loop and the type checker.
- **Servers are found the way a developer would expect.** A project's own `node_modules/.bin` first, then PATH, then — only for servers with a safe install route — automatic provisioning: 10 via npm into `~/.loop/servers/`, plus `gopls` via `go install` (never attempted unless `go` is already on PATH). Everything else resolves from PATH only, deliberately: downloading a compiler's language server behind your back is worse than saying it isn't there. Root detection walks up from the edited file to the nearest project marker, so a monorepo gets one server per package rather than one confused server for the whole tree, and a `deno.json` stands the TypeScript server down instead of double-reporting every diagnostic. A file can be served by several servers at once — a type checker and a linter say different things — and their diagnostics are merged and deduped. Add or override any of it in `~/.loop/servers/servers.json` without waiting for a release.
- **Extensions can now render their own tool calls.** A tool loop doesn't ship had its arguments printed as truncated JSON, which for a five-field call is unreadable. `api.tools.summary(match, fn)` lets the extension that owns a tool own how it reads. The renderer is handed the active **UI mode** and **theme**, so it can match `noir`'s heavier row grammar or `loop`'s flatter one and colour through the real palette instead of hardcoding escape codes. A renderer that throws is ignored rather than taking down the repaint.
- **Extensions can register UI modes and themes.** `api.uiModes.register(mode)` adds a whole chat experience — its own palettes plus declarative style knobs layered over the loop defaults — and `api.uiModes.addThemes(modeId, …)` adds palettes to a mode that already exists. Palettes may be partial: any slot left out inherits from the builtin dark theme, so a mode that restyles six colours doesn't have to restate the other forty-six.

### Fixed

- **Diagnostics reported every file clean against modern language servers.** LSP has two diagnostic mechanisms and servers pick one: the older model pushes `publishDiagnostics` when analysis settles, while the newer one (TypeScript 7 and friends) answers only when asked. loop only listened for pushes, so against a pull-only server it waited out its timeout and concluded there was nothing wrong — the feature looked like it was working and silently never fired. loop now asks when the server advertises that it can answer, and merges the result with anything pushed.
- **A provisioned language server was never upgraded.** The install was skipped whenever the binary already existed, so `~/.loop/servers/<key>/` kept launching whatever was installed the first time — after this release's switch to TypeScript 7, an existing install would have gone on running the old TypeScript 6 server forever. The requested dependencies are now compared against what's installed, and a mismatch reinstalls. Without this, no future server change could ever reach anyone who had used the feature before.
- **An extension-contributed UI mode could not be the one active at startup.** Modes were resolved before extensions loaded, so a mode an extension registered didn't exist yet at the moment the configured mode was chosen, and loop fell back. Extension modes are drained into the registry after load, and the mode and its theme are then re-resolved.

## [0.15.4] - 2026-07-28

### Fixed

- **One slightly-off `edit` silently rewrote the whole file, and the diff hid it.** When an `oldText` didn't match exactly, `edit` fell back to a fuzzy match — and to do it, normalized the _entire file_ and wrote that back as the new content. Every smart quote became an apostrophe, every en- and em-dash became a hyphen, every non-breaking and ideographic space became a plain one, trailing whitespace was stripped from every line, and the whole file was run through Unicode NFKC, which folds half-width kana to full width and rewrites ligatures. A one-line change to a Japanese string table came back with the table rewritten; a one-line change to a Markdown file came back with every two-space hard line break removed. None of it appeared in the tool output, because the diff was computed against the normalized copy too — so the model reported a one-line edit, the user reviewed a one-line edit, and the file on disk had changed everywhere. A fuzzy match is now resolved back to the exact span it covers in the real file through a character-level source map, so only the matched region is ever rewritten and every other byte is left alone. The diff is taken against the file as it actually was, which means it now shows the whole truth.
- **`edit` rejected text that appears exactly once as though it appeared twice.** Uniqueness was counted after fuzzy normalization even when the match itself was exact, so a file holding both `x("don’t")` and `x("don't")` folded them into one string and refused an `oldText` that matched the second one and only the second one: `Found 2 occurrences of the text`. Adding more context could not fix it, because the collision existed only in normalized space — the model was being asked to disambiguate something that was never ambiguous. An exact match is now counted exactly; a fuzzy match, having no exact anchor, is still judged in fuzzy space.
- **`find` cut the first character off every result when searching a path that ends in a separator.** Relativizing a hit assumed the search root needed one more character trimmed for the separator, which is true of `/Users/x` and false of `/`. Searching the filesystem root returned `olumes/…` instead of `Volumes/…` — every path unusable, and wrong in a way that reads as corruption rather than a bug. The prefix is built from the root rather than assumed, which fixes the same latent error on `C:\`.
- **`ls` silently dropped broken symlinks from its listing.** Entries were classified with a `stat` that follows links, and anything that threw — a dangling symlink, an entry the process may not stat — was skipped with `continue`, so the name vanished from the output entirely. To an agent, a name absent from `ls` means the file does not exist, which is the one conclusion the situation does not support. Unstattable entries are listed now, with a broken symlink marked `@`.
- **`grep` with `context` printed the same lines twice and labelled matches as context.** Every match formatted its own window independently, so two matches within `2 × context` lines of each other emitted overlapping runs: the shared lines appeared twice, and a match caught inside its neighbour's window was rendered with the context marker (`file-4-`) in one run and the match marker (`file:4:`) in the next. The model saw the same code twice under two different claims about which lines matched. Overlapping and adjacent windows are merged into one run now, separated by `--` between non-contiguous runs, the way ripgrep prints it.
- **`grep` with `context` invented a blank line at the end of a file.** The same phantom-line bug fixed in `read` in 0.15.3 lived in `grep`'s file reader: splitting on `\n` leaves an empty element after a file's final newline, and context reaching past the last match rendered it as a real, empty line. It also made every file report one line longer than it is.
- **A cancelled turn could still put a request on the wire.** `read` on a URL and `websearch` both subscribed to the abort signal without first checking whether it had already fired. An `AbortSignal` that is already aborted never emits an `abort` event, so a tool call issued after cancellation subscribed to a signal that would never fire again and fetched anyway — measured at a full 200 response returned after the turn was aborted. Both check the signal before subscribing now, the way `bash` already did.
- **`write` reported a file's character count as its byte count.** `content.length` counts UTF-16 code units, so `Successfully wrote 15 bytes` described a file that is 20 bytes on disk. Wrong for any file containing non-ASCII — accented text, CJK, emoji, box drawing — and the tool result is the only size signal the model gets back.
- **A relative path permission rule could be bypassed on Windows.** The cwd-relative form of a path was derived with a hard-coded `/`, so on Windows a `C:\proj` working directory never matched the `C:\proj/` prefix the check looked for, the relative candidate was never generated, and a rule written as `Edit(secrets/**)` failed to match a call made with the absolute path — the precise dodge that code exists to prevent. It uses the platform separator now, and offers the relative form with forward slashes too, since rules are written that way.

### Changed

- **`ls` marks a broken symlink with `@`.** Directories keep their `/`. The alternative to a marker was listing the name bare, which says a dangling link is an ordinary file and moves the confusion one step later, into the `read` that fails on it.

## [0.15.3] - 2026-07-27

### Fixed

- **`read` counted one line too many in every file that ends with a newline, and sent the model back to fetch it.** Splitting on `\n` leaves an empty element after a file's final newline, and that phantom line was counted as real. A 10-line file reported 11 lines; `read` with `limit: 5` said `[6 more lines in file. Use offset=6 to continue.]` when five remained; and a limited read that landed exactly on the last line still printed a continuation hint, which cost a whole tool call to follow and came back empty. Nearly every source file ends with a newline, so this was the ordinary case rather than an edge one, and the wasted read is the kind of thing a model reasons about — an empty result where content was promised reads as a broken file, not a miscount. Totals, remaining-line counts, and `offset=` hints are all computed on real lines now; a full read still renders the file's trailing newline back, so output stays byte-for-byte identical to what is on disk.
- **A file over 2GB could not be read at all, and a merely large one was buffered whole to show ten lines.** The entire file was read into a string before `offset` and `limit` were applied, so a 3GB log threw `Cannot create a string longer than 2147483647 characters` — V8's string cap — no matter how small the requested range, and a 300MB file cost 300MB of memory to return five lines. Files over 8MB are streamed line by line now: that 3GB file reads, and a `read` at offset 1,999,995 of a 200MB log returns in ~226ms holding a few MB. A line too long to display is clipped as it streams rather than assembled first, so a 200MB single-line file — a minified bundle, a one-line JSON dump — reports the line instead of trying to hold it in memory. A streamed read that stops before the end says `[More lines in file. Use offset=N to continue.]` rather than quoting a total it never counted.
- **Binary files were decoded as UTF-8 and printed.** Detection was by extension and covered exactly four image types, so anything else without one of those suffixes — a `.pdf`, a `.so`, a `.heic`, a compiled binary, a `.bmp` — was read as text, putting NUL bytes and replacement characters into the transcript, up to the full 50KB budget of them. `read` now sniffs the first 4KB for a NUL byte, which is the test git uses, and reports `[binary file: 3.1MB at …]` instead.
- **Reading a directory surfaced a raw `EISDIR: illegal operation on a directory, read`.** The readability check passes on a directory and the failure came from the read behind it, as an errno with no advice attached. It now says the path is a directory and points at `ls` and `glob`.
- **A write landing in the middle of a read could be recorded as already seen.** The mtime that read-before-edit compares against was sampled _after_ the content was read, so a file modified in that window was registered at its new mtime while holding the old content, and a later `edit` passed the staleness check against text that was never shown. The mtime is sampled before the read now, which fails toward an extra re-read rather than a silent stale edit.
- **The `sed` command suggested for an over-long line broke on paths with spaces.** It is quoted now.

### Changed

- **Overwriting an existing file with `write` requires having read all of it, not just some of it.** A single `read` with a `limit` — or any read of a file long enough to be truncated — was enough to unlock a full-file overwrite: `read(file, limit: 1)` followed by `write` would replace a 3000-line file whose contents the model had never seen, with nothing to stop it. Reads now record _which lines_ were seen, and `write` over an existing file needs coverage from line 1 to the end. Successive reads add up, so the ordinary way to satisfy it is the one the tool already suggests — follow the `offset=` hints to the end — and a gap left in the middle keeps the overwrite blocked. `edit` is unchanged and still needs only a prior read, since it matches on exact text the model has in hand. The visible effect is that an agent which skimmed a large file and then tried to rewrite it wholesale is now refused and has to either read the rest or make a targeted edit.

## [0.15.2] - 2026-07-27

### Fixed

- **Claude Opus 5 through a gateway failed every turn with an error naming a request loop never sent.** `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"` — except loop was already sending `thinking.type.adaptive`. The rewrite happens in flight: a gateway with its own model table (measured against bifrost) parses the request into its internal form and re-serializes it, and for a model that postdates its table it downgrades adaptive thinking to the retired `enabled` shape, which Anthropic then rejects. The error blames the shape that arrived, so the log points at loop and the fix isn't there. Opus 5 now sends `output_config.effort` with no `thinking` field at all, which is equivalent on that model — thinking is on by default from Opus 5 onward — and is the one form a proxy has nothing to rewrite. `xhigh` on Opus 5 also stopped quietly arriving as `max`.
- **A rejected thinking shape is now corrected from the rejection instead of ending the turn.** No table can describe the failure above, because the fault is in the transport rather than the model — so loop no longer relies only on guessing up front. When an Anthropic-shaped endpoint refuses the thinking parameters, loop reads what it objected to, rewrites the request into the next form (`adaptive` → effort-only → `budget_tokens` → neither, carrying your effort across, translated to a budget where the older form needs one), and re-issues it **once**, transparently — the turn simply runs. The shape that worked is remembered per provider and model in `~/.loop/model-shapes.json`, so every later request starts there and costs one round trip, this session and the next. Only recognized thinking complaints are touched: an auth failure, a rate limit, or a bad `max_tokens` reaches you unchanged, and a correction that doesn't help surfaces the original error rather than its own. This covers the mirror case too — a model or gateway older than the installed build, where the modern shape is the one that gets refused.

### Changed

- **Reasoning is visible again on the models that think the most.** From Opus 4.7 onward Anthropic changed the default for `thinking.display` to `omitted`: the model still thinks, and still bills for it, but the reasoning text comes back empty unless the request asks for a summary. loop never asked, so Opus 4.7, Opus 4.8, and Sonnet 5 streamed a thinking block with nothing in it and the pane sat blank through the pause. loop now sends `display: "summarized"` — visibility only, the thinking and its cost are unchanged — and an endpoint that rejects the field costs you the reasoning text rather than the turn. One model can't be helped: where `thinking` has to be omitted entirely to survive a gateway (Opus 5 above), `display` has nowhere to ride, so it thinks silently until the gateway learns the model.

## [0.15.1] - 2026-07-25

### Fixed

- **`Cmd+V` does not paste an image into the TUI, and 0.15.0 implied it might.** macOS delivers `Cmd+V` to the terminal, not to loop, and the terminal's job for that key is to read the clipboard's _text_ and type it into the program it is running. Raw image data has no text flavour, so there is nothing to type: measured against Ghostty 1.3.1, `Cmd+V` on an image-only clipboard sends **zero bytes** — not the empty bracketed paste 0.15.0 was written to catch, which only some terminals produce. The keystroke never arrives, so nothing inside loop can recover it — 0.15.0's note that `Cmd+V` "attaches too on terminals that report the empty paste" holds only for terminals that send one, which Ghostty does not, and it should not have been read as a working path. `Ctrl+V`, which terminals do forward, is the chord that works, and it is now a _complete_ paste: an image when the clipboard holds one, the clipboard's text when it doesn't, instead of an image-only chord that reported failure on ordinary text and trained you out of the one key that works. And because a paste that silently does nothing teaches you none of this, loop now notices an image sitting on the clipboard and says so — `image in clipboard · Ctrl+V to paste it` on the status line, once per image you copy. The check rides keystrokes that are already being handled, so an idle prompt costs nothing and a session that never copies an image never looks; a copy made in Finder is deliberately ignored, since it carries a file icon alongside the file and the icon is never what you meant to paste.
- **Noir rendered a partial read as though it were the whole file.** A `read` with an offset and a limit came out as a bare `◆ read src/app.ts`, with nothing to say only sixty lines of it had been looked at. The range was being appended by the default tool box rather than by anything the two modes share, and in noir the row is drawn by the mode — so it was simply absent. The row carries it now (`◆ read src/app.ts:120-180`), and the expanded output is numbered down the left with the file's real line numbers, counting from the offset instead of restarting at 1, so a preview can be matched back to the lines it came from. The numbering runs in both UI modes; the `[Showing lines … ]` notice the tool appends stays unnumbered, as does a result that is only a notice.

## [0.15.0] - 2026-07-25

### Added

- **Tab completion for the shell.** `loop completion bash`, `loop completion zsh`, or `loop completion fish` prints a completion script — `loop gate<Tab>` finishes the command, `loop gateways <Tab>` offers `status`, `stop`, and the gateway names, `loop mcp <Tab>` offers its subcommands, and `--cwd <Tab>` completes directories instead of guessing at words. The three scripts are generated from one table of commands, so a new subcommand is described once rather than in three shell dialects that quietly drift apart. Each command runs `loop completion <shell>` and prints where to put the output; zsh's goes on `fpath` rather than being sourced, which is the usual reason a `#compdef` script silently never fires.
- **A manual: `man loop`.** A real roff man page with the commands, options, config file locations, environment variables, and examples, generated from the same command table the completions use so the two can't describe different CLIs. The installer writes it to `~/.local/share/man/man1/`, which is on the default manpath, so `man loop` works after an install with nothing to configure; `loop man` opens it directly, and `loop man --install` rewrites it after an upgrade.

### Fixed

- **The Telegram bot's model picker hid every provider that needs no password.** `/model` listed only providers with stored credentials, which silently excluded all three kinds that have none: a local ollama daemon, bedrock running on ambient AWS credentials, and custom gateways, which are saved somewhere else entirely. There was no error — the models simply weren't there. What counts as a usable provider now has one definition, shared by the terminal, the web UI, and the bot, rather than the correct one living in the TUI and a stricter one behind the API. **The web UI's model picker was quietly missing them too, and is fixed by the same change.**
- **Resuming a session no longer arrives as a dozen notifications.** Replaying a transcript sent one message per turn, so switching sessions buried the chat and lit up the phone once per replayed turn. It is a single message now, split only when it exceeds Telegram's size limit and only ever between turns, never inside one.
- **`/sessions` can reach past the ten most recent.** The list was cut at ten with no way to see the rest; it now pages eight at a time with prev/next that wrap around. The page rides the button rather than being remembered by the bridge, so a menu still works after a restart, two open menus can't fight over one cursor, and a page that no longer exists falls back instead of showing an empty list.
- **`/cost`, `/steak`, and `/context` render straight on a phone.** Cost amounts were padded on the label only, leaving the decimal points ragged down the column. The usage heatmap and the context bar drew themselves with a middle dot and shade blocks borrowed from three different Unicode ranges; Telegram's mobile code font doesn't carry all of them and substitutes per glyph from fallback fonts whose widths don't match, so the grid's columns came out crooked and the bar's drawn width changed with how full it was. Both are plain ASCII now, which has no fallback to go wrong.
- **Pasting an image into the TUI.** `Ctrl+V` attaches an image from the clipboard and `Ctrl+I` opens a file picker — both already worked, but neither was registered, so `/hotkeys` never listed them and there was no way to find out they existed. They are listed and rebindable now, `Ctrl+V` says why nothing happened when the clipboard holds no image instead of appearing broken, and `Cmd+V` attaches too on terminals that report the empty paste it produces (macOS hands `Cmd+V` to the terminal, which pastes the clipboard's text — and raw image data has none).
- **`/new` in Telegram names the model** the new session will run on, instead of leaving you to check afterwards.

## [0.14.1] - 2026-07-25

### Fixed

- **Enabling a gateway in 0.14.0 spawned loop processes without end.** Opening loop with a gateway enabled started a daemon that wasn't a daemon at all: inside a release binary the check for "am I running from source?" read the executable's own virtual entry path, which ends in `.js` and so answered yes for every compiled build. The daemon was launched with that path as its command word, which matches no command, so it fell through to the interactive TUI — and starting a TUI starts the daemons for enabled gateways, which started a TUI, roughly one new process every second and a half until the machine ran out of memory. A real Telegram poller never ran at any point, so the pidfile that exists to prevent a second one was never claimed and never applied. The check now reads the executable, matching how the background-task daemon has always done it, and a process running as a gateway daemon is refused permission to spawn a gateway daemon at all — so even if the invocation were to break again, the chain stops at the first process instead of running away. If 0.14.0 left processes behind, `loop gateways stop` and quitting loop now clear them; a `pkill -f "gateways"` will finish off any strays from the old build.

### Changed

- **Gateways now stop when the loop that started them stops.** A gateway still runs as its own separate process — it can't stall the UI and it isn't tangled up in the TUI's state — but it is no longer independent of it: quitting loop shuts down the gateways that loop started, closing the terminal on a `loop gateways <id>` closes that gateway, and a gateway whose loop is killed outright notices within a few seconds and exits on its own. This reverses 0.14.0, where gateways were deliberately left running after you quit. A bridge that outlives every visible sign of itself is a bridge still accepting shell commands from a chat with nobody watching, and that trade is not worth the convenience of a phone that keeps working after you close the terminal. Daemons started explicitly with a bare `loop gateways`, which exits as soon as it has spawned them, still run until `loop gateways stop` — that command has no session to tie them to.

## [0.14.0] - 2026-07-25

### Added

- **Remote chat gateways, and Telegram as the first one.** `/gateways` sets up chat surfaces that drive loop from your phone (also reachable as the `gateways` row in `/settings`). Every gateway runs as **its own detached daemon process** — never inside the TUI — so the bridge keeps working after you close the terminal, survives a TUI crash, and can never stall the UI's event loop; `loop gateways` spawns the daemons for enabled gateways, `loop gateways status` reports configured/enabled/running with pids, `loop gateways stop [id]` shuts them down, and opening loop brings up any missing daemon while quitting deliberately leaves them running. The framework is generic — a gateway implements one `Gateway` interface (status/enable/disconnect/start) plus a setup screen, and the registry, pidfile daemon lifecycle, `/gateways` manager, settings row, and auto-start pick it up without naming it — so Slack, Discord, or Signal can be added as siblings later. Telegram is the first implementation: paste a BotFather token, tap the printed `t.me` deep link, and the one chat that claims the one-time pairing code owns the bridge (a bare `START` never pairs, and the code is never echoed to an unpaired sender). It talks to the agent over the same JSON-RPC surface `loop serve` uses, so sessions, cost, settings, and extensions are one implementation rather than a parallel one. Long polling means no webhook, no public URL, and no NAT hole — and Telegram's one-poller-per-token rule doubles as a natural lock against two bridges fighting. **Whoever controls the paired chat runs shell commands as you**, which is why pairing is one-shot, single-chat, and set up only from the machine itself.
- **The bot is a full loop client, not a prompt box.** Telegram's native command menu carries `/new`, `/sessions`, `/cancel`, `/queue`, `/model`, `/thinking`, `/settings`, `/cost`, `/context`, `/steak`, `/session`, `/name`, `/compact`, `/export`, `/extensions`, `/cd`, `/status`, `/init`, and `/help` (plus chat aliases like `clear`→`new`, `stop`→`cancel`). Panel commands become inline-keyboard menus you tap — `/settings` toggles in place, `/model` walks provider → model and offers **only providers you're actually logged into**, mirroring loop's own picker rather than listing models that would fail. Turns render as a live multi-message stream: each tool call arrives as its own message (bold verb + argument, subagent calls prefixed) and edits itself in place if the tool fails, while assistant prose streams token-by-token into a message that grows as it types and rolls into a fresh one when it fills — a long answer streams across as many messages as it needs, with nothing truncated. Markdown tables become aligned monospace blocks, since Telegram has no table markup. Switching sessions replays the transcript into the chat, so a resumed conversation has visible context instead of just an id; `/export` ships the full session as a `.jsonl` document. Photos you send are attached as images.
- **Sending a message mid-turn interrupts it.** There is no Esc key on a phone, so the natural way to redirect the agent is to just say the next thing: the running turn is cancelled and yours starts, with the abort reported as an interruption rather than an error. Several messages in a row keep the order you typed them, and only one cancel is sent for the burst. When you'd rather wait your turn, `/queue <message>` (aliases `/enqueue`, `/queued`) runs after the current turn instead of displacing it — bare `/queue` lists what's waiting, `/queue clear` empties it, an interrupt always jumps ahead of anything queued, and `/cancel` drops the queue too so a cancel can't be followed by an ambush turn.

### Changed

- **AI SDK refresh.** `@ai-sdk/amazon-bedrock` 5.0.31, `@ai-sdk/anthropic` 4.0.20, and `@ai-sdk/google` 4.0.24, plus a model-catalog regeneration picking up new upstream models and pricing. Tests, typecheck, and build verified against the new versions.

## [0.13.2] - 2026-07-24

### Added

- **Vercel AI Gateway provider.** `loop login vercel` (or an `AI_GATEWAY_API_KEY` env var) unlocks the gateway's 200+ chat models as `vercel/<creator>/<model>` — one key across Anthropic, OpenAI, Google, xAI, DeepSeek, and the rest, billed through Vercel. Built on the first-party `@ai-sdk/gateway` package, which speaks the AI SDK's native wire protocol rather than an OpenAI-compatible shim, so reasoning effort, provider options, and usage round-trip cleanly. The catalog comes from models.dev overlaid with the gateway's public `/v1/models` for live availability, filtered to chat models only — the gateway marketplace also lists embedding/rerank/image/video/speech models, which have no business in a coding agent's model picker — plus a curated flagship seed (Claude Opus 4.8 / Sonnet 4.6, GPT-5.5, Gemini 3.1 Pro, GLM-5.2, Kimi K3) at live gateway prices. One deliberate omission: the generic `VERCEL_API_KEY` env is _not_ read — that name carries Vercel platform/deploy tokens, which are not gateway keys.

### Changed

- **AI SDK refresh.** `ai` 7.0.37 and provider bumps (@ai-sdk/anthropic 4.0.19, openai 4.0.20, google 4.0.23, amazon-bedrock 5.0.30, gateway 4.0.28), plus a model-catalog regeneration picking up new upstream models and pricing. Tests, typecheck, build, and live streaming verified against the new versions.

## [0.13.1] - 2026-07-23

### Added

- **herdr integration.** Running inside a [herdr](https://herdr.dev) pane, loop now reports its state natively over herdr's socket API: the sidebar shows `loop` with live **working / blocked / idle**, the session id rides along (re-announced across `/new`, `/resume`, and forks), and the pane is released back to herdr's own detection on exit. Blocked means _the agent is waiting on you_ — ask-tool questions and bash/file/plan approval prompts, each labeled ("question: <header>", "bash approval") so herdr can show why — while menus you opened yourself (`/settings`, pickers) deliberately never count, matching how herdr treats Claude's own menus. herdr's completion and needs-attention sounds now fire for loop panes exactly as they do for officially integrated agents. Under the hood this is a generic per-pane agent-status bus fed by the two seams that already see everything (the working indicator and the modal-prompt host), with the herdr reporter as one consumer: hard-gated on the env herdr injects (`HERDR_ENV` + socket + pane id) so it is completely inert outside herdr, fire-and-forget sends with a hard timeout so a dead or restarting herdr server can never slow the TUI, and an ordered send queue with strictly increasing seq. `"herdr": false` in settings (or the `/settings` row) turns it off. Verified end-to-end against a live socket server driving the real TUI.
- **`Notification` hook fires for interactive prompts.** When an agent-driven prompt opens mid-turn (ask tool, approval prompts), the Claude Code–compatible `Notification` hook now fires with `message: "Waiting for input: <label>"` — previously it only fired for PreToolUse denials. Agent-state watchers and custom notification hooks get the same "needs attention" signal Claude Code gives them; user-opened menus don't trigger it.

### Changed

- **AI SDK refresh.** `ai` 7.0.35 and provider bumps (@ai-sdk/openai 4.0.18, google 4.0.22, amazon-bedrock 5.0.28), plus a model-catalog regeneration picking up new upstream models and pricing. Tests, typecheck, build, and live streaming verified against the new versions.

## [0.13.0] - 2026-07-22

### Added

- **Goal mode.** `/goal <objective>` drives the current session autonomously until an adversarial verifier agrees the objective is met. On start, a hidden read-only planner writes a frozen plan (acceptance criteria + a `- [ ]` task checklist) — fail-closed: no usable plan, no goal. After every turn the harness mines the plan's first unchecked checkbox into a continuation nudge and resubmits, at zero extra model cost per round; turn-final hand-off phrases ("stopping here", "let me know if…") get an explicit anti-bail nudge instead. When the checklist runs out, a fresh read-only adversarial verifier (its own context — it never sees the implementer's narration) audits the workspace against the plan: tests must honestly drive the shipped code (hardcoded expectations, mocked-out units, and started-past-the-unit scenarios count as no evidence), fabricated claims and leftover TODO/skipped-test markers refute. Refuted findings feed the next round as a concrete punch list, with an anti-ratchet rule on re-verification (the bar never rises between rounds) so goals converge instead of chasing fresh nitpicks; a clean verdict completes the goal with an OS notification. Esc pauses rather than kills; `/goal pause | resume | status | clear`; guard rails auto-pause instead of burning tokens (40-round cap, 10-verification cap, identical-gaps stall detection, a stuck checklist forces verification). Goal state, the plan, and a scratch dir persist per session under `~/.loop/agent/goal-mode/`, so `/resume` picks a goal back up. Planner/verifier spend is billed to the session under their own ledger sources (`goal-planner`, `goal-verifier`) and reconciles in `loop cost audit`. Verified end-to-end in the real TUI: plan frozen verbatim (including refusing to "correct" a typo'd objective), one implementation turn, verifier passed on the first run.

### Changed

- **`/goal` (background tasks) is now `/background`.** The old `/goal` surface — on-demand detached runs and once/cron-scheduled tasks — moves to `/background` (alias `/bg`): bare opens the same manager, `/background <text>` is the same AI quick-add, `/daemon` is unchanged. The `/goals` alias is gone; the `goal` name now belongs to goal mode above. Headless runs are named `background: <text>`, and `loop background` works alongside the unchanged `loop goals` CLI subcommand (kept verbatim so already-installed daemons keep firing).
- **AI SDK refresh.** `ai` 7.0.34 and the `@ai-sdk/*` provider line (anthropic 4.0.18, openai 4.0.17, google 4.0.21, xai 4.0.18, amazon-bedrock 5.0.27, cerebras 3.0.14, deepseek 3.0.13, groq 4.0.13, mistral 4.0.14, mcp 2.0.16). Tests, typecheck, build, and live streaming verified against the new versions.

## [0.12.15] - 2026-07-19

### Added

- **Workspace context files are protected from the agent.** The bash tool now refuses to delete or move `AGENTS.md` / `CLAUDE.md` (`rm`, `unlink`, `shred`, `trash`, `mv`, `git rm`, `git mv` — per segment, so chained, wrapped, and absolute-path forms are caught) on the model's own initiative. These files feed the system prompt every turn; losing one silently changes how the agent behaves in the repo. Interactively the attempt shows the normal approval prompt; in print mode / RPC it fails closed with an instructive refusal. An explicit whole-command `allow` permission rule still approves it — a deliberate written decision, same as the other dangerous commands — but remembered "always allow" grants never do. Verified live: the agent's `rm <abs-path>/CLAUDE.md` is refused and the file survives.

## [0.12.14] - 2026-07-18

### Fixed

- **`loop run --session <id>` actually resumes.** The flag — long advertised in `--help` — was silently ignored: every run created a fresh session, forking your history without a word. It now loads the session (full prior context carries into the turn, verified end-to-end), defaults the model and working directory to the session's own, and an unknown id fails loudly with exit 1 instead of quietly starting over. `--model` and `--cwd` still override per-run.
- **`loop run - < file` works.** Reading the prompt from a shell redirect printed the Usage error even though a pipe (`cat file | loop run -`) worked: in the bundled build, the stdin stream saw EOF without ever delivering a regular file's bytes — pipes only survived by arrival timing. Non-tty stdin is now read directly from the file descriptor, so redirects, pipes, and heredocs all behave the same; a tty keeps the old streaming path for interactive Ctrl+D input.

## [0.12.13] - 2026-07-18

### Fixed

- **Terminal tab progress indicator actually works now.** The OSC 9;4 "working" indicator added for Ghostty/WezTerm/iTerm2 tabs sent state `1` (set percentage) with an invalid `-1`, which terminals drop or render as 0% — it now sends state `3` (indeterminate), so the tab shows a busy indicator for the whole turn. The working indicator also routes through the TUI terminal's single `setProgress` implementation instead of a second private copy of the escape-writing machinery.
- **No more stuck tab progress after a crash or signal.** The indicator is now cleared on every exit path: the TUI's exit safety net (SIGINT/SIGTERM/SIGHUP and `process exit`) and `terminal.stop()` both emit the OSC 9;4 clear when the bar was shown. The clear is deliberately skipped when the bar never appeared, so old iTerm2 — which renders unknown OSC 9 as a notification popup — sees nothing.

## [0.12.12] - 2026-07-18

### Changed

- **OpenRouter provider off the alpha.** `@openrouter/ai-sdk-provider` moves from the pinned `6.0.0-alpha.1` pre-release to the current stable `^3.0.0` release line (upstream's versioning jumped 3.0.0 → 6.0.0-alpha, so the lower number is the newer build). The stable line ships against the `@ai-sdk/provider@4` spec — the alpha was v3-spec — and is the release line upstream supports for `ai@^7`: no more "backward-compat keeps it working", this is the intended pairing.
- **Dependency sweep.** `@aws-sdk/credential-providers` 3.1090.0, `shell-quote` 1.10.0, `marked` 18.0.6, plus dev bumps (`@types/node` 26.1.1, prettier 3.9.5). The monorepo root also dropped its duplicate `@ai-sdk/*` entries — they only ever belonged to `@notshekhar/loop-core`, which already pinned the same versions. Build, typecheck, and the full test suite verified.

## [0.12.11] - 2026-07-17

### Fixed

- **Kimi cache hits now show up.** Kimi reports prompt-cache hits as OpenAI-style `usage.cached_tokens`, but the DeepSeek SDK the provider rides only understands DeepSeek's `prompt_cache_hit_tokens` — so the cost ticker and `/context` always showed `cache:0` even though Moonshot's automatic prefix caching was hitting (and billing you the cheap tier) the whole time. A fetch-layer rewrite now maps the field for both JSON and streaming responses; live-verified on a Kimi Code subscription (2560 of 2622 prompt tokens read from cache on the second call).

### Changed

- **AI SDK refresh, for real this time.** The v0.12.10 notes claimed the `@ai-sdk/*` minor updates but the dependency bumps never made it into that commit — this release actually pins them (anthropic/openai/xai 4.0.16, google 4.0.18, deepseek/cerebras 3.0.12, groq 4.0.12, mistral 4.0.13, amazon-bedrock 5.0.24, mcp 2.0.15, ai 7.0.31), plus the build-time models.dev price refresh. Tests, typecheck, and live streaming verified against the new versions.

## [0.12.10] - 2026-07-17

### Added

- **Kimi (Moonshot AI) as a built-in provider.** `loop login kimi` (or set `KIMI_API_KEY`), then pick a model with `/model`. Both key kinds work and route automatically by prefix: pay-per-token platform keys (`sk-…`) hit `api.moonshot.ai` with the Kimi K3 / K2.7 Code / K2.6 catalog at real prices, while Kimi Code subscription keys (`sk-kimi-…`) hit `api.kimi.com/coding` and swap the catalog for the plan's models (`k3`, `kimi-for-coding`, `kimi-for-coding-highspeed`) at $0 — re-pasting the other kind via `/login` re-routes everything. Rides the DeepSeek SDK, so `reasoning_content` thinking streams live and round-trips across turns; the thinking level toggles Moonshot's `thinking` switch. `LOOP_KIMI_BASE_URL` overrides the endpoint (e.g. `api.moonshot.cn` for China).

### Changed

- **AI SDK refresh.** Minor updates across `@ai-sdk/*` (anthropic/openai/xai 4.0.16, google 4.0.18, deepseek/cerebras 3.0.12, groq 4.0.12, mistral 4.0.13, amazon-bedrock 5.0.24, mcp 2.0.15); tests, typecheck, and a live streaming call verified against the new versions.

## [0.12.9] - 2026-07-16

### Changed

- **Installer download progress bar.** `install.sh` and `install.ps1` (and therefore `loop update` / `/update`, which re-run them) now draw a live `■■■････ 42%` bar while the release tarball downloads. The bash installer parses a `curl --trace-ascii` stream through a FIFO (TTY only, falling back to `curl --progress-bar`; unlike the technique's origin, an HTTP error fails the download instead of saving the error page). The PowerShell installer streams via HttpClient with the same bar, degrades to `Invoke-WebRequest` on any failure, uses `·` so legacy conhost codepages render cleanly, and opts Windows PowerShell 5.1 into TLS 1.2.

## [0.12.8] - 2026-07-16

### Added

- **Permission rules: allow / ask / deny over the tools.** A new `permissions` key in settings.json (managed via `/permissions` or the `/settings` row) takes rule strings like `Bash(git *)`, `Read(secrets/**)`, `Edit(**/*.pem)` — deny always wins, ask forces an approval prompt even with bash approval off (failing closed in print mode/RPC), allow skips the prompt. Bash deny/ask rules match every executed segment (chains, `sh -c`, command substitution, env/wrapper prefixes) while allow matches the whole command only, so an allowed prefix can't smuggle a blocked segment. `Read` rules also govern `grep`/`find`, and trusted projects can add rules from `<project>/.loop/settings.json`. Full syntax and evaluation order: `loop://docs/permissions.md`.
- **Per-project "always allow" + dangerous-command re-prompts.** Approval-prompt grants now persist per project instead of globally (the legacy global `bashAllow` list still matches), the prompt gained a "never allow" row that feeds `bashDeny`, and dangerous commands (`rm`, `chmod`, `kill`, `git push`, …) always re-prompt instead of riding a remembered grant — only an explicit written allow rule approves them silently.
- **Enforced plan mode.** `/plan` (or `/plan <task>`, or Shift+Tab onto the plan agent) locks the session read-only at the tool layer in every permission mode: edit/write are rejected and bash runs in the fail-closed kernel read-only sandbox — subagents inherit the lock. The agent can request it mid-task via the new approval-gated `enter_plan_mode` tool when the approach is genuinely ambiguous. Accepting a delivered plan ("implement it") lifts the lock; the status line shows `plan mode (read-only)` while it's on.

## [0.12.7] - 2026-07-16

### Fixed

- **Release CI: fix the flaky multi-client RPC serve test for real.** v0.12.6 mocked the whole agent module, but Bun shares mocks across files so rpc/abort/reopen tests broke with `Unknown provider: nope`; that mock is gone. v0.12.6/v0.12.7 also reordered `getModel` in production `turn.ts` purely to speed the test up — that has been reverted (no production change for a test). The test just does real work (spin a session, fail on a bogus provider) that a loaded CI runner can't finish inside Bun's 5s default, so it now gets a 30s timeout budget.

## [0.12.6] - 2026-07-16

### Fixed

- **Release CI flake in the multi-client RPC serve test.** Waiting for a real `runTurn` with an unknown provider still loads catalog/skills/tools before failing, which exceeded the wait under CI load. The test now mocks `runTurn` to fail instantly so broadcast/attach/detach stay deterministic.

## [0.12.5] - 2026-07-16

### Fixed

- **Stop during a web UI turn actually ends the turn.** Abort used to skip the stream `finish` event, so the composer stayed locked and tokens kept looking live after you hit stop. Aborted turns now emit `finish`, and the client clears running state as soon as you click stop.
- **Flaky multi-client RPC serve test.** It waited a fixed settle window and asserted the last event was `error`, which raced under CI load; it now waits for the error itself and uses a real temp cwd.

## [0.12.4] - 2026-07-16

### Fixed

- **`loop serve` no longer sticks on "connecting…".** Inlining the minified web bundle used a string-form `String.replace`, which treats `$&` in the JS as "insert the match" — so a minified `$&&` became an HTML comment mid-script and the browser never ran the client. Replacements now use a function so `$` in the bundle stays literal.

## [0.12.3] - 2026-07-16

### Fixed

- **`loop serve` in the compiled binary no longer 500s on every page load.** The standalone binary never baked the web UI into `__WEB_UI_HTML__`, so it tried to resolve `@notshekhar/loop-web/app` from inside the binary filesystem and failed. Release builds now embed the page the same way core's npm dist already did.

## [0.12.2] - 2026-07-16

### Changed

- **Mobile home uses an OpenCode-style project dialog.** The cramped horizontal project chips and Esc-only open-path popup are gone: one Projects button opens a closable dialog (backdrop tap + close) with a filterable project list and an Open path field. Desktop keeps the side rail.
- **Composer send stays right-aligned on desktop.** Hiding an empty status line no longer drops the flex spacer that pinned send to the trailing edge.

## [0.12.1] - 2026-07-16

### Added

- **Streak stats under the usage heatmap.** `/steak` and `/cost` now show your current streak, longest streak, active days, and busiest day beneath the graph — the same numbers as the web UI's usage dialog, computed once in core so every client agrees. A quiet "today" doesn't break the streak until the day is over.

### Changed

- **`loop serve` binds `0.0.0.0` by default and prints the network URL with its token.** Reaching the UI from another device is the point of serve, and the token is the lock either way — so the LAN URL is now copy-pasteable as printed. `--host 127.0.0.1` restores a loopback-only bind (which still previews the LAN URL it would serve).
- **The browser client is its own workspace package.** `packages/web` owns the serve UI as small focused modules (state, RPC client, transcript renderer, per-feature files) instead of one 3,600-line embedded HTML file. Builds bake the compiled single-file page into core — release binaries stay self-contained — while source runs bundle it on the fly, so web edits show up on reload.

### Fixed

- **The web UI behaves on phones.** Streaming no longer janks the page (deltas paint at most once per frame, so typing stays smooth while the agent responds); the composer keeps send on one row, autosizes in CSS, and stays clear of the on-screen keyboard and the iPhone home bar; the header wraps to two rows so the actions never squeeze out the session title (and the cost readout is back on mobile).

## [0.12.0] - 2026-07-15

### Added

- **`loop serve` — a token-protected web UI for remote use.** Enable `serve` in `/settings`, then run `loop serve` to open Loop's sessions in a browser. It is loopback-only by default, supports a chosen host/port, and prints a bearer-token URL; use Tailscale, SSH, or Cloudflare Tunnel for remote TLS access. Open web clients see a session's transcript and, for turns started in the web UI, live text, reasoning, tool, and subagent events; reconnects replay missed events. Treat the URL as full control of the machine.
- **Image and PDF attachments accept more real-world drops.** Finder-style paths with spaces, shell-escaped paths, and `file://` URLs are recognized. PDFs now attach for providers that support inline PDF data; unsupported attachments remain visible as ordinary path text instead of disappearing.

### Changed

- **Prompt editing follows macOS conventions more closely.** Cmd+Left/Right move to a line boundary, Cmd+Up/Down move to the start/end of the input, Cmd+Backspace deletes to the line start, Cmd+Z undoes, and Up on the first visual line enters prompt history.

## [0.11.5] - 2026-07-13

### Changed

- **Ctrl+E is the only way into transcript navigation.** Esc on an idle empty prompt and ctrl/alt+arrows no longer drop you into nav mode — a stray Esc or a macOS cmd+arrow gesture kept flinging people into the transcript. Inside nav nothing changed: arrows still walk entries, alt+arrows still jump turns, and Esc still exits. The welcome banner now mentions the shortcut (`Ctrl+E navigates transcript`).

## [0.11.4] - 2026-07-13

### Fixed

- **Noir's day theme no longer shows invisible text in dark terminals.** The canvas wash set only the terminal's default background (OSC 11), so anything drawn at the terminal's default foreground — white, in a dark terminal — disappeared against the day theme's light canvas. The wash now sets the default foreground to the theme's text color too (OSC 10), restores both on exit (OSC 111/110), and the crash-safe startup cleanse clears a killed session's leftover foreground as well.

## [0.11.3] - 2026-07-12

### Changed

- **The internal docs caught up with the last five releases.** `loop://docs/config.md` — what the agent reads when you ask it to configure loop — now covers the `todos` checklist setting, the `skills` toggle (and where skill folders live), UI modes (`uiMode`, `/ui`, per-mode themes), the full set of custom-provider auth kinds (`apikey`, `bearer`, `env`, key `helper` with JSON stdout + expiry, `oauth` with discovery escape hatches), and the `todo`/`skill` entries in a custom agent's `tools:` list.

## [0.11.2] - 2026-07-12

### Changed

- **Noir is the default UI mode.** A fresh install — or any setup that never picked a mode — now opens in noir: dark washed canvas, diamond tool rows, collapsing thought blocks. An explicit `uiMode: "loop"` in settings keeps the classic look, and `/ui loop` switches back at any time.

## [0.11.1] - 2026-07-12

### Fixed

- **The todo panel clips by display width.** Overlong rows truncate by terminal cells instead of string length, so wide characters (CJK, emoji, Devanagari) never split at the clip point and a clipped row keeps its styling — an overlong in-progress row used to lose its cyan.
- **Resumed sessions keep todo state in sync.** Replaying a branch (resume, fork, tree navigation, `--session`) now seeds the agent's canonical todo map alongside the pinned panel, so staleness nudges and RPC readers agree with what's on screen after a process restart; switching to a branch without a checklist clears the stale one.
- **Aborted turns always emit `finish`.** One early-return path skipped the event, leaving finish-keyed consumers (an RPC client) waiting forever.
- **Memory-index truncation cuts on a line boundary.** The size cap counted bytes but sliced UTF-16 units, so it could split a multibyte character — and always split an index line mid-sentence.

## [0.11.0] - 2026-07-11

### Added

- **The model can invoke skills directly.** A new `skill` tool lets the agent call a skill by name and get its instructions in one step, instead of only being pointed at a SKILL.md path to read. It rides the existing `skills` setting and project-trust gate — nothing new to enable — and an unknown name returns the real list of available skills. Skills with `disable-model-invocation` stay hidden from it, subagents keep the read-based flow, and reading the file directly still works everywhere. The tool shows up in `/context` accounting, and restricted agents opt in by naming `skill` in their tool list.

### Changed

- **The todo panel no longer outlives the turn.** When a turn ends — finished, interrupted, or failed — the pinned checklist retires into the scrollback as a one-line summary (`todos: all 5 done`, `todos: 3 of 7 open`) instead of sitting under the prompt forever. The list itself is kept, so staleness nudges and resumed sessions still know where you left off.

## [0.10.11] - 2026-07-10

### Added

- **The ask tool got a review step and question navigation.** Answers are no longer sent as you pick them: after the last question a review screen lists every answer (with `(skipped)` rows for unanswered ones) and nothing reaches the model until you hit **Submit** — Enter on a row (or its digit) reopens that question to change the answer. While answering, `←/→` move between questions with all state kept: the cursor row on a single-select, the ticked boxes on a multi-select (ticks count as the answer even without `done`). `Esc` now means _dismiss_: with nothing answered the whole prompt resolves immediately as declined so the agent proceeds on its own judgment; with answers already given it jumps to the review so nothing is sent unseen.
- **Clipboard writes work beyond macOS.** `/copy`, `y` in transcript navigation, and the `/share` URL copy now go through the platform's own tool — `pbcopy` (macOS), `clip` (Windows), `wl-copy`/`xclip`/`xsel` tried in order (Linux) — and report honestly when no tool is available instead of claiming success.

### Fixed

- **One arrow press no longer acts twice in the ask flow.** Under the Kitty keyboard protocol a physical key press also emits a release event; the ask menus acted on both, so a single `←/→` jumped two questions.
- **Switching UI modes rebuilds the transcript.** `/ui <mode>` used to repaint the old component tree, leaving a hybrid of both modes on screen (mode decisions are baked in when components are constructed); the transcript now re-renders under the new mode, `/reload` does the same when the mode changed on disk, and a mid-turn switch is rejected instead of orphaning the live streaming components.
- **Noir polish.** Failed tool rows fold like everything else (the red diamond carries the signal; expand to read the error); durations no longer print `60s` or `1m00s` at the minute boundary; and mode themes or older custom theme files with missing slots fall back to the builtin dark theme's vars instead of throwing at render time.
- **Navigation-mode input hardening.** Emoji/IME input exits nav mode back to the prompt like a plain letter; horizontal trackpad tilt no longer scrolls the window; `/hotkeys` reflects the current Tab/Shift+Tab and Ctrl+E bindings.

## [0.10.10] - 2026-07-10

### Added

- **UI modes.** The chat is now a pluggable experience: `/ui <mode>` (or the `uiMode` row in `/settings`) switches between the builtin `loop` look — unchanged, still the default — and the new **`noir`** mode: the terminal background washes to a deep dark canvas (OSC 11, restored on exit), tool calls render as flat `◆ name` rows whose diamond carries the state (yellow running, green done, red failed), reasoning collapses to a `◆ Thought for Xs` row when the turn moves on, user prompts get a `❯` prefix with right-aligned timestamps, and each turn ends with a "Turn completed in Xs." line. Each mode owns its themes: loop keeps `dark`/`light`, noir ships `night` and `day`. Subagents render as the same rows with live status and run stats; the plan tool keeps its full box (it's an approval surface). Under the hood every mode is a style spec + block renderers over one registry, so future modes (and eventually extensions) plug into the same seam.
- **Transcript navigation.** `ctrl+e` toggles a navigation mode (also: `Esc` on an idle empty prompt, or `alt+↑` to jump straight to the last user turn): `↑/↓` walk every entry — user prompts, responses, thinking, tool calls — with a selection bar, `→/←` expand or fold the selected entry individually, `Enter` toggles it, `shift+←/→` jump between user turns, `e` expands everything, `y` copies the selected entry, and a click selects the entry under the pointer. The transcript renders in a window that follows the selection, scrollable with the mouse wheel, `PgUp/PgDn`, `ctrl+u/d`, and `Home/End` — expanding a huge tool output no longer flings the view, and a streaming turn no longer drags the window to the bottom while you read.
- **Thinking time survives resume.** Each reasoning block's wall-clock duration persists with the turn (`reasoningMs` on the message entry), so a reopened session shows the real "Thought for 3.2s" instead of forgetting.
- **`loop --session <id>` replays the transcript.** Opening a session by id used to restore only cost and context — now the conversation renders, like `/resume`.

### Fixed

- **An over-wide line no longer kills the TUI.** The renderer's width-overflow guard used to stop the UI and throw — the infamous dead screen where keystrokes echo below the input box. It now clamps the line, logs the evidence once to `loop-crash.log`, and keeps running. The welcome banner also truncates deep working-directory paths, and noir's one-line rows truncate long commands, closing the whole bug class.
- **Startup cleanses stale terminal modes.** A previous loop killed with SIGKILL never restored the terminal (kitty keyboard protocol, mouse reporting, background color) — the shell then echoed raw key reports like `[9;5u`. Launching loop now resets those modes first, and the crash safety net resets mouse reporting and the background wash too.
- **Aborted turns freeze their pending tools.** Interrupting a turn used to leave still-running tool boxes spinning forever; they now render as `· interrupted`, and resume shows whatever actually completed.
- **Resume matches the live view.** Subagent boxes replayed in finish order instead of stream order and with different spacing; a resumed transcript is now line-for-line identical to what streamed live.
- **Smooth wheel scrolling in navigation mode.** Trackpad micro-events that alternate direction on slow scrolls are coalesced into one net movement, so the window no longer flickers between the same lines; fast flicks are capped at a page.

## [0.10.9] - 2026-07-08

### Added

- **Todo items can be cancelled.** A step that turned out unnecessary gets `status: "cancelled"` instead of being deleted or fake-completed — the panel renders it as a struck-through `[-]` row, and a list whose items are all completed or cancelled retires into the scrollback as before.

### Changed

- **The agent no longer loses track of its own checklist.** Three fixes borrowed from the best of opencode, gemini-cli, and Claude Code: every todo write now echoes the full numbered list back as the tool result, so the current state lives where the model actually re-reads it; when auto-compaction summarizes away the last todo write, the active list is re-injected right after the summary instead of silently orphaning the pinned panel; and a gentle, never-persisted reminder nudges the agent when an active list has gone ten tool calls without an update — or, once per turn, when a long multi-step job never made one. The `todos` setting is still opt-in (default off).
- The todo tool's guidance grew the rules that make checklists trustworthy: completions are marked only after the work is verified, blocked steps stay in progress with a follow-up todo naming the blocker, and follow-ups discovered mid-job get captured instead of dropped.

## [0.10.8] - 2026-07-08

### Added

- **Todo checklists.** A new `todo` tool lets the agent keep a visible checklist during multi-step work, rendered as a pinned panel between the loader and the editor — `[>]` marks the step in progress, and a fully-completed list retires into the scrollback as one line. Lists persist with the session, so `/resume`, `/fork`, and `/tree` restore the branch's latest checklist. Opt-in: toggle `todos` in `/settings` (default off).
- **loop as a GitHub Action.** `uses: notshekhar/loop@v0` installs the released binary and runs a prompt headlessly in CI — the response lands in a step output, the job summary, and (with `post-comment: "true"`) a PR comment that updates in place on later pushes. Auth rides the caller's env (`ANTHROPIC_API_KEY` etc.), no config files. This repo now dogfoods it: loop reviews its own pull requests.
- **`loop run` grew CI manners.** `loop run -` (or piping with no prompt argument) reads the prompt from stdin — no shell-quoting a PR diff — and `--max-steps <n>` caps the turn.

### Fixed

- **Headless runs no longer exit 0 after a failed turn.** A turn-level stream error in `loop run` (bad key, dead endpoint) now sets exit code 1 instead of burying an `[error]` line in stderr — tool-level errors the agent recovers from still exit clean.
- **/context stopped ignoring extension prompt injections.** System prompt text added by extension `onSystemPrompt` middleware (the caveman/ponytail builtins, or any extension persona) now shows up as its own "Extension prompt" bucket instead of silently missing from the breakdown. The report also counts the conditional websearch/ask/todo tools when their settings enable them.

## [0.10.7] - 2026-07-08

### Added

- **Custom-provider OAuth setup no longer dead-ends.** The `/login custom` OAuth wizard now checks for `.well-known` metadata up front — when the server exposes none it asks for the authorization/token endpoint URLs, and when dynamic client registration is missing it asks for your client id, instead of failing mid-login with an error about config fields the wizard never offered.
- **Key-helper credentials survive restarts and can carry a real expiry.** The custom-provider "Command (key helper)" auth method now persists minted keys in `~/.loop/auth.json` until they expire, so interactive helpers (a vendor login that opens a browser) stop re-prompting on every launch. Helper stdout may also be JSON — `{"key": "…", "expiresAt": <epoch-ms or ISO>}` (`apiKey`/`token` and `expiresInMs` accepted too) — so the key's actual lifetime drives re-runs instead of the blind 5-minute TTL. A 401 still forces a fresh mint.

### Fixed

- **Hooks can read the transcript again.** Since sessions moved to SQLite, the `transcript_path` in hook payloads pointed at a JSONL file that was never written. The transcript is now materialized on demand right before a matching hook runs — hooks that read it (a common Claude Code pattern) see the real, current conversation, and configurations with no hooks write nothing.
- **/cd (and /cwd) now finds the target directory's sessions.** Session storage keys on the canonical path, but /cd stored the path as you typed it — so `/cd /tmp/x` (really `/private/tmp/x` on macOS) or a differently-cased path left `/resume` claiming the directory had no sessions.

### Changed

- The `/da` shortcut is gone; use `/data` for the data-analyst agent.
- Internal: the machinery the main turn loop and subagent runs share (request shaping, per-step billing, stream yielding) is now one module used by both, so fixes land in both loops by construction.

## [0.10.6] - 2026-07-08

### Added

- **loop now remembers.** The agent saves durable per-project facts — your preferences, project decisions, hard-won gotchas — as plain markdown files under `~/.loop/agent/memory/`, and recalls them in every later session through a small always-loaded index (full memories are read only when relevant, so your context stays lean). No hidden machinery: saves happen with the normal write tool, visible in the transcript like any file change, and the files are yours to edit or delete — `/memory` → "Agent memory (auto)" opens the index, `/context` shows what memory costs you. Toggle with `memory` in `/settings` (default on).
- **Parallel subagents.** When the model fans out several task calls in one step they now stream concurrently instead of one after another. `subagentMaxParallel` in `/settings` caps the concurrent provider streams (default 4, 0 = unlimited); excess tasks queue visibly and start as slots free up.

### Removed

- **Legacy one-time migrations retired.** The `~/.pi` → `~/.loop` config-dir move and the pre-v0.9 JSONL-session / cost.json / trust.json migrations are gone — every install has long since moved. If you're somehow upgrading from a pre-0.9 version, go through 0.10.5 first; database corruption recovery itself stays.

## [0.10.5] - 2026-07-07

### Fixed

- **Tool-box background colors now reach the right edge on Hindi and other Indic text.** Terminals like Ghostty attach a whole grapheme cluster to one cell pair (capped at 2 cells), so clusters like र्मा render narrower there than the per-codepoint sum loop used — the padding came up short and the colored fill stopped before the box edge. The startup width probe gained a third canary that detects this layout and calibrates cluster widths to match, verified cell-exact against Ghostty across Devanagari, Bengali, Malayalam, Tamil, and CJK.

## [0.10.4] - 2026-07-07

### Fixed

- **Hindi and other complex-script output no longer smears the screen while streaming.** The TUI measured every Devanagari-style grapheme cluster as one column, but terminals lay out conjunct consonants and spacing matras in their own cells — so long Indic lines overflowed the terminal width, auto-wrapped, and each repaint drifted, leaving a staircase of stale text. Cluster widths are now summed per codepoint the way terminals do it (covering Devanagari, Bengali, Tamil, Myanmar, Khmer, decomposed Korean, and friends), and on startup loop probes the terminal with two invisible canary clusters to calibrate against how it actually renders them.

## [0.10.3] - 2026-07-07

### Added

- **/daemon** — toggle the goals background scheduler from inside the TUI. Bare `/daemon` opens a panel showing whether it's on and offers the flip (install/uninstall the launchd agent / systemd user timer / Task Scheduler job); `/daemon on|off|status` skips the panel. `loop goals daemon install|uninstall|status` still works on the CLI. In-session daemon hints now point at `/daemon` instead of the CLI command.

## [0.10.2] - 2026-07-07

### Changed

- **Goal notifications and summaries show only the final response.** A goal run's summary — the desktop notification body, `loop goals run` output, and the stored last-run summary — is now the model's closing response after its last tool call (like a subagent's report), instead of the tail of everything it streamed along the way. Failed runs summarize the error instead.

## [0.10.1] - 2026-07-07

### Changed

- **Unscheduled goals now run immediately in the background.** `/goal convert utils.js to ts` (no time mentioned) fires a detached headless run right away — matching how background tasks work in other coding agents — instead of becoming a "standing objective". System-prompt injection of goals is removed entirely (use AGENTS.md for persistent instructions); the `goals` setting is gone with it. On-demand goals stay in the `/goal` panel for re-running.
- `loop sessions` shows the session name (e.g. `goal: …`) instead of the first prompt line when one is set, so goal runs are recognizable at a glance.

## [0.10.0] - 2026-07-07

### Added

- **Goals** — a goal is a stored objective tied to a directory. `/goal <text>` parses natural language with your current model (schedule words and agent mentions included: "check the deps every day at 9am with the plan agent") and confirms before saving; any parse failure just saves a standing goal. Standing goals are surfaced to the agent in the system prompt of every session in that directory (mute with the `goals` setting). Scheduled goals (once/cron) run **headless even when loop is closed** via `loop goals daemon install` — a launchd agent (macOS), systemd user timer (Linux), or Task Scheduler job (Windows, with desktop toasts) that ticks every minute. Each run is a normal, resumable session named `goal: …`, records status + summary on the goal, and fires a desktop notification. Every goal can pin its own model and agent (unset = your defaults at run time). Manage in the `/goal` panel (add, edit text/schedule/model/agent, run now, open last run, delete) or via `loop goals list|add|rm|run|tick|daemon`.
- **Plan delivery** — the plan agent now ends its turn by calling a `plan` tool with the finished plan instead of trailing off in prose. The plan streams live and renders as full markdown (it's the deliverable — never collapsed), then you choose **implement it** (pick an agent; the plan is handed over as a one-shot) or **talk about it** (keep refining with the plan agent). Custom planner agents opt in by naming `plan` in their tools list.

### Changed

- Session database schema is now v5 (goals table). Older loop builds refuse a v5 database — upgrade all machines sharing a config dir.

### Added

- **websearch tool** — web search via DuckDuckGo, no API key needed. Opt-in: flip `websearch` on in `/settings` (or `"webSearch": true` in settings.json). Returns the top results as title/URL/snippet — pass a result URL to the read tool to fetch the full page. Sponsored results are filtered out. Subagents inherit it, print mode gets it too, and custom agents can opt in by naming `websearch` in their tools list. Heads-up: it scrapes DuckDuckGo's HTML endpoint, which is unofficial and may rate-limit.

### Fixed

- **Streaming edit/write preview reads top-down.** While a file is being written, the content now streams above and the `… +N earlier lines (ctrl+e to expand)` hint sits below it — matching how the finished diff collapses.

## [0.9.9] - 2026-07-06

### Added

- **/context** — context-window usage breakdown: a colored 10×20 cell grid (each cell = 0.5% of the window) with per-category estimates (system prompt, system tools, MCP tools, workspace context, skills, messages, compact summary), free space with the auto-compact threshold, and a per-skill token list. The headline count prefers the provider-reported context size; categories are chars/4 estimates.
- **/cd** — move this session to a new working directory (with `~` expansion, relative resolution, and existence checks). The session is truly re-homed: `/resume` finds it under the new directory. `/cwd` is now an alias.
- **/memory** — pick a context-file location (global `~/.loop/AGENTS.md`, project `AGENTS.md`, `.loop/AGENTS.md`, directory-level; legacy CLAUDE.md honored) and open it in `$VISUAL`/`$EDITOR`, creating it if missing.
- **/doctor** — read-only diagnostics: version vs latest release, runtime, config dir, settings, session-DB integrity check, provider auth, model catalog, MCP server statuses, extensions, project trust, and optional binaries — each as a pass/warn/fail line.
- **/share** — upload the session as a **secret** GitHub gist via the `gh` CLI: a readable `transcript.md` (tool calls collapsed, raw tool outputs excluded) plus the raw `.jsonl` for `/import`. Confirms before uploading; URL is printed and copied to the clipboard.
- **/scoped-models + Ctrl+P** — pick a set of models in a searchable toggle panel (or `add <id>` / `rm <id>`), then cycle through them with Ctrl+P. Unavailable models are skipped automatically.
- **/recap** — generate the post-turn recap on demand for the last turn, regardless of the `recap` setting.
- **/init** — analyze the codebase and write (or improve in place) an `AGENTS.md`, run as a normal agent turn.
- **/release-notes** — alias for `/changelog`.
- **Type-to-filter in all toggle panels** — multi-select lists (scoped models, agent tool pickers, …) now have the same live search box as the single-select pickers. Space still toggles; printable keys filter.

### Fixed

- **Returning from an external editor no longer leaves the keyboard dead.** Terminal handoff (used by `/memory`) now blocks the event loop while the editor runs — the async version let renders fight the editor's screen and broke stdin on return.

## [0.9.8] - 2026-07-05

### Fixed

- **TUI re-synced with upstream pi-mono** (our editor/terminal layer is a light fork; this pulls everything fixed upstream since we vendored it, on top of our local changes):
    - Up arrow on the first line no longer hijacks you into prompt history while typing — it jumps to the start of the line; history opens only when the editor is empty, you're already browsing it, or the cursor is at column 0.
    - Streaming code fences render stably while output is arriving.
    - Markdown lists keep their original unordered markers, and loose lists get blank lines between items.
    - Overlays align correctly over CJK wide cells.
    - Autocomplete fuzzy filter understands slash-separated tokens (matching `foo/bar` paths piecewise).
    - Kitty image protocol is enabled under the Warp terminal.

### Added

- **Terminal color-scheme detection (groundwork)** — the TUI can now query the terminal background via OSC-11 and report light/dark, per upstream. Not wired to anything user-facing yet.

## [0.9.7] - 2026-07-05

### Changed

- **AI SDK upgraded across the board** — `ai` 7.0.15 and the latest provider adapters (xAI, Google, Groq, Mistral, DeepSeek, Cerebras, MCP). Verified against a live provider that tool-input streaming (the v0.9.6 fix) still works on the new versions.

## [0.9.6] - 2026-07-05

### Fixed

- **The pending tool box now actually appears while write/edit input streams — the real fix.** An AI SDK v7 field rename (`toolCallId` → `id`, `inputTextDelta` → `delta` on tool-input stream parts) was read through casts, so it never failed the build: every tool-input-start event carried an undefined id, the UI dropped it, and the box for write/edit only appeared once the complete call arrived — on every provider, since the v6→v7 upgrade. Verified end-to-end against a live provider this time. Note: how early the box shows still depends on the provider — Anthropic/OpenAI stream tool arguments token by token (the preview grows live); xAI's composer sends each call's arguments in one chunk shortly before the call completes, so the pending window there is inherently brief.

## [0.9.5] - 2026-07-05

### Fixed

- **Streaming write/edit no longer freezes the box in expanded tool view.** The live preview re-rendered on every input token, and expanded mode syntax-highlighted the entire content-so-far each time — on large files the pending box never painted until the input finished streaming. Rendering now coalesces behind a ~50ms flush, and the expanded preview highlights only the last 200 lines while streaming (the completed call still shows everything). The grey box now appears the moment the call starts, in both views.

## [0.9.4] - 2026-07-05

### Changed

- **`edit` streams its replacement text live, like `write`.** The edit box previously sat empty until the whole call finished (its nested input defeated the partial-JSON parser); the replacement text now fills the box as it streams, and the red/green diff still takes over when the call completes.

## [0.9.3] - 2026-07-05

### Added

- **Subagents can be continued — `follow_up`.** When an earlier task's report is missing a detail, the model no longer relaunches from scratch and re-pays the whole discovery run: passing `follow_up` with the earlier task call's id resumes that subagent with its prompt and full activity replayed as context (chains of follow-ups included). A stale id fails soft — the run starts fresh with a visible warning in the box.
- **Task boxes show what a run costs, live.** While a subagent works, its box title ticks `tool · step N · 41s · $0.0123` (elapsed time keeps ticking even when the provider is silent); a finished box reads `done · 12 steps · 41s · $0.0430`. Steps, duration, and the USD-stamped usage persist on the session entry, so `/resume` replays the same figures.
- **A stalled subagent aborts itself instead of hanging forever.** If the provider streams nothing for `subagentStallSeconds` (default 180, 0 disables) while a subagent is waiting on it, the run aborts with a visible `[stalled connection]` note; completed steps stay billed, the partial run persists, and the parent is told it can `follow_up` to continue from the partial work. The watchdog disarms while the subagent's own tools execute, so a long build can't false-trip it.
- **Reasoning tokens can carry their own price.** Some models (the Qwen family among them) bill reasoning output at a different rate than text output — up to several times higher. The catalog now ingests that rate from models.dev and the pricing math splits the output bill accordingly; models without a separate rate are priced exactly as before.
- **Ask-tool quality of life.** Digits 1–9 pick or toggle options instantly; Tab selects the highlighted option and attaches a short typed note to it (the note reaches the model as a clarification of the choice); in multi-select the cursor now starts on the first option instead of the confirm row, with `done` moved last.

### Changed

- **Esc in an ask prompt skips only that question.** Previously Esc on question 1 of 3 silently declined all three; the remaining questions now still show. Aborting everything stays on the turn interrupt (Ctrl+C / Esc on the turn).
- **A subagent handed a prompt with no instruction now says so** — one cheap bounce-back asking the main agent to re-issue the task, instead of inventing a plausible-sounding task and spending a whole run investigating it.

### Fixed

- **Aborting a turn mid-subagent no longer leaks the task box's ticker timer.**

## [0.9.2] - 2026-07-05

### Changed

- **The whole product is rename-ready.** Every brand-derived value — the `~/.loop` config dir, `<cwd>/.loop` project dir, all `LOOP_*` environment variables, the `loop://` docs scheme, the `"loop"` extension-manifest key, CLI usage text, OAuth client names, the user-agent — now flows from a single `brand.ts` per package instead of being hardcoded in ~90 files. A future rename is a three-line constant edit plus the `RENAME.md` playbook; config and extensions migrate automatically (as `.pi` → `.loop` once did).
- **The session database is now `agent.db`.** The filename is deliberately brand-free so renames never touch it. Your existing `~/.loop/loop.db` is adopted in place on first launch (an atomic rename, WAL/SHM sidecars included) — all sessions, cost history, trust decisions, and reminders carry over.
- **Faster cold start, correct migration ordering.** Config stores no longer touch the disk at import time (configstore eagerly wrote its defaults file on construction), which both keeps `--help`/`--version` disk-free and fixes an ordering hazard where the config dir could spring into existence before the legacy-dir migration check ran.

## [0.9.1] - 2026-07-05

### Added

- **The session database heals itself.** If `~/.loop/loop.db` fails its integrity check — or is too damaged to even open — loop now sets the damaged file aside (kept as `loop.db.corrupt-<timestamp>` for forensics), starts a fresh database, salvages every readable row from the damaged one, and re-imports your retained JSONL transcripts to fill whatever couldn't be read. Your frozen pre-ledger cost baseline is carried over too. Previously a corrupt database was only logged and you ran on it anyway.

### Changed

- **Auto-compaction now counts the whole request.** The context estimate that decides when to compact previously ignored the system prompt and tool definitions — 10–20k tokens with workspace context and skills loaded — so compaction could kick in later than it should and a long turn could hit the window. The same honest estimate now also anchors interrupted-turn cost estimates.
- **Cleaner output: no more emoji and icon prefixes.** The `✓`/`✗` prefixes on login, MCP, extension, and cost-audit messages are gone, as is the gear on hook lines — color already says what happened. Recaps now read `※ recap: …`, and `/steak` keeps its 🥩 (the pun is the feature).
- **Long sessions walk their history faster** — the transcript branch walk was accidentally quadratic in session length; it's linear now.

## [0.9.0] - 2026-07-05

### Added

- **Every dollar is now on the record — the cost ledger.** Each billed API round-trip (turn step, subagent step, recap, compaction, branch summary) writes one append-only row with the exact token quantities, the per-MTok prices it was computed from, and the resulting USD. Resuming a session shows the dollars it was billed live — never a re-price against today's catalog — and `/cost`'s lifetime/today/7-day/month/per-folder views are sums over these rows, so two loop instances always see each other's spend instantly. Your pre-existing totals carry over exactly: the old cost.json is frozen in as a baseline, and old sessions get backfilled rows so reopening one still shows a sensible figure.
- **Compaction and branch summaries are billed now.** Both make real API calls that were previously invisible to cost tracking; they now record their spend and stamp their usage on the transcript.
- **`loop cost audit`** — verifies the ledger reconciles: every row's quantities × its price snapshot must reproduce its recorded USD, and per-session ledger sums must match the transcripts. Exits non-zero on any discrepancy, so you can put it in a cron.

### Changed

- **Everything session-adjacent now lives in one SQLite database.** Folder trust decisions (`trust.json`), per-project model memory (the `projectModels`/`projectProviderModels` settings keys), and reminders (`reminders.json`) migrate automatically into `~/.loop/loop.db` on first launch — completing the storage move v0.8.0 started. The old files stay on disk untouched as a downgrade path; the two settings keys are removed so settings.json stops accumulating directory lists. No behavior changes: trust prompts, `/model` memory, and reminders work exactly as before.
- **`/steak` counts only real tokens.** Interrupted-turn estimates (the `~` amounts `/cost` never bills) no longer inflate the daily heatmap.
- **Faster startup on big databases.** The full integrity scan now runs only after an unclean exit instead of on every launch.

### Fixed

- **Recap boxes survive resume.** Persisted recaps were double-wrapped on reload and silently disappeared from replayed sessions.
- **Delegation-only turns no longer lose their cost.** A step whose only output was a task (subagent) call dropped its usage on resume — undercounting session cost and `/steak`.
- **Auto-compaction can no longer break the next request.** A compaction cut that landed on a tool result orphaned it from its tool call, and the next Anthropic request failed with a 400.
- **The session database is checkpointed on exit**, so the write-ahead log no longer grows unbounded across long-running sessions.
- **Old sessions imported from headerless transcripts** stored a mangled directory slug as their working directory and never appeared in `/resume` for that folder.
- **Concurrent RPC sessions no longer share read-before-edit state** — one session's file reads can't unlock edits for another.
- **`/cost`'s 7-day window is DST-safe**, and a sync extension middleware returning a Promise from `onProviderOptions` can no longer corrupt the request options.

## [0.8.5] - 2026-07-04

### Added

- **Subagents can run on their own model — including a different provider.** Give any agent a `model:` line in `~/.loop/agents/<name>.md` (or set it from `/agents` → the agent → `model:`), and every task-tool run of that agent uses it: drive the session on a big model, fan exploration out to a cheap fast one. A new `subagentModel` setting in `/settings` sets the default for all subagents that don't pick their own; unset = inherit the parent's model, exactly as before. Built-ins (`plan`, `data-analyst`, `default`) accept a model via their override file too. Fail-soft by design: if the configured model isn't in the catalog or its provider isn't logged in, the subagent runs on the parent's model and says so at the top of its task box — a stale agent file never bricks delegation. Cost tracking follows the model that actually ran.
- **Bash approval prompts — an opt-in permission gate, like Claude Code's.** Turn on `bash approval` in `/settings` (default off) and every bash command pauses for you first: **allow once**, **always allow**, or **deny** (Esc denies). "Always allow" remembers a scoped pattern — `git status`, `npm install`, bare `ls` — in a new `bashAllow` list you can manage from `/settings` → bash allowlist. Matching reuses the denylist's command parser, so a compound like `ls && rm -rf /` still prompts even with `ls` approved, and `sudo`/`sh -c`/`$( )` can't smuggle a command past you. The denylist still wins over everything; a deny tells the model you declined this command this time, so it continues without hunting for workarounds. Interactive mode only — `loop run` and RPC behave exactly as before. Subagent bash calls go through the same gate.
- **Custom providers can sign in with OAuth.** The `/login` custom wizard gains an **OAuth (browser sign-in)** option for gateways fronted by an authorization server: endpoints are discovered from the base URL (RFC 8414 / OIDC well-known), the client registers itself dynamically (RFC 7591) when allowed, and the PKCE browser flow falls back to paste-the-code for headless/remote sessions. Tokens live in the auth store and refresh automatically — including on servers that omit `refresh_token` from refresh responses, which previously forced a re-login every launch. Explicit `issuer`/endpoints/`clientId`/`scopes` remain available as escape hatches for servers without discovery or anonymous registration.
- **`/alias` — your own shorthand commands.** `/alias s /model claude-sonnet-5` makes `/s` do exactly that; `/alias` lists, `/alias rm <name>` deletes. Aliases persist in settings, expand with any extra arguments appended, can chain into other aliases (cycles are cut off safely), and can never shadow a real command — if a later version claims your alias's name, the built-in wins.

## [0.8.4] - 2026-07-04

### Fixed

- **Resumed sessions now show their true historical cost.** Previously the session total was re-priced on every resume against whatever model catalog the current machine had — so resuming on a laptop that didn't know the model (or after switching to a cheaper/free one) could show `$0.00` for a session that really cost money. Every assistant turn and subagent run now records the USD it was actually billed at, with the full split (input / output / cache read / cache write), and resume reads that instead of re-pricing. Old sessions without the stamp keep the previous catalog-based fallback, so nothing breaks — their totals just stay as accurate as before, while everything from this version on is exact forever, on any machine.

## [0.8.3] - 2026-07-04

### Added

- **Amazon Bedrock support — zero login.** If your machine is signed into AWS (aws CLI profiles, SSO, or env keys), the new `bedrock` provider appears automatically in `/provider` and `/model` with the models **your account can actually invoke** in the region — cross-region inference profiles (`us.anthropic.claude-…`) plus on-demand foundation models, fetched live from Bedrock and cached for an hour. Pricing and context windows are inherited from the underlying vendor model, so cost tracking stays real for Claude/Mistral/etc. Region comes from `AWS_REGION` / `AWS_DEFAULT_REGION` / your profile (override with `LOOP_BEDROCK_REGION`); `AWS_BEARER_TOKEN_BEDROCK` API keys work too. `/login bedrock` verifies the setup and tells you what's wrong when it isn't (no credentials, no Bedrock access in the region, no model access granted). Nothing is copied into loop's auth store — inference uses the standard AWS credential chain, so EC2 instance roles also work.
- **Custom providers can now authenticate however your gateway does.** The `/login` custom wizard asks how the endpoint authenticates: classic **API key** (vendor header), **Bearer token** (always `Authorization: Bearer` — gateways with their own tokens), **environment variable** (read at request time, never stored on disk), **key helper command** (shell command whose stdout is the key — vault/SSO short-lived tokens, cached 5 minutes and re-run on 401, Claude Code `apiKeyHelper` semantics), or **none** (headers-only / mTLS / open endpoints). Model discovery uses the same resolved credential, and legacy flat `apiKey` configs keep working unchanged.
- **`write` streams into its tool box live.** The file path and content now render as the model streams them — a big file write shows a growing, syntax-highlighted tail instead of a silent pending box that pops in only when the call completes.

### Changed

- **The `ask` tool asks better questions.** Its guidance now spells out when a question is warranted (a decision only you can make) versus what it must resolve itself (facts in the code, conventional defaults), and it always puts its recommended option first, labeled " (Recommended)".

## [0.8.2] - 2026-07-03

### Added

- **The agent can now ask you questions mid-turn — new `ask` tool, off by default.** Toggle "ask user (questions tool)" in `/settings` (or set `"askUser": true` in `~/.loop/settings.json`) and the model can pause a turn to ask up to 4 multiple-choice questions when it genuinely needs a decision — which approach to take, what scope you meant. Each question is an arrow-key menu with a topic chip, per-option descriptions, and an automatic **Other** entry that opens a free-text editor for a custom reply; multi-select questions toggle with Enter/Space and confirm via a `done` row. Esc skips the question (and any remaining ones) and the turn simply continues — the model is told you declined and proceeds on its own judgment. The tool is never offered in `loop run` / non-interactive mode, and subagents and restricted agents don't get it unless their tool list names `ask`.

### Fixed

- **Esc no longer kills the whole turn while a menu or prompt is open mid-turn.** Previously the busy-turn Esc-to-interrupt handler ran before any open selector saw the key, so extension `api.ui` menus opened during a turn could never be cancelled without aborting everything. Esc now reaches the focused menu (cancel/skip); Esc during plain generation still interrupts as before.

## [0.8.1] - 2026-07-02

### Added

- **Ctrl+G sends "continue".** The resume-after-interrupt ritual — reopen the session, type `continue`, hit enter — is now one keystroke. Fires only while the agent is idle and the prompt has focus, goes through the normal submit path (hooks, transcript, queue all behave as if you typed it), and is listed in `/hotkeys`.

## [0.8.0] - 2026-07-02

### Changed

- **Sessions now live in a single SQLite database (`~/.loop/loop.db`) instead of one JSONL file per transcript.** On first launch, every existing transcript is migrated automatically — your sessions, names, branches, and usage history all come along, and `/resume` ordering is preserved. The original `.jsonl` files are **left untouched on disk**, so downgrading to 0.7.x just works (sessions created on 0.8.0 won't appear there, but nothing is lost or rewritten). This retires the whole class of file-corruption bugs patched over the last releases — torn-tail writes, per-append lockfiles, cross-process lost updates — by construction: appends are transactions, `/resume` is an indexed query instead of a directory scan, and two loop processes can write concurrently under WAL. `/export` and `/import` still speak JSONL, unchanged.

## [0.7.19] - 2026-07-02

### Fixed

- **A crash mid-write can no longer corrupt the next message you send.** If loop (or the machine) died halfway through appending a transcript entry, the file was left with a torn final line and no trailing newline — and the _next_ append glued its JSON straight onto that fragment, so one crash silently destroyed a second, perfectly valid entry. Appends now check the file tail under the write lock and start on a fresh line, keeping the torn fragment isolated (recovery already skips it). Relatedly, a single corrupt line no longer hides an entire session from `/resume` — the picker now skips the bad line the same way session loading does, instead of dropping the whole transcript from the list.
- **Cost tracking is now safe across concurrent loop instances and corrupt stores.** Two sessions running at once could silently erase each other's lifetime/daily spend (each accumulated onto its own stale cache and rewrote the whole file); every write now re-reads the store first. A corrupted number in `cost.json` used to turn the lifetime total into `NaN` forever; stored values are now sanitized on read. Also fixed on resume: a step's usage could be double-billed if it produced two assistant messages, and the context meter adopted a _subagent's_ context size when the transcript ended on an aborted task — it now tracks the main conversation's last turn. (And the test suite no longer writes into your real `~/.loop/cost.json`.)
- **Extension installs fail fast and load reliably.** `loop install owner/repo#branch` actually installs that branch now (the `#ref` was silently dropped — you always got the default branch); incompatible or broken extensions are rejected at install time with the reason, instead of surfacing as a cryptic warning next session; the API compat check now treats 0.x minors as breaking (an extension built for API 0.1 no longer loads on the 0.3 host and misbehaves at runtime); a hung registry can no longer wedge `loop install` forever (5-minute timeout, and the installer's output now appears in error messages); crashed installs no longer leave `.staging-*` junk behind; and `/reload` genuinely reloads an edited extension — the module cache is busted per load, where before it silently re-activated the old code.
- **Extension host cleanups:** load warnings are replaced per reload instead of accumulating duplicates forever; overriding a built-in command no longer wipes the fields your override didn't specify (e.g. its description); and the extensions/settings stores re-read from disk before each write so two loop processes can't clobber each other's records.

### Added

- **`loop rpc stop`, and a daemon that cleans up after itself.** The socket daemon now removes its socket and pid file on SIGTERM/SIGINT, refuses to start when another live daemon already owns the pid file instead of silently stealing its socket, and `loop rpc stop` (previously "not implemented") terminates it via the pid file. Requests also wait for startup (extensions, commands) to finish, and sending to a session that already has a turn running is rejected cleanly instead of interleaving two turns into the same transcript.
- **`LOOP_DEBUG=1` breadcrumbs.** Errors loop deliberately swallows (best-effort persistence, corrupt-line skips) now leave a trace in `~/.loop/debug.log` when enabled — a failed transcript write was previously invisible, full stop.

### Changed

- **Session housekeeping is faster.** The `/resume` list no longer re-reads and re-parses every transcript on every open (per-file cache, invalidated by mtime — an append always busts it), and each turn step now persists all its messages under a single file lock and write instead of locking per message.

## [0.7.18] - 2026-07-01

### Added

- **`loop mcp` — manage MCP servers from the command line, like `claude mcp` / `codex mcp`.** Previously MCP servers could only be added through the interactive `/mcp` panel; you can now add and manage them in one shot from your shell. `loop mcp add --transport http docs https://code.claude.com/docs/mcp` adds a remote server; `loop mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/code` adds a local stdio one (everything after `--` is the command, verbatim). Auth follows the usual conventions: `--header "Authorization: Bearer ${env:TOKEN}"` for static-header servers (the `${env:VAR}` placeholder resolves at connect time, so secrets stay out of the config file), `--oauth` for servers that use browser sign-in (then `loop mcp login <name>` runs discovery → consent → token exchange; `--client-id`/`--client-secret`/`--oauth-scopes` cover providers like Figma that block anonymous registration), and `--env KEY=VALUE` for stdio environments. `--scope user` (default, `~/.loop/settings.json`) or `--scope project` (`./.loop/mcp.json`, shareable via the repo). Rounded out with `list`, `get`, `remove`, `enable`/`disable`, `login`, and `add-json`.

### Fixed

- **The `/tree` view now renders tool steps legibly.** Tool rows previously showed an empty `[tool]:` and tool-call turns read as `assistant: (no content)`, because a tool result only stores a `toolCallId` reference and the renderer only knew how to display plain text. Each tool result now resolves back to its originating call and shows the same one-line summary as the live view — `read src/foo.ts`, `bash git status`, `grep TODO in src` — so a session's tool activity is readable and, crucially, you can once again see clearly where a branch was taken (the connector art was always there; it was just surrounded by blank rows). Tool rows are also searchable by tool name and arguments now.

### Changed

- **The `loop rpc` JSON-RPC server now streams the full turn.** It previously forwarded only 7 event types, so a client saw no reasoning/thinking, no subagent activity, no live per-step cost, and tool boxes that appeared late; it now forwards every turn event, and the list is checked at build time so it can't silently fall behind again. Added a `session.history` method (transcript replay for reconnecting clients) and a `server.info` capabilities handshake.

## [0.7.9] - 2026-06-28

### Added

- **`/steak` — a GitHub-contributions-style heatmap of your token usage.** A calendar wall of one square per day, shaded by total tokens (input + output) consumed, with relative quartile intensity so it reads the same whether you burn 10k or 10M a day. It's reconstructed from your session transcripts on disk, so the graph is full of history on first run rather than starting blank. `/steak` shows the trailing 52 weeks; `/steak <year>` (e.g. `/steak 2026`) shows a specific calendar year as a complete frame, with not-yet-happened days drawn as empty cells to fill in. The same heatmap now also leads the `/cost` output (trailing year), above the dollar breakdown.

## [0.7.7] - 2026-06-27

### Fixed

- **`/reload` now actually picks up MCP server and settings changes from disk.** The "hard reload" claimed to re-read every config surface but silently served stale data: it never refreshed the cached `settings.json` (the in-memory `CachedStore` is only invalidated via `refresh()`, which nothing called), and it never touched MCP at all. So servers added, removed, or edited in `settings.json` stayed invisible after `/reload`, and theme / `mcp` toggle / user-level hook edits made directly on disk were ignored — every `getSetting()` kept returning the value cached at startup. `/reload` now drops the settings cache first (so theme, hooks, MCP gating, and the server list all re-read from disk) and tears down + reconnects MCP (`close()` resets the manager so `init()` runs again instead of no-op'ing on its already-initialized flag). MCP reconnects in the background, same as the `/settings` mcp toggle.

## [0.7.6] - 2026-06-27

### Fixed

- **No more stray escape sequences in the shell after an interrupted exit.** The terminal-restore on teardown (kitty keyboard protocol + modifyOtherKeys) only ran on loop's normal exit path, so an _uncaught_ `SIGINT` — exit code 130, e.g. a Ctrl+C that lands during startup, while a child process owns the terminal, or forwarded by a parent like `bun run dev` — killed the process before the reset ran, leaving the protocols enabled and the shell echoing raw escapes like `^[[27;5;13~` on the next keypress. The TUI now installs a synchronous exit/signal safety net (`exit`/`SIGINT`/`SIGTERM`/`SIGHUP`) that restores the terminal via `fs.writeSync` even when the normal teardown never runs, then exits with the conventional `128+signo` status. (The earlier v0.7.1 fix made the reset unconditional but couldn't help when teardown wasn't reached at all.)

## [0.7.5] - 2026-06-27

### Added

- **Tool calls show a pending box the moment they start, then resolve to done.** Previously a tool with a large input — most visibly `write` (the full file content) and `edit` (the old/new strings) — only appeared once its entire input had finished streaming, so it popped in late instead of reading as in-progress. Every tool now renders a pending (grey) box as soon as the call begins (on the AI SDK's `tool-input-start`), fills in its arguments when they arrive, and turns green on completion — consistent across all tools.

### Fixed

- **`bash` commands can no longer run unbounded.** The timeout was optional with no default, so a command run without one — a hung process, a server left in the foreground — could run forever (in one case 30+ minutes). Bash now defaults to a **120-second** timeout, capped at **600 seconds**; the model can still request a longer timeout up to the cap for builds or installs. On timeout (or interrupt) the entire process tree is SIGKILLed, so nothing is left running in the background.

## [0.7.4] - 2026-06-27

### Changed

- **The thinking level now sits right after the model in every status-line layout.** It was previously scattered — after the context bar in `compact`, mid-dashboard in `vitals`, at the very end in `tokens`/`minimal` — and the `bar` layout omitted it entirely. Every layout (`compact`, `vitals`, `tokens`, `flex`, `powerline`, `minimal`, `bar`) now places it immediately next to the model. It stays gated on whether the model actually reasons and a non-off level being selected, so non-reasoning models (e.g. `composer-2.5`) still show nothing.

### Fixed

- **Errors now surface the real failure code instead of collapsing to a vague message.** loop reads the underlying syscall code — `EPERM`, `ECONNREFUSED`, `ENOENT`, `ETIMEDOUT` — and shows it like `fetch failed (ECONNREFUSED)`, walking the `.cause` chain that Bun/Node bury the real error inside (a flat read missed it). Machine-level failures (blocked permissions, refused network) are now diagnosable instead of reading as "unknown error". Provider/HTTP-status error formatting is unchanged.

## [0.7.3] - 2026-06-26

### Fixed

- **The `vitals` status-line layout no longer bloats memory.** Its background sampler spawned a `pmset` subprocess on every 1-second tick to read the battery level. Under Bun a per-second child-process spawn keeps inflating the allocator's high-water mark — RSS that's never returned to the OS — so a session sitting on the `vitals` layout crept from the usual ~50–60 MB up to ~190–200 MB. Battery has been removed from the dashboard entirely; the sampler is now a pure in-process read (`cpu` · `mem`) and never spawns a subprocess, keeping the layout at baseline memory.

## [0.7.2] - 2026-06-26

### Fixed

- **Reopened sessions no longer lose most of a turn's content.** A turn that used a tool (so the model answered across multiple steps) only ever persisted its first step — the final answer, and its token usage, were dropped on the way to disk. Reopening the session (or even the next turn in it) showed the turn truncated to the tool call. Every step's messages are now persisted, so the full turn survives a reopen and feeds back into the model's context intact.
- **Interrupting a response is now remembered.** When you interrupt mid-answer, the partial response is kept and the turn is marked interrupted, so the next turn's context tells the model its previous answer was cut off instead of silently dropping it. The `interrupted` flag (and the per-message model stamp used for cost) now survive a reload from disk.
- **Interrupted responses are no longer billed at $0.** The model provider charges for the input and the partial output of a request you interrupt, but the SDK reports no usage on abort, so loop counted it as free. The interrupted request's cost is now estimated — output from the partial text, input anchored to the adjacent real step's actual token/cache split — added to the session total (never the persistent lifetime/daily totals) and shown with a leading `~` so it reads as an estimate.

## [0.7.1] - 2026-06-26

### Added

- **Status-line layouts in the `statusline-themes` extension.** Beyond recoloring, the built-in now offers full custom layouts via `/statusline`: `compact` (model · context bar · tokens), `vitals` (a live dashboard with ctx% · tokens · cached · cache-hit% · cost · clock · cpu · mem · battery), `tokens` (in/out/cached/total economics), `flex` (a three-row powerline dashboard), `powerline`, `minimal`, and `bar`. Color themes (now `/statuscolor`) compose on top of any layout. Every layout leads with the selected agent and the model, gates the thinking level on whether the model actually reasons, and is responsive — dense layouts wrap onto extra rows and others shed lowest-priority segments so nothing runs off a narrow terminal.
- **`api.statusLine.refresh()`** lets an extension request a repaint for live fields (e.g. the vitals clock/CPU) that change without user action; no-op in print mode. `StatusLineContext` gained a `reasoning` flag. Extension API bumped to `0.3.0`.

### Fixed

- **No more stray escape sequences in the shell after Ctrl+C.** On teardown the terminal now resets the kitty keyboard protocol and modifyOtherKeys unconditionally instead of gating on tracked flags, which a fast exit racing the startup negotiation could leave out of sync — stranding modifyOtherKeys enabled so the shell echoed raw escapes like `^[[27;5;13~` on the next keypress.

## [0.6.4] - 2026-06-25

### Fixed

- **"Update available" notice now sits under the welcome banner.** The async update check used to append its line to chat history, so it landed at the bottom (below the conversation) whenever the network resolved. It's now shown as a line in the welcome masthead, and is preserved across `/new` and `/clear`.

## [0.6.3] - 2026-06-25

### Added

- **Extensions can drive interactive UI and auth.** New `api.ui` (`select` / `search` / `prompt` / `note` / `error`) gives extensions the same menus/prompts the built-in panels use, and `api.auth` (`getSecret` / `setSecret` / `openExternal` / `loopbackOAuth`) adds namespaced secret storage plus a localhost OAuth flow — enough to build the whole MCP feature as an extension. `api.ui` throws in non-interactive (`-p`) mode.
- **Customizable status line.** The block under the input box (formerly `CostFooter`, now `StatusLine`) is extensible via `api.statusLine.add(fn)` (append segments to a row) and `api.statusLine.transform(fn)` (rewrite the rendered rows). Contributors get a `StatusLineContext` (agent, model, session, cost, context, cwd, width) and are sandboxed so a throwing extension can't break the render.
- **New built-in extension: `statusline-themes`.** Enable it for a `/statusline` command that opens a searchable menu to recolor the status line — 12 themes including `matrix`, `ocean`, `sunset`, `synthwave`, `fire`, `rainbow`, plus `heat`/`neon`/`gold`/`cyber` adapted from the AKCodez status-line palette. `/statusline <name>` switches directly. Disabled by default.

## [0.6.2] - 2026-06-25

### Fixed

- **Tab is now reserved for completion.** While typing a slash command (or an `@` file reference), Tab completes it. Cycling through agents is now **Shift+Tab** only — plain Tab no longer cycles. This also fixes a bug where pressing Tab on terminals without the Kitty keyboard protocol opened the macOS file picker (Tab and Ctrl+I share the same byte, `0x09`).

## [0.6.1] - 2026-06-25

### Changed

- **Active extensions are visible.** Enabled extensions show in the startup status block (with workspace context) — e.g. `extensions: lsp · ponytail (full) · caveman (full) · rtk (on)` — and reappear after `/new` and `/clear`. Extensions can report a one-line status via `api.extension.setStatus`.
- `rtk` shows `rtk (no binary)` when the `rtk` CLI isn't installed, with `/rtk` linking to the installer.

## [0.6.0] - 2026-06-24

### Added

- **Extensions.** loop now has a JavaScript/TypeScript extension system — write or install extensions that add or override almost everything: slash commands, tools, providers and the models inside them, agents, skills, settings, the system prompt, and the turn loop. Extensions are plain Bun/TS packages (no build step) and may carry their own npm dependencies, resolved by the Bun runtime shipped inside the loop binary.
    - Install from npm, GitHub (`github:owner/repo`), or a local path: `loop install <spec>`, `loop link <path>` (dev), `loop list`, `loop enable`/`disable`, `loop remove`. In-session: the `/extensions` panel and `/install`.
    - Tool control: add/remove any tool (the default agent gets every tool automatically), `onCall` to rewrite or block a tool's input pre-execution, `onResult` to transform its output, and grant a tool to a restricted agent.
    - Providers: register a whole provider plus its models — declarative (OpenAI/Anthropic/Google-compatible) or imperative — appearing in `/model`, `/login`, and cost tracking like a built-in.
    - Turn middleware can shape the system prompt per agent, add/remove tools, and tweak provider options each turn.
    - Authoring guide: `read loop://docs/extensions.md`.
- **Built-in extensions** (pre-installed, disabled by default — enable with `loop enable <name>` or `/extensions`):
    - `lsp` — appends type/lint diagnostics after `write`/`edit` via auto-provisioned language servers.
    - `ponytail` — the "lazy senior dev" persona: write the minimal solution (`/ponytail lite|full|ultra`).
    - `caveman` — ultra-terse replies for fewer tokens (`/caveman lite|full|ultra|wenyan-…`).
    - `rtk` — rewrites bash commands through the `rtk` binary to compress output (no-op if `rtk` isn't installed).

## [0.5.3] - 2026-06-19

### Changed

- **Dropped the `lp` short alias.** `lp` collided with the preinstalled CUPS printer command (`/usr/bin/lp`), so depending on PATH order `lp` could run the printer instead of loop. The command is now just `loop` (with `agent` as the alias). On upgrade, the installer removes any old `lp` symlink and strips the `lp` shell alias a previous version may have added to your shell rc.

## [0.5.2] - 2026-06-19

### Fixed

- **`lp` no longer collides with the system printer.** The short `lp` alias shares a name with the preinstalled CUPS `lp` command (`/usr/bin/lp`); on machines where loop's bin dir sat behind `/usr/bin` in PATH, typing `lp` ran the printer instead of loop. The installer now adds an `lp` shell alias as a fallback when its symlink doesn't win the PATH lookup, and the install summary only advertises the command names that actually resolve to loop on your machine.

## [0.5.1] - 2026-06-18

### Added

- **Animated welcome banner.** Startup now shows a masthead with a pixelated `loop` ring on the left — a bright "comet" head chases its way clockwise around the square (corners filled), spins for two rotations, then settles into a static hollow ring that reads as a loop. Beside it: the greeting, model · session · agent, cwd, and the tips line. The banner also re-appears on `/new` and `/clear`, which previously left the screen empty.

## [0.5.0] - 2026-06-18

### Changed

- **Renamed `pi` → `loop`.** The command is now `loop`, with `lp` (short alias) and `agent` also starting it. Config moved from `~/.pi` to `~/.loop`, and all `PI_*` environment variables are now `LOOP_*` (`LOOP_KEY`, `LOOP_DIR`, `LOOP_MCP_*`, `LOOP_SANDBOX_*`, `LOOP_FROM_SOURCE`, …). Package names are now `@notshekhar/loop{,-core,-tui,-sandbox}`.
- **Automatic, lossless config migration.** On first run, an existing `~/.pi` from a pre-0.5.0 install is moved to `~/.loop` (copied, then the old dir removed only after the copy succeeds) so auth, sessions, and settings carry over with no loss. Handled by both the installers and the app itself, so npm/source/binary installs are all covered.
- Build is now pure Bun — dropped the `tsc` declaration-emit step (and the `typescript` dependency); `bun build.ts` handles every package.

### Removed

- Dropped upstream `pi`-session compatibility: the `piCompatMode` setting and its special fork-on-open handling are gone. `loop` reads and writes its own sessions only. (The `/fork` command and per-entry forking are unaffected.)

## [0.4.5] - 2026-06-18

### Added

- Global instructions: `~/.loop/AGENTS.md` and `~/.loop/CLAUDE.md` are now loaded into workspace context in every session, regardless of the working directory — mirroring Claude's `~/.claude/CLAUDE.md`. Previously context files were only read from the cwd up to the repo root, so there was no place for user-wide rules. pi writes `AGENTS.md` by default, but a user-authored global `CLAUDE.md` is honored too. Workspace `AGENTS.md`/`CLAUDE.md` files still apply on top.

## [0.4.4] - 2026-06-18

### Added

- xAI **Composer 2.5** (`xai/composer-2.5`) is now in the model catalog — xAI's agentic coding model. It's callable via the xAI API even though it isn't listed by `/v1/models` (subscription/preview).

### Changed

- The thinking level is now hidden for models that don't reason. composer-2.5 reasons internally but rejects the `reasoningEffort` parameter, so the footer no longer shows a thinking level and `/thinking` reports "current model does not support thinking" — matching pi-mono, which gates both on the model's `reasoning` capability. (Also applies to other non-reasoning models like grok-3.)

## [0.3.51] - 2026-06-17

### Added

- The `read` tool now shows its line range in the tool title when called with `offset`/`limit` (e.g. `read src/app.ts:200-249`), so partial reads of large files are visible at a glance — matching pi-mono.
- README now documents the bash OS sandbox (the `sandbox` setting: network/filesystem boundaries, fail-open for normal agents vs. fail-closed for the read-only `plan` agent) and the bash denylist (`bashDeny`, wrapper/`sh -c`/substitution resolution, guardrail-not-a-sandbox).

### Changed

- Internal clean-up with no behavior change: the interactive app orchestrator and turn runner were split into focused modules (footer refresh, working indicator, ticker, turn-emitter wiring, subagent streaming), and a dead duplicated copy of the tool utils was removed.

## [0.3.50] - 2026-06-17

### Added

- OS-level sandbox for the bash tool, in a new `@notshekhar/loop-sandbox` package (ported from anthropic-experimental/sandbox-runtime, Apache-2.0). On macOS it generates a Seatbelt profile and runs commands under `sandbox-exec`; filesystem writes are confined to the working directory (+ temp), and network is deny / allow / per-domain allowlist (HTTP + SOCKS5 filtering proxies). Off by default — enable via `sandbox` in `~/.loop/settings.json`. Fails open with a warning for normal agents when it can't be enforced. (Linux bubblewrap + socat bridge + seccomp are written but UNVERIFIED; Windows is a stub.)
- The plan agent now gets the `bash` tool for read-only investigation — but only where the OS sandbox can enforce it (macOS/Linux). Its bash is forced into a fail-closed, kernel-enforced read-only sandbox (no writable cwd), so it physically cannot mutate the filesystem; on platforms without sandbox support, bash is withheld entirely. The same guarantee applies to any agent (or subagent) allowed bash but not write/edit.
- `/bashdeny` — an interactive, searchable UI to add/remove bash commands the agent is refused, also reachable from `/settings` ("bash denylist"). No more hand-editing JSON.

### Changed

- An unrecognized `/command` is now treated as a normal message to the model instead of erroring (fall-through), so messages that merely start with `/` just work.
- The bash denylist refusal is now a short 2-3 line message framed as the user's intentional policy. Denylist entries are plain command strings (the per-entry `reason` field was removed); legacy `{pattern,reason}` entries in existing settings are tolerated and migrated to strings on next edit.

## [0.3.49] - 2026-06-17

### Fixed

- The bash denylist now sees through command wrappers and proxies, closing the easiest bypass. `rtk git commit` (and `rtk proxy git commit`), `sudo`/`env`/`xargs` prefixes, interleaved `VAR=value` assignments, and inline `sh -c "…"` / `bash -c "…"` scripts all resolve to the real command before matching — so `rtk git commit` is blocked just like `git commit`. This raises the bar against accidental and lazy evasions; it is still a guardrail, not a sandbox, and a determined model can defeat string matching by design.

## [0.3.48] - 2026-06-17

### Added

- Configurable bash command denylist (`bashDeny` in `~/.loop/settings.json`). Entries match by command name, optionally plus a subcommand prefix (`"git commit"` blocks `git commit -m …` but not `git status`); a `{ "pattern": …, "reason": … }` form attaches guidance the agent sees. Matching resolves full paths to their basename (`/bin/rm` → `rm`), looks past leading env assignments and wrappers (`sudo`, `env`, `xargs`, …), and scans every command in a pipeline or `$(…)` substitution. When blocked, the agent gets a refusal framed as a deliberate user policy — naming the command and explicitly ruling out workarounds — so it stops and redirects instead of hunting for an equivalent. Defaults to blocking `git commit` and `git push` (commit/push stay with the human); set the key to `[]` to allow everything. This is a guardrail, not a sandbox — bypassable by a determined model, by design.

## [0.3.47] - 2026-06-17

### Changed

- An unrecognized `/command` is no longer rejected with `unknown command`. If the leading `/token` doesn't match a registered slash command, the input falls through and is sent to the model as a normal message — so messages that merely start with a slash (paths, options, off-hand `/notes`) just work. Registered commands, including one-shot `/<agent> <message>`, still run inline as before.

## [0.3.46] - 2026-06-16

### Fixed

- Internal anchor links in rendered markdown (e.g. `[Section](#heading)`) no longer render as broken clickable links. The terminal has no way to act on a `#fragment` target — it would try to "open" it as a URL — and the TUI has no app-owned viewport to scroll, so these now render as plain styled text. External `http(s)`/`mailto:` links are unchanged and still open from hyperlink-capable terminals.

## [0.3.26] - 2026-06-12

### Added

- Searchable model picker: type to filter (substring over id/name/description) — practical for OpenRouter's huge list. `+ add model…` registers any `provider/id` to `~/.loop/models.json`, usable immediately; a wrong id just errors at chat time. Custom models are marked and removable from the picker.
- Subagents are now a fork of the spawning agent by default: same system prompt (including workspace context and skills), same tools (minus `task` — no nesting), fresh context window. The turn's agent is what forks — including one-shot `/<agent> message` turns. Passing `agent` to the task tool still runs a named agent, with its tools capped to the parent's. This replaces the `subagent-tools:` cap config (frontmatter line is ignored if present, the `/agents` cap picker is gone): the parent's own tools are the cap, so delegation can never widen access with zero configuration.

### Fixed

- Subagent reports now actually reach the main agent. The AI SDK invokes `toModelOutput` with an options object (`{ toolCallId, input, output }`); we read the wrapper as the output, so every report degraded to the "(subagent finished without a final response)" placeholder — the main agent would dismiss the run and redo the work itself. Pinned with a regression test matching the SDK's exact call shape.
- Aborting a turn mid-run (Esc) no longer loses its cost on resume: both the main loop and subagent loop keep a per-step usage sum and persist it when the run never reaches `finish`, so a resumed session seeds the real spend instead of $0. (The lifetime/daily store was always abort-safe — it bills per step.)
- Subagent runs on Anthropic-shaped providers (including anthropic-sdk custom gateways) now use prompt caching. The subagent loop sent no `cache_control` breakpoints, so every step re-billed its entire accumulated context at full input price — quadratic in steps; one long run burned 2.4M uncached input tokens (~$7 on Sonnet). The system prompt is anchored once and a moving breakpoint re-anchors the last message every step, so each step re-reads prior context at the 90%-discounted cache price. The same per-step moving breakpoint now also applies to long multi-step main turns.

### Changed

- Subagents no longer bloat the main context: the parent model receives only the subagent's final report (bounded to 24k chars via the AI SDK `toModelOutput` pattern) — never the subagent's intermediate tool calls or file contents. The full activity log stays UI-only.
- Subagent activity is now stored as structured parts (text / reasoning / tool, in stream order) instead of one flat string — display order matches the real run, and renderers can style each kind independently. Old sessions with string activity still replay. The report handed to the parent is the AI SDK's final response text, with a stand-in when the subagent never produced one (abort, tool-only finish).

## [0.3.25] - 2026-06-12

### Added

- The `read` tool now also fetches URLs: pass an `http(s)://` URL and it returns the page as readable text (HTML stripped, truncated, timeout + size caps). Available to every agent that has `read` — including plan and subagents — with no extra tool to wire.
- `/settings → subagents` toggle: master on/off switch for the task tool (subagents). Off → no agent gets `task`.

### Fixed

- Subagent activity log (the streamed `> read …` tool lines) now persists with the run and replays on session resume, above the report — previously only the final report came back.

## [0.3.24] - 2026-06-11

### Added

- Subagent tool caps: every agent now has a second tool config — what the subagents it spawns may use (`subagent-tools:` frontmatter, asked in `/agents` create/edit when task is selected). The cap intersects with the target agent's own tools, so delegation can never widen access (verified: plan's subagents physically have no write/edit/bash even when targeting an unrestricted agent). `task` is now selectable per-agent, and the built-in plan agent can delegate while staying read-only end to end.
- Shift+Tab cycles agents anytime (even with text typed); plain Tab still cycles on an empty prompt and stays autocomplete while typing. Cycle = active custom agent plus all built-ins.
- Read-before-modify enforcement in the tools: `edit` rejects files not read this session and stale edits after on-disk changes; `write` guards overwrites of existing unread files while new files/paths pass freely. Session-scoped — nothing persists, `/new` clears the slate.

### Changed

- Sharper built-in prompts: default agent (verify-before-done working style, scope discipline), plan agent (investigation method + delegation, hard read-only rules), and subagent run rules (self-contained reports, no scope creep, honest partials)

- Performance: cost tracking writes one file per step instead of three (configstore rewrites the whole file per set), hook config merging is cached between events, subagent streaming coalesces repaints on a 50ms tick, and the auto-compact estimate no longer re-stringifies the whole history every turn
- Internals: agent core split into focused modules (subagent, tool-hooks, model-messages, events), turn events and settings access are fully typed (typos fail the build), and a `bun test` suite now covers hooks matching, agent files, cost seeding, compaction context, and changelog parsing (runs in CI)

## [0.3.23] - 2026-06-11

### Added

- Per-project model memory: the last model/provider picked in a folder is restored next time pi starts there (CLI flag and resumed sessions still win; global default remains the fallback). Applies to `pi run` too.
- Live cost, usage, and context: the footer updates after every step (each API round-trip), including subagent steps — and aborted turns keep the cost of completed steps

### Fixed

- Resumed sessions no longer show `$0.0000 · in:0 out:0 · ctx 0` until the next message — cost, token usage, and the context meter are restored from the transcript's usage entries on resume (startup `-s` and `/sessions` alike), without double-billing lifetime totals
- Subagent runs persist in the session: resuming replays the task box (agent, prompt, report), counts the subagent's tokens in the restored cost, and keeps the report in the model's context so it remembers subagent findings across resumes

### Changed

- Subagents run on the AI SDK's native `ToolLoopAgent` (same pattern as the official subagents guide); the task tool returns a plain-text report instead of JSON, expanding the task box shows the full activity log (tool calls with arg summaries) above the report, subagent input rewrites no longer leak into the main chat, and the model is instructed to call `task` alone in its step

## [0.3.19] - 2026-06-11

### Added

- Subagents: the `task` tool lets the main agent launch any named agent (default, plan, customs) for a self-contained job in its own context window — subagent activity streams live inside the task tool's box, usage/cost aggregates into the session totals, tool calls run the same hooks tagged with `agent_id`, and `SubagentStop` hooks fire on completion. Restricted agents (plan) don't get the task tool, and subagents can't nest. `subagentMaxSteps` setting caps the loop (default 50).
- Tab on an empty prompt toggles between built-in agents (default ⇆ plan); hinted in the footer (`agent default (tab ⇆)`), startup banner, and `/hotkeys`. Autocomplete keeps Tab while typing.
- Subagent rendering: the task tool gets a purple box with live state in the title (`task plan read · <prompt>` → `done`/`failed`), streamed activity collapses/expands like any tool output
- Model catalog refreshes at runtime: new models and pricing are re-fetched from models.dev on the hourly stale-while-revalidate cycle and warmed up at startup — release binaries keep learning about new models
- `/reload` is a hard reload: theme, commands, prompts, skills, agents re-read from disk, and the model catalog force-refreshed from the network
- `/hooks` management: lists every loaded hook with its source (pi-user, pi-project, claude-user, claude-plugins, claude-project), adds/removes pi-owned hooks in `~/.loop/settings.json`, and copies imported Claude hooks into pi so they keep working without a Claude Code install

### Fixed

- Anthropic `text content blocks must be non-empty` (400) on sessions with aborted turns: empty assistant messages are no longer persisted, and existing ones are filtered out of the model context on read

## [0.3.17] - 2026-06-11

### Added

- Per-agent tools: pick the allowed tool subset when creating or editing an agent (`/agents`, stored as `tools:` frontmatter in `~/.loop/agents/<name>.md`); the model only receives the allowed tools, and the system prompt lists exactly what's available
- `/plan` built-in agent: read-only planning agent (read, ls, grep, find) that explores the codebase and produces step-by-step implementation plans without being able to modify anything; prompt overridable like default, tool set fixed
- Built-in agents show their fixed tool set everywhere (agent list, action menu, edit flow) — visible but not editable
- Toggle-style multi-select for the tool picker: Enter or Space flips an entry with the cursor staying in place; "done" confirms

## [0.3.16] - 2026-06-11

### Added

- Custom agents: `/agents` creates, selects, edits, and deletes named system prompts (stored in `~/.loop/agents/<name>.md`); each registers as a `/<name>` command, and the built-in default prompt can be overridden and reset
- One-shot agent runs: `/<agent> <message>` runs that single message under the agent's prompt without changing the session's selected agent
- Slash commands highlight cyan in the input as you type, and executed commands echo highlighted into the chat
- Footer split into two rows: active agent + model on top, session/cost/context below

### Changed

- PreToolUse `updatedInput` rewrites (e.g. rtk's bash command compression) update the rendered tool call in place — the chat shows the command that actually executed, instead of a separate hook line
- Hook hardening: dispatcher never throws (corrupt config degrades to a warning), timeouts clamped, hook output capture capped at 1MB, chat-facing hook messages clipped, block decisions are strictly first-wins, Windows uses cmd.exe

## [0.3.15] - 2026-06-11

### Added

- Agent-state watcher support (herdr, Warp, …): `Notification`, `PermissionRequest`, `PreCompact` hook events, `terminalSequence` hook output for TUI-safe OSC notifications, `async` fire-and-forget hooks, parallel hook execution per event, and hook `statusMessage` shown in the loader while running
- `claudeHooksFilter` setting — allowlist which imported Claude Code hooks load (e.g. `["caveman", "herdr", "warp"]`); unset imports everything
- Errors always surface in chat: agent stream errors, slash-command failures, and uncaught exceptions render as red messages instead of disappearing

### Fixed

- `/changelog` and the what's-new banner work in release binaries — changelog content is embedded at build time (standalone binaries ship no CHANGELOG.md on disk)
- Hook `statusMessage` no longer prints a chat line on every prompt; it rides the loader while the hook runs

## [0.3.14] - 2026-06-11

### Added

- Claude Code–compatible lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`) with imports from `~/.claude/settings.json`, project `.claude`/`.loop` settings, and enabled Claude Code plugins (`${CLAUDE_PLUGIN_ROOT}` expansion included)
- Active hooks summary in the startup banner
- `/cost` detailed breakdown: session, current directory, today, last 7 days, this month, lifetime by provider
- Theme setting now applies: `/settings → theme` picks dark, light, or custom `~/.loop/agent/themes/*.json` and switches live
- `/changelog` shows release notes; new entries appear once after an upgrade
- `bun run format` (prettier) for the monorepo

### Changed

- Hook messages render with an orange accent, separate from tool grey/green
- Session-start hook context collapses to a one-line notice instead of rendering inside the first user message

### Fixed

- Hook commands exiting without reading stdin no longer crash the TUI (EPIPE)
- Hook timeouts now kill the whole process group, not just the shell
- Hook payloads match Claude Code field names (`tool_response`, `transcript_path`, `stop_hook_active`, `source`)
- Hook-injected context lands on the latest user message even when images are attached

## [0.3.13] - 2026-06-10

- Releases up to here predate changelog tracking: interactive TUI (`pi`), print mode (`pi -p`), sessions with fork/resume, multi-provider models via Vercel AI SDK v6, auto-compaction, cost tracking, project skills, workspace context
