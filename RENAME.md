# Renaming the product

The product has been renamed before (`pi` → `loop`) and is built to be renamed
again cheaply. All runtime branding flows from **three tiny brand files** (one
per dependency-free package):

| File                            | Used by                                   |
| ------------------------------- | ----------------------------------------- |
| `packages/core/src/brand.ts`    | core + cli (cli imports it via loop-core) |
| `packages/tui/src/brand.ts`     | tui (no dependency on core)               |
| `packages/sandbox/src/brand.ts` | sandbox (no dependency on core)           |

Everything brand-shaped in TypeScript derives from them: the `~/.loop` config
dir, `<cwd>/.loop` project dir, every `LOOP_*` env var (via `envName`/
`brandEnv`), the `loop://` read-tool scheme, the `"loop"` extension-manifest
key, CLI usage text, OAuth client names, the user-agent, and the GitHub
`REPO_SLUG`. The session database is deliberately brand-free (`agent.db`), so
a rename never touches it — it just moves with the config dir.

## Steps (say the new name is `zap`)

### 1. The brand files (the actual rename)

In **all three** brand files set:

```ts
export const PRODUCT_NAME = "zap";
```

In `packages/core/src/brand.ts` additionally:

- Append the old manifest key so published extensions keep loading:
  `EXTENSION_MANIFEST_KEYS = [PRODUCT_NAME, "loop"]`.
- Update `REPO_SLUG` if the GitHub repo is renamed too.

Nothing moves a user's config dir automatically: an automatic move-and-delete
of a home dir can destroy another tool's setup that happens to share the old
name (`~/.pi` is also the real pi agent's), so the old migration was removed.
If a rename ever needs one, make it opt-in and verify the dir is ours first.
The session db is the brand-free `agent.db` (`defaultDbPath` still adopts a
brand-named db from pre-generic installs, e.g. `loop.db`).

### 2. Regenerate docs

The `.md` sources in `packages/core/src/docs/` use `{{name}}`, `{{dir}}`,
`{{env}}` tokens; the generator substitutes them from brand.ts:

```
bun run gen:docs
```

### 3. package.json (npm identity)

- Root: `"name": "loop-monorepo"`.
- `packages/*/package.json`: the `@notshekhar/loop*` names, and in
  `packages/cli/package.json` the `bin` map (`loop`, `lp`, `agent`),
  `description`, `homepage`, `bugs`, `repository`, `keywords`.
- Cross-package deps (`"@notshekhar/loop-core": "*"` etc.) in cli/package.json
  and every `import ... from "@notshekhar/loop-core"` / `-tui` in
  `packages/cli/src` (mechanical find-replace), plus `external:` in
  `packages/cli/build.ts` / `build-bin.ts`.
- Run `bun install` to refresh the lockfile/workspace links.

### 4. Install scripts + release plumbing

These are shell/YAML, not TS, so they hardcode the name:

- `install.sh`, `install.ps1`, `install.cmd` — binary name, symlinks
  (`loop`/`lp`/`agent`), `LOOP_*` installer env vars, `~/.loop-bin` home, repo
  slug.
- `.github/workflows/release.yml` — artifact names (`loop-<target>.tar.gz`),
  binary path, Homebrew formula rendering (`Formula/loop.rb`, tap repo).
- `.github/scripts/render-formula.py` — formula class/name.
- `scripts/build-and-link.sh` — linked binary name.
- `homebrew-tap` repo — formula file name.

### 5. Cosmetics

- `README.md`.
- Code comments still say "loop" in places — harmless; sweep with a plain
  find-replace when convenient.

## Verify

```
bun test                                   # full suite
bun run build                              # includes gen:docs
node packages/cli/dist/cli.js --help       # usage text shows the new name
rg -i '\bloop\b' packages/*/src --glob '!*brand.ts' --glob '!generated.ts'
# remaining hits should be comments or the word "loop" used conceptually
# (turn loop, event loop, loop over) — nothing functional.
```

Then launch once with an old `~/.loop` present and confirm it migrated (config,
auth, sessions db) and that `zap login`, `/model`, and an installed extension
still work.
