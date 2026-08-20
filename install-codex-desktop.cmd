@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-codex-desktop.ps1"
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo Installation failed with exit code %EXIT_CODE%.
) else (
  echo Installation completed. Codex should open the Thearchy plugin page.
)
pause
exit /b %EXIT_CODE%
