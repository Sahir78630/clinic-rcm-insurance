@echo off
REM Double-click this file to share the Clinic RCM website with staff computers on the clinic network.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
if exist staff-login.env goto start
echo.
echo First time only: choose the username and password your staff will type to open the website.
echo This is a website login, not your eClaimLink password.
echo.
set /p APP_USERNAME=Username for staff: 
set /p APP_PASSWORD=Password for staff: 
if "%APP_PASSWORD%"=="" (
  echo The password cannot be empty.
  pause
  exit /b 1
)
> staff-login.env echo APP_USERNAME=%APP_USERNAME%
>> staff-login.env echo APP_PASSWORD=%APP_PASSWORD%
echo Saved in staff-login.env. Delete that file to choose a new username and password.
:start
for /f "usebackq tokens=1,* delims==" %%a in ("staff-login.env") do set "%%a=%%b"
set HOST=0.0.0.0
if "%PORT%"=="" set PORT=3000
echo.
echo Clinic RCM is shared on the clinic network. Keep this window open.
echo On a staff computer, open one of these addresses in Chrome or Edge:
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%j in ("%%i") do echo     http://%%j:%PORT%
echo and sign in with the staff username and password.
echo If Windows asks whether to allow Node.js on the network, choose Private networks and click Allow.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://127.0.0.1:%PORT%'"
node --disable-warning=ExperimentalWarning server.js
pause
