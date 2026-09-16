#!/usr/bin/env bash
#
# Cut every icon size from the two sources and install them.
#
#   ./branding/install-icon.sh
#
# Sources are `loop-icon.svg` and `loop-mark-small.svg`. Both were generated
# once from SF Mono with glyphs baked to paths, so they carry no font
# dependency and are now edited directly — change the colours or the wordmark
# there, then run this to cut every size again.
#
# The 16px favicon comes from the small mark rather than the icon: four letters
# cannot survive 16 pixels, and a grey smear is worse than a simpler shape.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
src="$here/loop-icon.svg"
small_src="$here/loop-mark-small.svg"

for f in "$src" "$small_src"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
done
command -v magick >/dev/null || { echo "ImageMagick (magick) is required" >&2; exit 1; }

echo "cutting sizes"
for s in 32 48 64 128 180 256 512 1024; do
  magick -background none "$src" -resize ${s}x${s} "$here/icon-${s}.png"
done
magick -background none "$small_src" -resize 16x16 "$here/mark-16.png"
magick -background none "$small_src" -resize 24x24 "$here/mark-24.png"

magick "$here/mark-16.png" "$here/mark-24.png" "$here/icon-32.png" "$here/icon-48.png" \
       "$here/icon-64.png" "$here/icon-128.png" "$here/icon-256.png" "$here/favicon.ico"

# macOS .icns. Only built where iconutil exists.
if command -v iconutil >/dev/null; then
  set="$here/loop.iconset"
  rm -rf "$set"; mkdir -p "$set"
  magick -background none "$small_src" -resize 16x16 "$set/icon_16x16.png"
  for pair in "32:16x16@2x" "32:32x32" "64:32x32@2x" "128:128x128" "256:128x128@2x" \
              "256:256x256" "512:256x256@2x" "512:512x512" "1024:512x512@2x"; do
    magick -background none "$src" -resize "${pair%%:*}x${pair%%:*}" "$set/icon_${pair##*:}.png"
  done
  iconutil -c icns "$set" -o "$here/loop.icns"
  rm -rf "$set"
fi

install() { cp -f "$1" "$2"; echo "  → ${2#$repo/}"; }

echo "installing:"
install "$here/favicon.ico"   "$repo/apps/web/public/favicon.ico"
install "$here/mark-16.png"   "$repo/apps/web/public/favicon-16x16.png"
install "$here/icon-32.png"   "$repo/apps/web/public/favicon-32x32.png"
install "$here/icon-180.png"  "$repo/apps/web/public/apple-touch-icon.png"

install "$here/favicon.ico"   "$repo/site/favicon.ico"
install "$here/mark-16.png"   "$repo/site/favicon-16.png"
install "$here/icon-32.png"   "$repo/site/favicon-32.png"
install "$here/icon-180.png"  "$repo/site/apple-touch-icon.png"
install "$src"                "$repo/site/favicon.svg"

echo
echo "done. rebuild to see it in the app:"
echo "  bun run --filter @loop/web build && (cd apps/desktop && bun build.ts)"
