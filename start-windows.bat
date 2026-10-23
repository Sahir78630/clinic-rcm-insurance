@echo off
REM Double-click this file to start the Clinic RCM website on this computer.
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
echo Starting Clinic RCM. Keep this window open while you use the website.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://127.0.0.1:3000'"
node --disable-warning=ExperimentalWarning server.js
pause
