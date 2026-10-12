@echo off
rem e2e/guest/install.bat - dockurr/windows /oem hook, run once at first logon.
rem Reads run.env from the Samba share and hands off to bootstrap.ps1.
rem Keep this file pure ASCII (R11).
setlocal EnableExtensions EnableDelayedExpansion

set "SHARE=\\host.lan\Data"
if not exist "%SHARE%" set "SHARE=Z:"

echo === install.bat %DATE% %TIME% === > "%SHARE%\install-hook.log"
if exist "%SHARE%\run.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%SHARE%\run.env") do (
    if not "%%A"=="" if not "%%A:~0,1"=="#" set "%%A=%%B"
  )
) else (
  echo run.env not found >> "%SHARE%\install-hook.log"
)

set "EBK_SHARE=%SHARE%"
echo share=%SHARE% run=%EBK_RUN_ID% >> "%SHARE%\install-hook.log"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SHARE%\bootstrap.ps1" >> "%SHARE%\bootstrap-console.log" 2>&1
echo bootstrap-exit=%ERRORLEVEL% >> "%SHARE%\install-hook.log"
endlocal
