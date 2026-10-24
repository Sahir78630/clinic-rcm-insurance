@echo off
REM Double-click this file once on the clinic server computer so staff computers can reach the website.
REM It asks for administrator permission, then allows Clinic RCM (port 3000) through Windows Firewall on every network type.
net session >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
netsh advfirewall firewall delete rule name="Clinic RCM" >nul 2>nul
REM A "block Node.js" rule (made when the first network question was cancelled) overrides any allow rule, so remove it
netsh advfirewall firewall delete rule name="Node.js JavaScript Runtime" >nul 2>nul
netsh advfirewall firewall delete rule name="Clinic RCM Node" >nul 2>nul
for /f "delims=" %%n in ('where node') do netsh advfirewall firewall add rule name="Clinic RCM Node" dir=in action=allow program="%%n" profile=any >nul
netsh advfirewall firewall add rule name="Clinic RCM" dir=in action=allow protocol=TCP localport=3000 profile=any
echo.
echo Done. Staff computers on the clinic network can now open the website.
pause
