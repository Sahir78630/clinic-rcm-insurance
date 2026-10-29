@echo off
REM Double-click this file once on the clinic computer that runs Clinic RCM, after creating a tunnel in Cloudflare.
REM It installs Cloudflare Tunnel (cloudflared) as a Windows service, so the web link starts with Windows by itself.
REM See "Web link with Cloudflare Tunnel" in README.md for the steps in the Cloudflare dashboard.
net session >nul 2>nul
if errorlevel 1 (
  echo Asking Windows for administrator permission. Click Yes.
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
cd /d "%~dp0"
echo.
echo Clinic RCM web link setup
echo.

REM 1. Find cloudflared: already installed, in this folder, or downloaded to the Downloads folder
set "CF="
for /f "delims=" %%c in ('where cloudflared 2^>nul') do if not defined CF set "CF=%%c"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if defined CF goto found
REM An installer (.msi) in Downloads: run it, then look again
for %%f in ("%USERPROFILE%\Downloads\cloudflared*.msi") do (
  echo Installing %%~nxf ...
  msiexec /i "%%~ff" /passive /norestart
)
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if defined CF goto found
REM A program (.exe) in this folder or in Downloads: copy it to Program Files so the service keeps working if Downloads is emptied
set "SRC="
if exist "%~dp0cloudflared.exe" set "SRC=%~dp0cloudflared.exe"
if not defined SRC for %%f in ("%USERPROFILE%\Downloads\cloudflared*.exe") do if not defined SRC set "SRC=%%~ff"
if not defined SRC goto notfound
mkdir "%ProgramFiles%\cloudflared" >nul 2>nul
copy /y "%SRC%" "%ProgramFiles%\cloudflared\cloudflared.exe" >nul
if errorlevel 1 goto notfound
set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
goto found

:notfound
echo Cloudflare Tunnel (cloudflared) was not found on this computer.
echo Trying to install it with winget...
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if defined CF goto found
echo.
echo Could not install it automatically. Download cloudflared-windows-amd64.msi from
echo     https://github.com/cloudflare/cloudflared/releases/latest
echo into your Downloads folder, then double-click this file again.
pause
exit /b 1

:found
echo Using %CF%
"%CF%" --version
echo.

REM 2. The tunnel token from the Cloudflare dashboard (you can paste the whole command Cloudflare shows)
echo In the Cloudflare dashboard, on the page for your tunnel, copy the command for Windows.
echo It looks like:  cloudflared.exe service install eyJhIjoi...
echo Paste it here (right-click pastes in this window) and press Enter.
echo.
set "LINE="
set /p LINE=Command or token: 
if not defined LINE (
  echo Nothing was pasted.
  pause
  exit /b 1
)
REM Keep only what follows "install", without spaces
set "TOKEN=%LINE:*install =%"
for /f "tokens=1" %%t in ("%TOKEN%") do set "TOKEN=%%t"
if "%TOKEN:~0,3%" NEQ "eyJ" (
  echo That does not look like a tunnel token. It should start with eyJ. Copy it again from the Cloudflare dashboard.
  pause
  exit /b 1
)

REM 3. Install as a Windows service (replacing an earlier one)
sc query cloudflared >nul 2>nul
if not errorlevel 1 (
  echo Removing the earlier Cloudflare Tunnel service...
  "%CF%" service uninstall >nul 2>nul
  timeout /t 3 /nobreak >nul
)
"%CF%" service install %TOKEN%
if errorlevel 1 (
  echo.
  echo Installing the service failed. Check the message above, then try again.
  pause
  exit /b 1
)
echo.
echo Done. Cloudflare Tunnel now runs as a Windows service and starts with Windows by itself.
echo.
echo Last step, in the Cloudflare dashboard: on your tunnel, add a Public Hostname
echo     Subdomain: rcm      Domain: your clinic's domain
echo     Type: HTTP          URL: localhost:3000
echo Then open https://rcm.your-domain in any browser and sign in.
echo.
pause
