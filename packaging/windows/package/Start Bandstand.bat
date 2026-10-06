@echo off
setlocal
if not exist "%~dp0app\launcher.ps1" (
  echo Extract the whole ZIP first, then open Start Bandstand in the extracted folder.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\launcher.ps1" %*
if errorlevel 1 pause
