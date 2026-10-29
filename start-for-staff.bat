@echo off
REM Double-click this file to share the Clinic RCM website with staff computers on the clinic network.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
set HOST=0.0.0.0
if "%PORT%"=="" set PORT=3000
echo.
echo Clinic RCM is shared on the clinic network. Keep this window open.
echo On a staff computer, open one of these addresses in Chrome or Edge:
echo     http://%COMPUTERNAME%:%PORT%
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%j in ("%%i") do echo     http://%%j:%PORT%
echo and sign in with your own username and password.
echo The first time, open the website on this computer to create the admin account.
echo If Windows asks whether to allow Node.js on the network, choose Private networks and click Allow.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://127.0.0.1:%PORT%'"
node --disable-warning=ExperimentalWarning server.js
pause
