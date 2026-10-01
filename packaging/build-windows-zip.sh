#!/bin/sh
# =============================================================
# build-windows-zip.sh — build The Awkward Game as a portable
# Windows zip: game + bundled official PHP runtime + launcher.
#
#   ./packaging/build-windows-zip.sh                    build the zip
#   ./packaging/build-windows-zip.sh --php-zip FILE     use a cached php zip
#
# Output: dist/The-Awkward-Game-<ver>-windows-x64.zip
# (Local PHP is Linux-only; this script just packages files, so it
#  runs fine on Linux/macOS/CI. Smoke-testing php.exe needs Windows.)
# =============================================================
set -eu
cd "$(dirname "$0")/.."

VER="$(sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\)/\1/p' README.md | head -1)"
[ -n "$VER" ] || VER="1.0"
PHPVER="8.3.35"
STAGE=".build/win/awkward-game"
OUT="dist/The-Awkward-Game-$VER-windows-x64.zip"
CACHE=".build/win/php.zip"

mkdir -p dist .build/win

# --- fetch the official Windows PHP (NTS x64) if not cached ------------------
if [ ! -f "$CACHE" ]; then
  echo "→ downloading php-$PHPVER-nts-Win32-vs16-x64.zip…"
  curl -fL -o "$CACHE" \
    "https://windows.php.net/downloads/releases/php-$PHPVER-nts-Win32-vs16-x64.zip"
fi

# --- stage the game ----------------------------------------------------------
rm -rf "$STAGE"
mkdir -p "$STAGE/php/ext"
cp -r index.html style.css game.js rules.html RULES.md README.md data rooms "$STAGE/"
rm -rf "$STAGE/rooms/data"                       # never ship room state
cp packaging/start-windows.bat "$STAGE/Start Awkward Game.bat"
cp packaging/README-WINDOWS.txt "$STAGE/README-WINDOWS.txt"
cp packaging/php-win.ini "$STAGE/php/php.ini"

# --- trim the PHP runtime to what the backend uses ---------------------------
unzip -q "$CACHE" -d "$STAGE/php" \
  php.exe php8.dll license.txt readme-redist-bins.txt \
  libcrypto-3-x64.dll libssl-3-x64.dll nghttp2.dll \
  brotlicommon.dll brotlidec.dll \
  ext/php_curl.dll ext/php_mbstring.dll ext/php_openssl.dll \
  ext/php_sockets.dll ext/php_sodium.dll \
  extras/ssl/openssl.cnf extras/ssl/legacy.dll libsodium.dll libssh2.dll

# --- sanity: every staged piece present --------------------------------------
for f in "php/php.exe" "php/php8.dll" "php/php.ini" "php/ext/php_curl.dll" \
         "php/ext/php_mbstring.dll" "php/ext/php_openssl.dll" \
         "php/ext/php_sockets.dll" "php/ext/php_sodium.dll" \
         "Start Awkward Game.bat" "index.html" "game.js" "rooms/lib.php" \
         "data/cards.js" "data/cards.json"; do
  [ -f "$STAGE/$f" ] || { echo "✗ missing $STAGE/$f" >&2; exit 1; }
done

echo "→ zipping $OUT…"
rm -f "$OUT"
( cd ".build/win/awkward-game" && zip -qr "../../../$OUT" . )
ls -lh "$OUT"
echo "✔ done: $OUT"
