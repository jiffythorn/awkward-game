@echo off
REM =============================================================
REM The Awkward Game - portable Windows launcher
REM Double-click this file. It uses the bundled PHP in php\ -
REM no PHP install, no admin rights, nothing else to install.
REM
REM   Start Awkward Game.bat            -> port 8080 (or next free)
REM   set AWKWARD_PORT=3000 && Start Awkward Game.bat
REM   set AWKWARD_NO_BROWSER=1 && Start Awkward Game.bat
REM
REM Close this window (or Ctrl+C) to stop the server.
REM =============================================================
setlocal
cd /d "%~dp0"

set PHP=php\php.exe
if not exist "%PHP%" (
  echo ERROR: php\php.exe not found - unzip the whole archive first.
  pause
  exit /b 1
)

REM --- writable state: rooms + AI config live outside the program folder ------
set "STATE=%LOCALAPPDATA%\awkward-game"
if not exist "%STATE%\rooms" mkdir "%STATE%\rooms" 2>nul
if errorlevel 1 set "STATE=%CD%\rooms" & if not exist "%STATE%" mkdir "%STATE%"
set "AWKWARD_DATA_DIR=%STATE%\rooms"

REM --- port: respect AWKWARD_PORT, else first free from 8080 up ---------------
REM probe exits 0 when the port is FREE (connect refused), 1+ when busy.
set PORT=8080
if not "%AWKWARD_PORT%"=="" set PORT=%AWKWARD_PORT%
set TRIES=0
:pickport
"%PHP%" -r "exit((int)@fsockopen('127.0.0.1', $argv[1], $e, $s, 0.2));" %PORT% 2>nul
if errorlevel 1 goto busyport
goto portready
:busyport
set /a PORT+=1
set /a TRIES+=1
if %TRIES% geq 20 goto noport
goto pickport
:noport
echo No free port found - tried 20 ports. Close other apps or set AWKWARD_PORT.
pause
exit /b 1
:portready
echo %PORT%>"%STATE%\port.txt"

REM --- LAN IP for the friends hint --------------------------------------------
set LAN_IP=
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do if not defined LAN_IP set "LAN_IP=%%b"
)

echo ==========================================================
echo   The Awkward Game  -  portable edition
echo ==========================================================
echo   Play here:        http://localhost:%PORT%
if defined LAN_IP echo   Friends on Wi-Fi: http://%LAN_IP%:%PORT%
echo   Room ^& AI data:   %STATE%
echo.
echo   1. Open the URL, Create room, share the 6-letter CODE.
echo   2. Friends open the Friends URL (same Wi-Fi) and Join.
echo      Outside your network? Host online - see README.md.
echo   3. Close this window or press Ctrl+C to stop.
echo ==========================================================

REM --- open the default browser 2 seconds after the server is up --------------
if "%AWKWARD_NO_BROWSER%"=="1" goto serve
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"

:serve
"%PHP%" -d extension_dir="%~dp0php\ext" -c "%~dp0php" -S 127.0.0.1:%PORT%
