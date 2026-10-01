#!/usr/bin/env sh
# =============================================================
# The Awkward Game — one-command local server (Linux / macOS)
# Serves the game UI and the multiplayer API on the same port,
# so one URL works for you AND everyone joining with your code.
#
#   ./start-server.sh                 -> port 8080
#   AWKWARD_PORT=3000 ./start-server.sh
#
# Stop with Ctrl+C.
# =============================================================
set -e

PORT="${AWKWARD_PORT:-8080}"
cd "$(dirname "$0")"

if ! command -v php >/dev/null 2>&1; then
  echo "✗ PHP is not installed. Hosting multiplayer needs PHP 7.4+ (8.x recommended)."
  echo ""
  echo "  Install it with one of:"
  echo "    Debian/Ubuntu : sudo apt install php-cli"
  echo "    Fedora        : sudo dnf install php-cli"
  echo "    Arch          : sudo pacman -S php"
  echo "    macOS (brew)  : brew install php"
  echo ""
  echo "  (No PHP at all? Single-player vs AI still works by opening"
  echo "   index.html directly in a browser — no server needed.)"
  exit 1
fi

PHP_VERSION="$(php -r 'echo PHP_VERSION;' 2>/dev/null || echo '?')"
case "$PHP_VERSION" in
  4*|5*|7.0*|7.1*|7.2*|7.3*)
    echo "! PHP $PHP_VERSION found. PHP 7.4+ / 8.x is recommended; continuing anyway."
    ;;
esac

mkdir -p rooms/data

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "$LAN_IP" ] && command -v ipconfig >/dev/null 2>&1; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
fi

echo "=========================================================="
echo "  The Awkward Game  —  PHP $PHP_VERSION"
echo "=========================================================="
echo "  Play here:        http://localhost:$PORT"
if [ -n "$LAN_IP" ]; then echo "  Friends on Wi-Fi: http://$LAN_IP:$PORT"; fi
echo ""
echo "  1. Open the URL, Create room, share the 6-letter CODE."
echo "  2. Friends open the SAME URL (or the Friends URL above)"
echo "     and Join with the code."
echo "  3. Friends outside your network? See README.md ( Hosting )."
echo "=========================================================="
echo "  Ctrl+C stops the server.  Rooms are saved in rooms/."
echo "=========================================================="

exec php -S 0.0.0.0:"$PORT"
