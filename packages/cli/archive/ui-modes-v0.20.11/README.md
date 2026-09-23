# Archived: the UI-mode system (loop v0.20.11)

The chat UI as it was before 0.20.12, kept as source so it can be brought back
without digging through git. **Nothing here is wired in.** No file in
`packages/*/src` imports from this folder, it sits outside every tsconfig
`include` (so it is not typechecked), it is not bundled (the build follows
imports from `src/cli.ts`), and it does not ship (npm publishes only `dist`).

## What it contains

Every file whose UI behaviour 0.20.12 replaced, exactly as it was at the
`v0.20.11` tag, at its original path under `packages/`:

| File | What it held |
| --- | --- |
| `cli/src/interactive/ui/ui-mode.ts` | The mode registry, the `UiStyleSpec` knobs, `BlockRenderers` dispatch, the `live` variant, `toolDetail` |
| `cli/src/interactive/ui/noir-mode.ts` | The `noir` mode: its renderers (thinking, tool rows, tool groups with member tables), its original night/day/system palettes |
| `cli/src/interactive/ui/themes.ts` | The `loop` mode's `dark`/`light` palettes |
| `cli/src/interactive/ui/theme.ts` | `initUiModeAndTheme()` — per-mode themes, the `uiLive` setting |
| `cli/src/interactive/ui/messages.ts`, `tool-execution.ts`, `canvas-wash.ts`, `verb-group.ts`, `system-scheme.ts`, `tool-summary.ts` | The components as they read the style spec |
| `cli/src/interactive/components/chat-history.ts` | Verb groups before the grok fold pass, and the windowed nav viewport |
| `cli/src/interactive/input-handler.ts` | Nav mode that switched to the live variant and owned the mouse |
| `cli/src/interactive/app.ts`, `deps.ts`, `handlers/settings-handlers.ts` | The wiring, `/ui`, and the settings rows for mode and variant |
| `core/src/settings.ts`, `core/src/commands/index.ts`, `core/src/extensions/api.ts`, `core/src/extensions/host.ts` | The `uiMode`/`uiThemes`/`uiLive` settings, the `/ui` command, and the `api.uiModes` extension surface |
| `cli/test/__snapshots__/ui-mode-snapshot.test.ts.snap` | Byte snapshots of the classic boxed `loop` look — a reference for what it rendered |

## Bringing it back

The files are whole, not excerpts, so restoring is copying them over their
counterparts in `packages/` — but the rest of the codebase has moved on
since (the render-error guards, chronological error placement, the fold
engine, the `--session` gauge fix, and the `/theme` command all post-date
them). Restoring means re-applying those on top, not a blind copy. Read the
0.20.12 entry in `packages/cli/CHANGELOG.md` for everything that changed.
