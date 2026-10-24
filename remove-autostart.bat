@echo off
REM Double-click this file to stop Clinic RCM starting by itself when you sign in to Windows.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Clinic RCM.lnk" >nul 2>nul
echo Clinic RCM will no longer start by itself. Use start-for-staff.bat to start it.
pause
