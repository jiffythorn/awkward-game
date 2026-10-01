#!/bin/sh
# =============================================================
# build-appimage.sh — build The Awkward Game as a Linux AppImage
#
#   ./packaging/build-appimage.sh            build the AppImage
#   ./packaging/build-appimage.sh --tools    also (re)download build tools first
#
# Output: dist/The-Awkward-Game-x86_64.AppImage
# =============================================================
set -eu
cd "$(dirname "$0")/.."

APP="awkward-game"
VER="$(sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\)/\1/p' README.md | head -1)"
[ -n "$VER" ] || VER="1.0"
APPDIR=".build/AppDir"
TOOLS=".build/tools"

# --- build tools (static PHP + appimagetool) --------------------------------
if [ "${1:-}" = "--tools" ] || [ ! -x "$TOOLS/php" ] || [ ! -x "$TOOLS/appimagetool" ]; then
  mkdir -p "$TOOLS"
  if [ ! -x "$TOOLS/php" ]; then
    echo "→ downloading static PHP 8.3 CLI…"
    curl -sL -o "$TOOLS/php.tar.gz" \
      "https://dl.static-php.dev/static-php-cli/common/php-8.3.24-cli-linux-x86_64.tar.gz"
    tar xzf "$TOOLS/php.tar.gz" -C "$TOOLS" php
    rm -f "$TOOLS/php.tar.gz"
    chmod +x "$TOOLS/php"
  fi
  if [ ! -x "$TOOLS/appimagetool" ]; then
    echo "→ downloading appimagetool…"
    curl -sL -o "$TOOLS/appimagetool" \
      "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x "$TOOLS/appimagetool"
  fi
fi

# --- assemble the AppDir -----------------------------------------------------
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/icons/hicolor/256x256/apps" dist

cp -r index.html style.css game.js rules.html RULES.md README.md data rooms "$APPDIR/"
rm -rf "$APPDIR/rooms/data"                    # never ship room state
cp packaging/AppRun "$APPDIR/AppRun"
cp packaging/io.github.awkwardgame.AwkwardGame.desktop "$APPDIR/io.github.awkwardgame.AwkwardGame.desktop"
cp packaging/io.github.awkwardgame.AwkwardGame.desktop "$APPDIR/$APP.desktop"
cp packaging/awkward-game.png "$APPDIR/$APP.png"
cp packaging/awkward-game.png "$APPDIR/usr/share/icons/hicolor/256x256/apps/$APP.png"
cp "$TOOLS/php" "$APPDIR/usr/bin/php"
chmod +x "$APPDIR/AppRun" "$APPDIR/usr/bin/php"

# minimal AppStream metadata (silences the appimagetool warning)
mkdir -p "$APPDIR/usr/share/metainfo"
cp packaging/io.github.awkwardgame.AwkwardGame.metainfo.xml "$APPDIR/usr/share/metainfo/io.github.awkwardgame.AwkwardGame.metainfo.xml"

# --- wrap it up --------------------------------------------------------------
echo "→ packing AppImage (v$VER)…"
"$TOOLS/appimagetool" --comp zstd "$APPDIR" "dist/The-Awkward-Game-$VER-x86_64.AppImage"

ls -lh dist/
echo "✔ done: dist/The-Awkward-Game-$VER-x86_64.AppImage"
