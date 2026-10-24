@echo off
REM Double-click this file once on the clinic computer that stays on all day.
REM It makes the Clinic RCM website start by itself whenever someone signs in to Windows on this computer,
REM stops the computer going to sleep while it is plugged in, and opens Windows Firewall for staff computers.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
echo.
echo Setting up this computer to run Clinic RCM for the staff.
echo.
if exist staff-login.env goto login_ok
echo First choose the username and password your staff will type to open the website.
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
echo Saved in staff-login.env.
:login_ok
REM 1. Start with Windows: a minimised shortcut to start-for-staff.bat in this user's Startup folder
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Clinic RCM.lnk'); $s.TargetPath='%~dp0start-for-staff.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (
  echo Could not add Clinic RCM to the Windows Startup folder.
) else (
  echo [1/3] Clinic RCM will start by itself when you sign in to Windows on this computer.
)
REM 2. No sleep while plugged in (the screen may still turn off)
powercfg /change standby-timeout-ac 0 >nul 2>nul
powercfg /change hibernate-timeout-ac 0 >nul 2>nul
echo [2/3] This computer will not go to sleep while plugged in.
REM 3. Firewall (asks for administrator permission in a second window)
echo [3/3] Opening Windows Firewall. Click Yes if Windows asks for permission.
call open-firewall.bat
echo.
echo Done. Staff can open the website at:
echo     http://%COMPUTERNAME%:3000
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%j in ("%%i") do echo     http://%%j:3000
echo The first address keeps working even if the numbers change.
echo To stop it starting by itself, double-click remove-autostart.bat.
echo.
echo Starting Clinic RCM now...
start "Clinic RCM" /min "%~dp0start-for-staff.bat"
pause
