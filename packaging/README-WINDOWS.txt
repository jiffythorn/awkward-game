THE AWKWARD GAME - quick start (Windows)
=========================================

1. Extract the WHOLE zip to a folder (right-click -> Extract All...).
   The launcher needs the php\ folder next to it.

2. Double-click  "Start Awkward Game.bat"
   - If Windows SmartScreen asks: click "More info" -> "Run anyway".
     (That prompt appears because the file is downloaded, not because
      anything is wrong. Everything runs locally on your PC.)

3. Your browser opens the game automatically.
   - Solo vs AI: just play. Nothing else needed.
   - Multiplayer: friends on your Wi-Fi open the "Friends on Wi-Fi"
     URL shown in the launcher window and join with your room code.

4. Close the launcher window to stop the server.

Notes
-----
- No PHP install, no admin rights, no other downloads. PHP is bundled
  in the php\ folder (official php.net build, run locally).
- Rooms and AI settings are stored in %LOCALAPPDATA%\awkward-game\,
  so you can move or delete this folder without losing games.
- Different port:  set AWKWARD_PORT=3000  before launching.
- No auto-browser: set AWKWARD_NO_BROWSER=1 before launching.
- Hosting over the internet (tunnels, cloud, free PHP hosts):
  see README.md in this folder.
