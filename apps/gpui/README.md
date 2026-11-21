# loop on GPUI

loop's desktop app rebuilt natively on [GPUI](https://gpui.rs), Zed's UI
framework, styled like Zed. It talks to loop's core by spawning `loop rpc`
(NDJSON JSON-RPC), the same protocol the web and Electron apps use.

```bash
cargo run                      # uses `loop` from PATH
LOOP_BINARY=../../packages/cli/dist/bin/darwin-arm64/loop cargo run
cargo test
cargo clippy --all-targets
```

## Licensing

`gpui` and `gpui_platform` are Apache-2.0. Zed's other crates (`ui`,
`editor`, `git_ui`, `workspace`, `lsp`, …) are **GPL-3.0**: depending on or
copying from them makes this app GPL. Port behaviour from them, not code,
unless that is the decision.

## Layout

```
src/main.rs                 app start, window
src/actions.rs              app actions + key bindings
src/theme.rs                colours/fonts (Cursor Dark + the owner's Zed overrides)
src/rpc/                    `loop rpc` client (reader thread, notifications) + protocol types
src/host.rs                 the one connection; routes session.event to open sessions
src/session.rs              one open thread: transcript, send/stop/answer, ask
src/transcript/             loop's transcript model, live-event reducer, tool wording
src/markdown/               markdown parse (pulldown-cmark) + gpui renderer
src/catalog.rs              models from catalog.list
src/threads.rs              ThreadStore: sessions grouped by project
src/ui/workspace.rs         root: sidebar | title bar + conversation | status bar
src/ui/sidebar.rs           virtualised thread list, new thread
src/ui/conversation/        transcript list, messages, tool rows, todos
src/ui/composer.rs          message box, model + thinking menus, send/stop
src/ui/model_picker.rs      searchable model list
src/ui/ask_panel.rs         answering the agent's questions
src/ui/text_input.rs        multi-line input (grown from gpui's input example)
```
