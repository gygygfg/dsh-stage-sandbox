@echo off
rem dshnt M0 OEM hook: run phase 1 once at first logon.
rem Keep this file pure ASCII (Windows cmd OEM code page).
setlocal EnableExtensions
set "SHARE=\\host.lan\Data"
if not exist "%SHARE%" set "SHARE=Z:"
if not exist "%SHARE%" set "SHARE=\\host.lan\shared"
echo === dshnt m0 install.bat %DATE% %TIME% === > "%SHARE%\m0-hook.log" 2>nul
if not exist "%SHARE%\m0-phase1.ps1" (
  echo m0-phase1.ps1 not found on %SHARE% >> "%SHARE%\m0-hook.log" 2>nul
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SHARE%\m0-phase1.ps1" >> "%SHARE%\m0-phase1-console.log" 2>&1
echo phase1-exit=%ERRORLEVEL% >> "%SHARE%\m0-hook.log" 2>nul
endlocal
