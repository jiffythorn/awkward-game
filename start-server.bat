@echo off
REM =============================================================
REM The Awkward Game - one-command local server (Windows)
REM Serves the game UI and the multiplayer API on the same port,
REM so one URL works for you AND everyone joining with your code.
REM
REM   start-server.bat            -> port 8080
REM   set AWKWARD_PORT=3000 && start-server.bat
REM
REM Stop with Ctrl+C (or close the window).
REM =============================================================
setlocal
cd /d "%~dp0"

set PORT=8080
if not "%AWKWARD_PORT%"=="" set PORT=%AWKWARD_PORT%

where php >nul 2>nul
if errorlevel 1 (
  echo PHP is not installed. Hosting multiplayer needs PHP 7.4+ ^8.x recommended^.
  echo.
  echo   Install it with one of:
  echo     winget install PHP.PHP.8.4
  echo     choco install php
  echo     XAMPP  https://www.apachefriends.org
  echo.
  echo   No PHP at all? Single-player vs AI still works by opening
  echo   index.html directly in a browser - no server needed.
  pause
  exit /b 1
)

if not exist "rooms\data" mkdir "rooms\data"

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do set LAN_IP=%%b
)

echo ==========================================================
echo   The Awkward Game  -  PHP server starting
echo ==========================================================
echo   Play here:        http://localhost:%PORT%
if defined LAN_IP echo   Friends on Wi-Fi: http://%LAN_IP%:%PORT%
echo.
echo   1. Open the URL, Create room, share the 6-letter CODE.
echo   2. Friends open the SAME URL and Join with the code.
echo   3. Friends outside your network? See README.md (Hosting).
echo ==========================================================
echo   Ctrl+C stops the server.  Rooms are saved in rooms\.
echo ==========================================================

php -S 0.0.0.0:%PORT%
