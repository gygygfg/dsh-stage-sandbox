@echo off
rem tools/ebk-sandbox-test.cmd - Windows host entry for the WinStage E2E flow.
rem Keep this file pure ASCII (R11). Requires docker + KVM/TUN on the host.
rem Usage: ebk-sandbox-test.cmd --os-id win11 --run-id r1 [--keep] [--attach] ...
setlocal
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
cd /d "%~dp0.."
"%NODE_EXE%" tools\ebk-sandbox-test.ts %*
exit /b %ERRORLEVEL%
