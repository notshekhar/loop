#!/usr/bin/env bash
# loop desktop installer — the Electron app, not the CLI.
#   curl -fsSL https://raw.githubusercontent.com/notshekhar/loop/main/install-desktop.sh | bash
#
# For the terminal client, use install.sh instead. The two are independent:
# the desktop app carries its own loop inside the bundle, so it does not need
# the CLI installed and does not upgrade it.
#
# Layout after install:
#   macOS   /Applications/Loop.app            (or ~/Applications if not writable)
#   Linux   $LOOP_DESKTOP_HOME/               (default: ~/.local/share/loop-desktop)
#           $BIN_DIR/loop-desktop             → launcher symlink
#           ~/.local/share/applications/loop.desktop
#
# Flags (curl | bash -s -- <flags>) — each maps to the env knob next to it:
#   -v, --version <vX.Y.Z>   pin a specific tag     (LOOP_VERSION)
#       --uninstall          remove the app         (LOOP_UNINSTALL=1)
#   -h, --help
#
# Extra env knobs:
#   LOOP_REPO_SLUG        notshekhar/loop
#   LOOP_DESKTOP_HOME     ~/.local/share/loop-desktop   (linux install dir)
#   LOOP_BIN_DIR                                        (linux symlink dir)

set -euo pipefail

REPO_SLUG="${LOOP_REPO_SLUG:-notshekhar/loop}"
UNINSTALL="${LOOP_UNINSTALL:-0}"
PIN_VERSION="${LOOP_VERSION:-}"
DESKTOP_HOME="${LOOP_DESKTOP_HOME:-$HOME/.local/share/loop-desktop}"

while [ $# -gt 0 ]; do
  case "$1" in
    -v|--version) PIN_VERSION="${2:-}"; shift 2 ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 1 ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; RESET=""
fi
bold() { printf '%s%s%s\n' "$BOLD" "$*" "$RESET"; }
dim()  { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }
err()  { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; }

need() { command -v "$1" >/dev/null 2>&1 || { err "missing required tool: $1"; exit 1; }; }
need curl

# ── Download progress bar ─────────────────────────────────────────────────
# PORTED VERBATIM from install.sh — KEEP IN SYNC. Both installers are
# standalone `curl | bash` scripts, so neither can source the other; the
# duplication is the price of a single-file installer.
# curl writes a --trace-ascii stream into a FIFO; we parse content-length and
# `<= recv data` records live and draw a ■■■･･･ 42% bar on stderr. Only used
# when stderr is a TTY; anything else (or any failure) falls back to plain
# curl in the caller.

# sed with unbuffered output — GNU (-u), BSD/macOS (-l), else pad each line
# past the libc buffer so records flush through the pipe as they happen.
unbuffered_sed() {
  if echo | sed -u -e "" >/dev/null 2>&1; then
    sed -nu "$@"
  elif echo | sed -l -e "" >/dev/null 2>&1; then
    sed -nl "$@"
  else
    local pad="$(printf "\n%512s" "")"
    sed -ne "s/$/\\${pad}/" "$@"
  fi
}

PROGRESS_COLOR='\033[38;5;215m'
PROGRESS_NC='\033[0m'

print_progress() {
  local bytes="$1" length="$2"
  [ "$length" -gt 0 ] || return 0

  local width=50
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

  local tmp_dir="${TMPDIR:-/tmp}"
  local tracefile="${tmp_dir}/loop_install_$$.trace"

  rm -f "$tracefile"
  mkfifo "$tracefile" 2>/dev/null || return 1

  # Hide the cursor while the bar redraws; always restore it on the way out.
  printf "\033[?25l" >&4
  trap "trap - RETURN; rm -f \"$tracefile\"; printf '\033[?25h' >&4; exec 4>&-" RETURN

  # -f so an HTTP error fails the download (and the caller's fallback runs)
  # instead of tracing a 404 page into the output file.
  (
    curl -f --trace-ascii "$tracefile" -s -L -o "$output" "$url"
  ) &
  local curl_pid=$!

  unbuffered_sed \
    -e 'y/ACDEGHLNORTV/acdeghlnortv/' \
    -e '/^0000: content-length:/p' \
    -e '/^<= recv data/p' \
    "$tracefile" | \
  {
    local length=0 bytes=0

    while IFS=" " read -r -a line; do
      [ "${#line[@]}" -lt 2 ] && continue
      local tag="${line[0]} ${line[1]}"

      if [ "$tag" = "0000: content-length:" ]; then
        # Each response in a redirect chain restarts the count; the final
        # (asset) response's length is the one the bar ends up tracking.
        length="${line[2]}"
        length=$(echo "$length" | tr -d '\r')
        bytes=0
      elif [ "$tag" = "<= recv" ]; then
        local size="${line[3]}"
        bytes=$(( bytes + size ))
        if [ "$length" -gt 0 ]; then
          print_progress "$bytes" "$length"
        fi
      fi
    done
  }

  wait $curl_pid
  local ret=$?
  echo "" >&4
  return $ret
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
      err "  irm https://raw.githubusercontent.com/${REPO_SLUG}/main/install-desktop.ps1 | iex"
      exit 1
      ;;
    *) err "unsupported OS: $uname_s"; exit 1 ;;
  esac
  case "$uname_m" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) err "unsupported arch: $uname_m"; exit 1 ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple Silicon — install the native
  # build rather than the emulated one.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      arch="arm64"
    fi
  fi
  printf "%s-%s" "$os" "$arch"
}

# ── Resolve latest release tag ────────────────────────────────────────────
# The releases/latest redirect rather than the API: it isn't subject to the
# anonymous rate limit (60 req/h/IP) that bites CI and shared networks.
resolve_latest_tag() {
  local final tag
  final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO_SLUG}/releases/latest" 2>/dev/null || true)"
  tag="${final##*/}"
  case "$tag" in v[0-9]*) printf "%s" "$tag"; return 0 ;; esac
  curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -1
}

# ── Newest release that actually carries an asset ─────────────────────────
# The desktop app only rebuilds when its own version moves, so a CLI-only
# release publishes no desktop archives at all — "latest" is regularly not the
# newest release that HAS this asset. The releases list comes back newest
# first, so the first download URL matching the name is the one to take.
resolve_asset_url() {
  curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases?per_page=30" 2>/dev/null \
    | sed -n 's/.*"browser_download_url" *: *"\([^"]*\)".*/\1/p' \
    | grep -- "/$1\$" | head -1
}

TARGET="$(detect_target)"
OS="${TARGET%-*}"

# ── Uninstall ─────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "1" ]; then
  if [ "$OS" = "darwin" ]; then
    for dir in "/Applications/Loop.app" "$HOME/Applications/Loop.app"; do
      [ -d "$dir" ] || continue
      rm -rf "$dir" 2>/dev/null || sudo rm -rf "$dir"
      dim "  removed $dir"
    done
  else
    rm -rf "$DESKTOP_HOME"
    rm -f "$HOME/.local/bin/loop-desktop" \
          "$HOME/.local/share/applications/loop.desktop" \
          "$HOME/.local/share/icons/hicolor/512x512/apps/loop.png"
    dim "  removed $DESKTOP_HOME and its launcher"
  fi
  bold "✓ loop desktop uninstalled"
  dim "  Your sessions and settings in ~/.loop were left alone."
  exit 0
fi

# ── Resolve version + asset ───────────────────────────────────────────────
TAG="$PIN_VERSION"
[ -n "$TAG" ] || TAG="$(resolve_latest_tag)"
[ -n "$TAG" ] || { err "could not resolve latest release tag from $REPO_SLUG"; exit 1; }
case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac

if [ "$OS" = "darwin" ]; then
  ASSET="loop-desktop-${TARGET}.zip"
  need unzip
else
  ASSET="loop-desktop-${TARGET}.tar.gz"
  need tar
fi
URL="https://github.com/${REPO_SLUG}/releases/download/${TAG}/${ASSET}"

# A CLI-only release ships no desktop archives, so the latest tag regularly
# isn't the newest one carrying this asset. Fall back to the release that has
# it — but never when the user pinned a tag: they asked for that build, and
# quietly installing a different one would be worse than failing.
NOTE=""
if [ -z "$PIN_VERSION" ] && ! curl -fsSLI -o /dev/null "$URL" 2>/dev/null; then
  ALT="$(resolve_asset_url "$ASSET")"
  if [ -n "$ALT" ]; then
    NOTE="${TAG} has no desktop build — installing the newest that does"
    URL="$ALT"
    TAG="$(printf '%s' "$ALT" | awk -F/ '{ print $(NF - 1) }')"
  fi
fi

bold "loop desktop ${TAG}"
dim "  target: ${TARGET}"
if [ -n "$NOTE" ]; then dim "  ${NOTE}"; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

dim "  downloading ${ASSET}"
# Fancy bar on a TTY; plain curl everywhere else (non-TTY, or if the FIFO/trace
# plumbing fails on this shell) so a piped install still works.
if ! { [ -t 2 ] && download_with_progress "$URL" "$TMP/$ASSET"; }; then
  if ! curl -fL --progress-bar -o "$TMP/$ASSET" "$URL"; then
    err "download failed: $URL"
    err "No desktop build for ${TARGET} in ${TAG}?"
    exit 1
  fi
fi

# Verify against the published checksum. The transport is TLS, but the archive
# is ~170 MB of code that is about to be given a place in /Applications — a
# truncated download is the likely case and would otherwise install a bundle
# that fails much later, somewhere unrelated to the download.
verify_sha256() {
  local want have sum_cmd
  want="$(curl -fsSL "${URL}.sha256" 2>/dev/null | awk '{print $1}' | head -1)"
  if [ -z "$want" ]; then
    dim "  (no published checksum for ${ASSET} — skipping verification)"
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sum_cmd="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sum_cmd="shasum -a 256"
  else
    dim "  (no sha256 tool available — skipping verification)"
    return 0
  fi
  have="$($sum_cmd "$TMP/$ASSET" | awk '{print $1}')"
  if [ "$have" != "$want" ]; then
    err "checksum mismatch for ${ASSET}"
    err "  expected $want"
    err "  got      $have"
    exit 1
  fi
  dim "  checksum ok"
}
verify_sha256

# ── Install ───────────────────────────────────────────────────────────────
if [ "$OS" = "darwin" ]; then
  unzip -q "$TMP/$ASSET" -d "$TMP/x"
  APP="$TMP/x/Loop.app"
  [ -d "$APP" ] || { err "archive did not contain Loop.app"; exit 1; }

  DEST="/Applications"
  # /Applications needs admin on a managed Mac; ~/Applications always works and
  # Spotlight indexes it just the same.
  if [ ! -w "$DEST" ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      :
    else
      DEST="$HOME/Applications"
      mkdir -p "$DEST"
      dim "  /Applications not writable — installing to ~/Applications"
    fi
  fi

  if [ -d "$DEST/Loop.app" ]; then
    rm -rf "$DEST/Loop.app" 2>/dev/null || sudo rm -rf "$DEST/Loop.app"
  fi
  cp -R "$APP" "$DEST/" 2>/dev/null || sudo cp -R "$APP" "$DEST/"

  # The build is not notarized, so Gatekeeper quarantines anything downloaded
  # and refuses to launch it with a message about a damaged app. Clearing the
  # attribute is what makes an unsigned build launchable at all.
  xattr -dr com.apple.quarantine "$DEST/Loop.app" 2>/dev/null \
    || sudo xattr -dr com.apple.quarantine "$DEST/Loop.app" 2>/dev/null || true

  bold "✓ Installed $DEST/Loop.app"
  dim "  open it from Spotlight, or: open -a Loop"
else
  rm -rf "$DESKTOP_HOME"
  mkdir -p "$DESKTOP_HOME"
  tar -xzf "$TMP/$ASSET" -C "$DESKTOP_HOME"
  chmod +x "$DESKTOP_HOME/Loop" 2>/dev/null || true
  # What `loop install desktop` reads to tell whether this copy is current.
  printf '%s\n' "${TAG#v}" > "$DESKTOP_HOME/.loop-version"

  # The chrome-sandbox helper must be setuid root unless the app runs with
  # --no-sandbox; without it Electron aborts on start with a SUID error.
  if [ -f "$DESKTOP_HOME/chrome-sandbox" ]; then
    if command -v sudo >/dev/null 2>&1; then
      sudo chown root:root "$DESKTOP_HOME/chrome-sandbox" 2>/dev/null || true
      sudo chmod 4755 "$DESKTOP_HOME/chrome-sandbox" 2>/dev/null || true
    fi
  fi

  BIN_DIR="${LOOP_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$BIN_DIR"
  ln -sf "$DESKTOP_HOME/Loop" "$BIN_DIR/loop-desktop"

  # A .desktop entry is what puts it in the application menu; without one the
  # app is only launchable by path.
  mkdir -p "$HOME/.local/share/applications" \
           "$HOME/.local/share/icons/hicolor/512x512/apps"
  ICON="$DESKTOP_HOME/resources/app.asar.unpacked/dist/icon.png"
  [ -f "$ICON" ] && cp "$ICON" "$HOME/.local/share/icons/hicolor/512x512/apps/loop.png"
  cat > "$HOME/.local/share/applications/loop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Loop
Comment=Coding agent
Exec=$DESKTOP_HOME/Loop %U
Icon=loop
Terminal=false
Categories=Development;Utility;
StartupWMClass=Loop
EOF
  command -v update-desktop-database >/dev/null 2>&1 \
    && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

  bold "✓ Installed $DESKTOP_HOME"
  dim "  launch from your application menu, or: loop-desktop"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) dim "  ($BIN_DIR is not on PATH — add it to use the loop-desktop command)" ;;
  esac
fi
