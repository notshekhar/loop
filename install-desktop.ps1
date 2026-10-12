# loop desktop installer (Windows PowerShell) — the Electron app, not the CLI.
#
#   irm https://raw.githubusercontent.com/notshekhar/loop/main/install-desktop.ps1 | iex
#
# For the terminal client, use install.ps1 instead. The two are independent:
# the desktop app carries its own loop inside the bundle, so it neither needs
# nor upgrades the CLI.
#
# Layout after install:
#   %LOCALAPPDATA%\Programs\Loop\
#     ├── Loop.exe
#     └── resources\...
#   Start Menu shortcut, and a Desktop shortcut if $env:LOOP_DESKTOP_SHORTCUT=1
#
# Env knobs:
#   $env:LOOP_REPO_SLUG        notshekhar/loop
#   $env:LOOP_VERSION          vX.Y.Z   pin a specific tag
#   $env:LOOP_DESKTOP_HOME     %LOCALAPPDATA%\Programs\Loop
#   $env:LOOP_UNINSTALL        1        remove the install and exit

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 on older .NET defaults may lack TLS 1.2, which GitHub
# requires — opt in without clobbering anything newer (no-op on PowerShell 7+).
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
} catch {}

function Bold($msg) { Write-Host $msg -ForegroundColor White }
function Dim($msg)  { Write-Host $msg -ForegroundColor DarkGray }
function Err($msg)  { Write-Host $msg -ForegroundColor Red }

$RepoSlug = if ($env:LOOP_REPO_SLUG) { $env:LOOP_REPO_SLUG } else { "notshekhar/loop" }
$Home_    = if ($env:LOOP_DESKTOP_HOME) { $env:LOOP_DESKTOP_HOME } else { Join-Path $env:LOCALAPPDATA "Programs\Loop" }
$StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Loop.lnk"
$DesktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Loop.lnk"

# ── Uninstall ─────────────────────────────────────────────────────────────
if ($env:LOOP_UNINSTALL -eq "1") {
    # A running app holds its own files open, so the remove would half-finish
    # and leave an install that looks present but cannot launch.
    Get-Process -Name "Loop" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    foreach ($p in @($Home_, $StartMenu, $DesktopLnk)) {
        if (Test-Path $p) { Remove-Item -Recurse -Force $p; Dim "  removed $p" }
    }
    Bold "OK  loop desktop uninstalled"
    Dim  "  Your sessions and settings in ~/.loop were left alone."
    return
}

# ── Detect target ─────────────────────────────────────────────────────────
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { $null }
}
# A 32-bit PowerShell on a 64-bit machine reports x86; the real architecture is
# in PROCESSOR_ARCHITEW6432, and installing the x86 build there would fail.
if (-not $arch -and $env:PROCESSOR_ARCHITEW6432) {
    $arch = switch ($env:PROCESSOR_ARCHITEW6432) { "AMD64" { "x64" } "ARM64" { "arm64" } default { $null } }
}
if (-not $arch) { Err "unsupported architecture: $env:PROCESSOR_ARCHITECTURE"; exit 1 }
$target = "win32-$arch"

# ── Resolve latest release tag ────────────────────────────────────────────
function Resolve-LatestTag {
    # The releases/latest redirect rather than the API: it isn't subject to the
    # anonymous rate limit (60 req/h/IP) that bites CI and shared networks.
    try {
        $resp = Invoke-WebRequest -Uri "https://github.com/$RepoSlug/releases/latest" `
            -MaximumRedirection 0 -ErrorAction SilentlyContinue -UseBasicParsing
        $loc = $resp.Headers.Location
        if ($loc -and $loc -match "/tag/(v[0-9][^/]*)$") { return $Matches[1] }
    } catch {
        if ($_.Exception.Response) {
            $loc = $_.Exception.Response.Headers["Location"]
            if ($loc -and $loc -match "/tag/(v[0-9][^/]*)$") { return $Matches[1] }
        }
    }
    try {
        return (Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoSlug/releases/latest" -UseBasicParsing).tag_name
    } catch { return $null }
}

# ── Newest release that actually carries an asset ─────────────────────────
# The desktop app only rebuilds when its own version moves, so a CLI-only
# release publishes no desktop archives — "latest" is regularly not the newest
# release that HAS this asset. The releases list comes back newest first, so
# the first download URL matching the name is the one to take.
function Resolve-AssetUrl($name) {
    try {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoSlug/releases?per_page=30" -UseBasicParsing
        foreach ($r in $releases) {
            foreach ($a in $r.assets) { if ($a.name -eq $name) { return $a.browser_download_url } }
        }
    } catch { }
    return $null
}

$pinned = [bool]$env:LOOP_VERSION
$tag = if ($pinned) { $env:LOOP_VERSION } else { Resolve-LatestTag }
if (-not $tag) { Err "could not resolve latest release tag from $RepoSlug"; exit 1 }
if ($tag -notmatch "^v") { $tag = "v$tag" }

$asset = "loop-desktop-$target.zip"
$url   = "https://github.com/$RepoSlug/releases/download/$tag/$asset"

# Fall back to the release that carries the archive — but never when the user
# pinned a tag: they asked for that build, and quietly installing a different
# one would be worse than failing.
$note = $null
if (-not $pinned) {
    $has = $false
    try {
        Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing | Out-Null
        $has = $true
    } catch { }
    if (-not $has) {
        $alt = Resolve-AssetUrl $asset
        if ($alt) {
            $note = "$tag has no desktop build - installing the newest that does"
            $url = $alt
            $tag = ($alt -split "/")[-2]
        }
    }
}

Bold "loop desktop $tag"
Dim  "  target: $target"
if ($note) { Dim "  $note" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("loop-desktop-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    Dim "  downloading $asset"
    $zip = Join-Path $tmp $asset
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    } catch {
        Err "download failed: $url"
        Err "No desktop build for $target in $tag?"
        exit 1
    }

    Dim "  extracting"
    Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp "x") -Force

    Get-Process -Name "Loop" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if (Test-Path $Home_) { Remove-Item -Recurse -Force $Home_ }
    New-Item -ItemType Directory -Path $Home_ -Force | Out-Null
    Copy-Item -Path (Join-Path $tmp "x\*") -Destination $Home_ -Recurse -Force

    $exe = Join-Path $Home_ "Loop.exe"
    if (-not (Test-Path $exe)) { Err "archive did not contain Loop.exe"; exit 1 }
    # What `loop install desktop` reads to tell whether this copy is current.
    Set-Content -Path (Join-Path $Home_ ".loop-version") -Value $tag.TrimStart("v") -NoNewline

    # Shortcuts are the only way this gets launched — nothing is put on PATH,
    # since a GUI app on PATH is not what anyone reaches for.
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($StartMenu)
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $Home_
    $lnk.Description = "Loop"
    $lnk.Save()
    Dim "  Start Menu shortcut created"

    if ($env:LOOP_DESKTOP_SHORTCUT -eq "1") {
        $d = $shell.CreateShortcut($DesktopLnk)
        $d.TargetPath = $exe
        $d.WorkingDirectory = $Home_
        $d.Save()
        Dim "  Desktop shortcut created"
    }

    Bold "OK  Installed $Home_"
    Dim  "  launch it from the Start Menu (search: Loop)"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
