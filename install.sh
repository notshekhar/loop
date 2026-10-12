#!/usr/bin/env bash
# loop installer — binary first, npm/source fallbacks.
#   curl -fsSL https://raw.githubusercontent.com/notshekhar/loop/main/install.sh | bash
#
# Default path: downloads prebuilt binary tarball from GitHub Releases
# (bun --compile output, ~67 MB; zero runtime required, no node, no bun).
#
# Layout after install:
#   $LOOP_HOME/                          (default: ~/.loop-bin)
#     ├── loop                          (executable; reads package.json
#     └── package.json                  alongside via dirname(execPath))
#   $BIN_DIR/loop  → $LOOP_HOME/loop     (symlink)
#   $BIN_DIR/agent → $LOOP_HOME/loop     (symlink)
#
# Flags (curl | bash -s -- <flags>) — each maps to the env knob next to it:
#   -v, --version <vX.Y.Z>   pin a specific tag        (LOOP_VERSION)
#       --force              skip up-to-date gate      (LOOP_FORCE=1)
#       --from-source        clone + bun build         (LOOP_FROM_SOURCE=1)
#       --uninstall          remove install + links    (LOOP_UNINSTALL=1)
#       --no-modify-path     don't touch shell rc      (LOOP_NO_MODIFY_PATH=1)
#   -h, --help
#
# Extra env knobs:
#   LOOP_REPO_SLUG    notshekhar/loop     override repo
#   LOOP_HOME         $HOME/.loop-bin     install dir for binary + package.json
#   LOOP_BIN_DIR                        symlink dir (auto: /usr/local/bin or
#                                       $HOME/.local/bin)

set -euo pipefail

REPO_SLUG="${LOOP_REPO_SLUG:-notshekhar/loop}"
REPO="${LOOP_REPO:-https://github.com/${REPO_SLUG}.git}"
REF="${LOOP_REF:-main}"
LOOP_HOME="${LOOP_HOME:-$HOME/.loop-bin}"
FORCE="${LOOP_FORCE:-0}"
FROM_SOURCE="${LOOP_FROM_SOURCE:-0}"
UNINSTALL="${LOOP_UNINSTALL:-0}"
PIN_VERSION="${LOOP_VERSION:-}"
NO_MODIFY_PATH="${LOOP_NO_MODIFY_PATH:-0}"

usage() {
  cat <<EOF
loop installer

Usage: install.sh [options]

Options:
  -v, --version <vX.Y.Z>  Install a specific release
      --force             Reinstall even when up to date
      --from-source       Clone the repo and build with bun
      --uninstall         Remove the install and its symlinks
      --no-modify-path    Don't write the PATH line to your shell rc
  -h, --help              Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh | bash -s -- --version v0.11.5
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -v|--version)
      if [ -n "${2:-}" ]; then PIN_VERSION="$2"; shift 2; else
        printf "\033[31m--version requires an argument\033[0m\n" >&2; exit 1; fi ;;
    --force) FORCE=1; shift ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-modify-path) NO_MODIFY_PATH=1; shift ;;
    *) printf "\033[2mignoring unknown option: %s\033[0m\n" "$1" >&2; shift ;;
  esac
done

# Older installs shipped a short `lp` alias that collided with the system CUPS
# printer (/usr/bin/lp). `lp` is gone now — this marker lets us strip the alias
# block such an install may have written to a shell rc.
LP_ALIAS_MARKER="# loop: lp alias (overrides system /usr/bin/lp)"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
err()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

need_tool() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "Missing required tool: $cmd"
    err "  → $hint"
    exit 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    err "missing sha256sum/shasum"; return 1
  fi
}

ver_gt() {
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 1
  local top
  top="$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)"
  [ "$top" = "$b" ] && return 0
  return 1
}

# ── Download progress bar ─────────────────────────────────────────────────
# Ask for the size, download in the background, and draw a ■■■･･･ 42% bar from
# how big the output file has grown. Only used when stderr is a TTY; anything
# else (or any failure) falls back to plain curl in the caller.
#
# It used to read curl's --trace-ascii stream instead, which meant curl wrote a
# hex+ascii transcript of EVERY BYTE of the tarball into a FIFO and bash parsed
# the ~100MB that came out, one `read` at a time. That turned a 5-second
# download into 82 (measured, 27MB over a fast link) and left the bar sitting
# at 0% for the first stretch — indistinguishable from a hang, on the one path
# every `loop upgrade` takes. Polling a file size costs nothing per frame.

PROGRESS_COLOR='\033[38;5;215m'
PROGRESS_NC='\033[0m'

# Bytes in a file, or empty if it isn't there yet. stat's flags differ by libc.
file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo ""
}

# Content-Length of the final URL after redirects (GitHub sends you to a CDN).
# Empty when the server won't say — the caller then shows an untotalled bar.
remote_size() {
  curl -fsSLI "$1" 2>/dev/null \
    | tr -d '\r' \
    | awk 'BEGIN{IGNORECASE=1} /^content-length:/ {n=$2} END{if (n+0 > 0) print n}'
}

print_progress() {
  local bytes="$1" length="$2"
  local width=50

  if [ "${length:-0}" -le 0 ]; then
    # No total to divide by: show what has arrived rather than a fake bar.
    printf "\r${PROGRESS_COLOR}  %s MB${PROGRESS_NC}" "$(( bytes / 1048576 ))" >&4
    return 0
  fi

  local percent=$(( bytes * 100 / length ))
  [ "$percent" -gt 100 ] && percent=100
  local on=$(( percent * width / 100 ))
  local off=$(( width - on ))

  local filled=$(printf "%*s" "$on" "")
  filled=${filled// /■}
  local empty=$(printf "%*s" "$off" "")
  empty=${empty// /･}

  printf "\r${PROGRESS_COLOR}%s%s %3d%%${PROGRESS_NC}" "$filled" "$empty" "$percent" >&4
}

download_with_progress() {
  local url="$1" output="$2"

  if [ -t 2 ]; then
    exec 4>&2
  else
    exec 4>/dev/null
  fi

  local length
  length="$(remote_size "$url")"
  : "${length:=0}"

  # Hide the cursor while the bar redraws; always restore it on the way out.
  printf "\033[?25l" >&4
  trap "trap - RETURN; rm -f \"${output}.done\"; printf '\033[?25h' >&4; exec 4>&-" RETURN

  # -f so an HTTP error fails the download (and the caller's fallback runs)
  # instead of writing a 404 page to the output file. The exit status lands in
  # a file rather than being polled for: a finished background child is a
  # zombie until it is waited on, and `kill -0` on a zombie still succeeds, so
  # watching the pid is a loop that never ends.
  local donefile="${output}.done"
  rm -f "$donefile"
  { curl -f -s -L -o "$output" "$url"; echo "$?" > "$donefile"; } &

  local bytes
  while [ ! -s "$donefile" ]; do
    bytes="$(file_size "$output")"
    [ -n "$bytes" ] && print_progress "$bytes" "$length"
    sleep 0.1
  done

  wait
  local ret
  ret="$(cat "$donefile" 2>/dev/null || echo 1)"
  rm -f "$donefile"
  # Land the bar on the real final size rather than wherever the last poll got.
  if [ "$ret" -eq 0 ]; then
    bytes="$(file_size "$output")"
    [ -n "$bytes" ] && print_progress "$bytes" "${length:-$bytes}"
  fi
  echo "" >&4
  return $ret
}


# True when $1 is a symlink into THIS install ($LOOP_HOME) — the only links
# the installer removes. A command named `agent` or `pi` that belongs to
# another tool (Cursor's CLI is `agent`; pi is its own coding agent), or a
# second loop installed elsewhere, is never touched.
is_loop_link() {
  [ -L "$1" ] || return 1
  local target
  target="$(readlink "$1" 2>/dev/null || true)"
  case "$target" in
    "$LOOP_HOME"/*) return 0 ;;
  esac
  return 1
}

# ── Detect target ─────────────────────────────────────────────────────────
detect_target() {
  local uname_s uname_m os arch
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  case "$uname_s" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
      err "Detected Git Bash / MSYS on Windows. Use the PowerShell installer instead:"
      err "  irm https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1 | iex"
      err "Or from cmd.exe:"
      err "  curl -fsSLo %TEMP%\\loop-install.cmd https://raw.githubusercontent.com/${REPO_SLUG}/main/install.cmd && %TEMP%\\loop-install.cmd"
      exit 1
      ;;
    *)      err "unsupported OS: $uname_s"; exit 1 ;;
  esac
  case "$uname_m" in
    x86_64|amd64)   arch="x64" ;;
    arm64|aarch64)  arch="arm64" ;;
    *)              err "unsupported arch: $uname_m"; exit 1 ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple Silicon — install the
  # native arm64 build instead of the emulated one.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      arch="arm64"
    fi
  fi
  printf "%s-%s" "$os" "$arch"
}

# Release binaries are glibc builds; Alpine and other musl distros need a
# source build (bun's musl build) or a glibc compat layer.
check_libc() {
  [ "$(uname -s)" = "Linux" ] || return 0
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    err "musl libc detected (Alpine?). Release binaries are glibc builds."
    err "  options:"
    err "    • apk add gcompat              (glibc compatibility layer)"
    err "    • LOOP_FROM_SOURCE=1 <installer> (build with bun on this machine)"
    exit 1
  fi
}

# ── Resolve latest release tag ────────────────────────────────────────────
# Prefer the releases/latest redirect — it isn't subject to the anonymous
# GitHub API rate limit (60 req/h/IP) that bites CI and shared networks.
# Fall back to the API if redirect parsing fails.
resolve_latest_tag() {
  local final tag
  final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO_SLUG}/releases/latest" 2>/dev/null || true)"
  tag="${final##*/}"
  case "$tag" in
    v[0-9]*) printf "%s" "$tag"; return 0 ;;
  esac
  curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v\{0,1\}[0-9][^"]*\)".*/\1/p' \
    | head -n1 || true
}

# ── Resolve bin dir for symlinks ──────────────────────────────────────────
resolve_bin_dir() {
  if [ -n "${LOOP_BIN_DIR:-}" ]; then
    mkdir -p "$LOOP_BIN_DIR"
    printf "%s" "$LOOP_BIN_DIR"
    return
  fi
  for d in /usr/local/bin /opt/homebrew/bin; do
    if [ -w "$d" ] 2>/dev/null; then
      printf "%s" "$d"
      return
    fi
  done
  local fallback="$HOME/.local/bin"
  mkdir -p "$fallback"
  printf "%s" "$fallback"
}

# ── Uninstall ─────────────────────────────────────────────────────────────
uninstall() {
  bold "▶ Uninstalling loop"
  # Remove loop's own links (loop, and the lp/agent aliases it may have made)
  # from every known dir — only links that point into a loop install, so
  # another tool's `agent` or `lp` stays put.
  for link in "$HOME/.local/bin/loop" "$HOME/.local/bin/lp" "$HOME/.local/bin/agent" \
              "/usr/local/bin/loop" "/usr/local/bin/lp" "/usr/local/bin/agent" \
              "/opt/homebrew/bin/loop" "/opt/homebrew/bin/lp" "/opt/homebrew/bin/agent" \
              "${LOOP_BIN_DIR:+$LOOP_BIN_DIR/loop}" "${LOOP_BIN_DIR:+$LOOP_BIN_DIR/lp}" "${LOOP_BIN_DIR:+$LOOP_BIN_DIR/agent}"; do
    [ -n "$link" ] || continue
    if is_loop_link "$link"; then
      rm -f "$link" 2>/dev/null && dim "  removed $link" || true
    fi
  done
  strip_lp_alias   # remove the legacy lp alias from any shell rc
  rm -rf "$LOOP_HOME" 2>/dev/null && dim "  removed $LOOP_HOME" || true
  bold "✓ Uninstalled. Config in ~/.loop (auth, sessions, settings) was kept;"
  dim  "  remove it with: rm -rf ~/.loop"
}

# ── Source build path ─────────────────────────────────────────────────────
install_from_source() {
  bold "▶ loop installer (source build)"
  need_tool git "Install Git first: https://git-scm.com/downloads"
  need_tool bun "Install: curl -fsSL https://bun.sh/install | bash"

  rm -rf "${LOOP_HOME}".old.* "${LOOP_HOME}".new.* "${LOOP_HOME}".src.* 2>/dev/null || true
  local scratch="${LOOP_HOME}.src.$$"
  trap 'rm -rf "$scratch" 2>/dev/null || true' EXIT
  bold "▶ Cloning $REPO ($REF)"
  git clone --depth=1 --branch "$REF" "$REPO" "$scratch" 2>/dev/null \
    || git clone --depth=1 "$REPO" "$scratch"
  ( cd "$scratch" && bun install && bun run build && bun packages/cli/build-bin.ts )

  local target
  target="$(detect_target)"
  local stage="$scratch/packages/cli/dist/bin/$target"
  if [ ! -x "$stage/loop" ]; then
    err "source build did not produce $stage/loop"
    exit 1
  fi
  swap_into_place "$stage"
  trap - EXIT
  rm -rf "$scratch" 2>/dev/null || true
  link_globally
  printf "source\n" > "$LOOP_HOME/.install-method" 2>/dev/null || true
  smoke_test
  finish_message "from source"
}

# ── Binary release path ───────────────────────────────────────────────────
install_from_release() {
  bold "▶ loop installer (binary)"
  need_tool curl "macOS: preinstalled. Linux: sudo apt install curl"
  need_tool tar  "Standard on macOS/Linux."
  check_libc

  local target latest installed
  target="$(detect_target)"
  dim "  target: $target"

  latest="${PIN_VERSION}"
  if [ -z "$latest" ]; then
    latest="$(resolve_latest_tag)"
  fi
  if [ -z "$latest" ]; then
    err "could not resolve latest release tag from $REPO_SLUG"
    err "set LOOP_VERSION=vX.Y.Z to pin, or LOOP_FROM_SOURCE=1 to build from source"
    exit 1
  fi
  case "$latest" in v*) ;; *) latest="v$latest" ;; esac

  installed=""
  if [ -f "$LOOP_HOME/package.json" ]; then
    installed="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LOOP_HOME/package.json" | head -n1 || true)"
  fi
  if [ "$FORCE" != "1" ] && [ -n "$installed" ]; then
    if ! ver_gt "${latest#v}" "${installed#v}"; then
      # "Up to date" is a claim about the binary, not about package.json. An
      # install whose binary does not run is not up to date — it is broken, and
      # exiting 0 here is what left a user re-running the installer three times
      # and being told nothing was wrong while `loop` was still being killed.
      if binary_runs "$LOOP_HOME/loop"; then
        bold "✓ Up to date (installed $installed, latest $latest)"
        dim "  LOOP_FORCE=1 to reinstall"
        exit 0
      fi
      if repair_macos_binary; then
        bold "✓ Up to date (installed $installed, latest $latest) — repaired"
        exit 0
      fi
      dim "  installed $installed does not run — reinstalling $latest"
    else
      dim "  update: $installed → $latest"
    fi
  else
    dim "  installing $latest"
  fi

  local scratch tar sum url base
  # Sweep leftovers from interrupted runs / prior self-updates — before the
  # fresh scratch exists, so the glob can't eat it.
  rm -rf "${LOOP_HOME}".old.* "${LOOP_HOME}".new.* "${LOOP_HOME}".src.* 2>/dev/null || true
  scratch="${LOOP_HOME}.new.$$"
  trap 'rm -rf "$scratch" 2>/dev/null || true' EXIT
  mkdir -p "$scratch"

  base="https://github.com/${REPO_SLUG}/releases/download/${latest}"
  url="${base}/loop-${target}.tar.gz"
  tar="$scratch/loop.tar.gz"
  sum="$scratch/loop.tar.gz.sha256"

  bold "▶ Downloading ${url##*/}"
  # Fancy ■■■･･･ 42% bar on a TTY; plain curl everywhere else (non-TTY, or
  # if the traced download fails for any reason — including HTTP errors,
  # where the retry surfaces curl's own message).
  if ! { [ -t 2 ] && download_with_progress "$url" "$tar"; }; then
    if ! curl -fL --progress-bar "$url" -o "$tar"; then
      err "download failed: $url"
      err "release may not have $target asset; try LOOP_FROM_SOURCE=1 to build from source"
      exit 1
    fi
  fi
  if curl -fsSL "${url}.sha256" -o "$sum" 2>/dev/null && [ -s "$sum" ]; then
    local expected got
    expected="$(awk '{print $1}' "$sum")"
    got="$(sha256_of "$tar")"
    if [ "$expected" != "$got" ]; then
      err "sha256 mismatch (expected $expected, got $got)"
      exit 1
    fi
    dim "  sha256 ok"
  else
    dim "  sha256 file missing — skipping verify"
  fi

  bold "▶ Extracting"
  tar -xzf "$tar" -C "$scratch"
  if [ ! -x "$scratch/$target/loop" ]; then
    err "tarball missing $target/loop"
    exit 1
  fi

  # Defensive: clear quarantine if anything in the chain set it (Gatekeeper
  # blocks unsigned quarantined binaries with a scary dialog).
  if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$scratch/$target" 2>/dev/null || true
  fi

  swap_into_place "$scratch/$target"
  trap - EXIT
  rm -rf "$scratch" 2>/dev/null || true

  link_globally
  printf "binary\n" > "$LOOP_HOME/.install-method" 2>/dev/null || true
  smoke_test
  finish_message "$latest"
}

# ── Atomic swap install dir ───────────────────────────────────────────────
# The previous install is kept as $LOOP_BACKUP until the smoke test passes, so
# a binary that turns out not to run on this machine can be rolled back instead
# of leaving the user with no working `loop` at all (and, worse, a package.json
# that makes the next installer run say "✓ Up to date" about a corpse).
LOOP_BACKUP=""
swap_into_place() {
  local src="$1"
  bold "▶ Installing to $LOOP_HOME"
  mkdir -p "$(dirname "$LOOP_HOME")"
  LOOP_BACKUP=""
  if [ -e "$LOOP_HOME" ]; then
    LOOP_BACKUP="${LOOP_HOME}.old.$$"
    mv "$LOOP_HOME" "$LOOP_BACKUP"
  fi
  mv "$src" "$LOOP_HOME"
}

# Drop the kept-back copy of the previous install (the install stuck).
commit_install() {
  [ -n "$LOOP_BACKUP" ] && rm -rf "$LOOP_BACKUP" 2>/dev/null || true
  LOOP_BACKUP=""
}

# Put the previous install back, exactly as it was.
rollback_install() {
  [ -n "$LOOP_BACKUP" ] || return 1
  [ -e "$LOOP_BACKUP" ] || return 1
  rm -rf "$LOOP_HOME" 2>/dev/null || true
  mv "$LOOP_BACKUP" "$LOOP_HOME" || return 1
  LOOP_BACKUP=""
  return 0
}

# ── Kill stale binaries + symlink fresh ones ──────────────────────────────
link_globally() {
  bold "▶ Linking loop + agent globally"

  # Wipe shims from prior installer styles (npm i -g, bun link, an older curl
  # run). Only loop's own: its npm package, and links that point into a loop
  # install. Other tools' commands — pi, Cursor's `agent`, anything named
  # `loop` that is not ours — are left alone.
  if command -v npm >/dev/null 2>&1; then
    npm uninstall -g @notshekhar/loop --silent --no-audit --no-fund 2>/dev/null || true
  fi
  local stale_dirs=("$HOME/.local/bin" "/usr/local/bin" "/opt/homebrew/bin")
  if command -v bun >/dev/null 2>&1; then
    local bun_bin
    bun_bin="$(bun pm -g bin 2>/dev/null || true)"
    [ -n "$bun_bin" ] && stale_dirs+=("$bun_bin")
  fi
  for dir in "${stale_dirs[@]}"; do
    for name in loop lp agent; do
      if is_loop_link "$dir/$name"; then
        rm -f "$dir/$name" 2>/dev/null && dim "  removed stale: $dir/$name" || true
      fi
    done
  done

  local bin_dir
  bin_dir="$(resolve_bin_dir)"
  ln -sf "$LOOP_HOME/loop" "$bin_dir/loop"
  # `agent` is a convenience alias, and a common name — Cursor's CLI is
  # `agent`, and loop runs it as a native agent. Claim it only when free.
  if [ ! -e "$bin_dir/agent" ] && [ ! -L "$bin_dir/agent" ]; then
    ln -s "$LOOP_HOME/loop" "$bin_dir/agent"
  elif ! is_loop_link "$bin_dir/agent"; then
    dim "  kept $bin_dir/agent (another tool's) — run loop as \`loop\`"
  fi
  hash -r 2>/dev/null || true

  # Clean up the legacy `lp` alias older installs added (the `lp` command is
  # gone; the stale-symlink sweep above already removed any `lp` symlink).
  strip_lp_alias

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) modify_path "$bin_dir" ;;
  esac

  # GitHub Actions: expose the bin dir to subsequent workflow steps.
  if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "${GITHUB_PATH:-}" ]; then
    echo "$bin_dir" >> "$GITHUB_PATH"
    dim "  added $bin_dir to \$GITHUB_PATH"
  fi

  LOOP_LINK_DIR="$bin_dir"
}

# Write the PATH line into the user's shell rc (opencode-style), unless
# --no-modify-path. Falls back to a copy-pasteable hint when no rc is writable.
modify_path() {
  local bin_dir="$1" shell_name line config_file=""
  shell_name="$(basename "${SHELL:-bash}")"
  local xdg="${XDG_CONFIG_HOME:-$HOME/.config}"
  local candidates
  case "$shell_name" in
    fish) candidates="$HOME/.config/fish/config.fish"
          line="fish_add_path $bin_dir" ;;
    zsh)  candidates="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv $xdg/zsh/.zshrc"
          line="export PATH=\"$bin_dir:\$PATH\"" ;;
    bash) candidates="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $xdg/bash/.bashrc"
          line="export PATH=\"$bin_dir:\$PATH\"" ;;
    *)    candidates="$HOME/.profile"
          line="export PATH=\"$bin_dir:\$PATH\"" ;;
  esac

  if [ "$NO_MODIFY_PATH" = "1" ]; then
    err "warning: $bin_dir is not on PATH (--no-modify-path given)"
    err "  $line"
    return 0
  fi

  for f in $candidates; do
    if [ -f "$f" ]; then config_file="$f"; break; fi
  done
  if [ -z "$config_file" ] || [ ! -w "$config_file" ]; then
    err "warning: $bin_dir is not on PATH — add it to your shell rc:"
    err "  $line"
    return 0
  fi
  if grep -Fxq "$line" "$config_file" 2>/dev/null; then
    dim "  PATH line already in $config_file"
    return 0
  fi
  printf "\n# loop\n%s\n" "$line" >> "$config_file"
  dim "  added $bin_dir to PATH in $config_file (restart your shell to pick it up)"
}

# Remove the legacy `lp` alias block a prior install may have written to a
# shell rc. Idempotent; touches only our marked line, leaving the rest intact.
strip_lp_alias() {
  local rc tmp
  for rc in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.config/fish/config.fish"; do
    [ -f "$rc" ] || continue
    grep -qF "$LP_ALIAS_MARKER" "$rc" 2>/dev/null || continue
    tmp="$(mktemp)" || continue
    if grep -vF "$LP_ALIAS_MARKER" "$rc" > "$tmp" 2>/dev/null; then
      cat "$tmp" > "$rc" && dim "  removed legacy lp alias from $rc"
    fi
    rm -f "$tmp" 2>/dev/null || true
  done
}

# Does this binary actually run? Used both after an install and BEFORE one, to
# decide whether an "already up to date" install is worth keeping.
binary_runs() {
  [ -x "$1" ] || return 1
  "$1" --version >/dev/null 2>&1
}

# macOS only, and only after a failed run: give the binary back a signature it
# can be executed with.
#
# `bun build --compile` appends the JS payload after the Mach-O was ad-hoc
# signed, so the signature no longer describes the file. Most Macs never look;
# the ones that do SIGKILL it on exec, and the shell prints a bare `killed`
# with no output — indistinguishable from a corrupt download. Signing it here
# rewrites the signature over the bytes actually on disk. (Releases from
# v0.19.15 on are signed at build time; this stays for older tags, source
# builds on odd hosts, and anything Gatekeeper touched on the way in.)
repair_macos_binary() {
  [ "$(uname -s)" = "Darwin" ] || return 1
  local bin="$LOOP_HOME/loop"
  [ -f "$bin" ] || return 1
  dim "  binary was killed on launch — clearing quarantine and re-signing"
  command -v xattr    >/dev/null 2>&1 && xattr -cr "$bin" 2>/dev/null || true
  command -v codesign >/dev/null 2>&1 || return 1
  codesign --force --sign - "$bin" >/dev/null 2>&1 || return 1
  binary_runs "$bin"
}

# The binary must actually run on this machine (catches libc/arch surprises
# immediately instead of on first use).
smoke_test() {
  local v
  if ! v="$("$LOOP_HOME/loop" --version 2>&1)"; then
    # One repair attempt before giving up — see repair_macos_binary.
    if repair_macos_binary; then
      v="$("$LOOP_HOME/loop" --version 2>&1)"
      dim "  re-signed: loop v$v"
      commit_install
      return 0
    fi
    err "installed binary failed to run${v:+: $v}"
    if rollback_install; then
      err "  rolled back to the previous install — your existing loop still works"
    fi
    err "  try LOOP_FROM_SOURCE=1 to build for this machine"
    exit 1
  fi
  commit_install
  dim "  verified: loop v$v"
  # Drop the man page on the user manpath so `man loop` just works. Best
  # effort: a read-only HOME or an unusual manpath must never fail an install.
  if "$LOOP_HOME/loop" man --install >/dev/null 2>&1; then
    dim "  man page:  man loop"
  fi
}

finish_message() {
  local label="$1"
  bold "✓ Installed $label"
  echo "  loop:    $LOOP_LINK_DIR/loop"
  echo "  agent:   $LOOP_LINK_DIR/agent"
  echo "  target:  $LOOP_HOME"
  echo
  dim  "█░░░ █▀▀█ █▀▀█ █▀▀█"
  dim  "█░░░ █░░█ █░░█ █░░█"
  dim  "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ █▀▀▀"
  echo
  echo "To start:"
  echo
  printf "  cd <project>  "; dim "# open a directory"
  printf "  loop          "; dim "# run the agent"
  printf "  loop login    "; dim "# add a provider"
  echo
  printf "  man loop      "; dim "# the manual"
  printf "  loop completion zsh > \"\${fpath[1]}/_loop\"  "; dim "# tab completion"
  echo
  dim "Update later with \`loop update\` (or /update inside the TUI)."
  dim "Docs: https://github.com/${REPO_SLUG}#readme"
}

# ── Route ──────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "1" ]; then
  uninstall
elif [ "$FROM_SOURCE" = "1" ]; then
  install_from_source
else
  install_from_release
fi
