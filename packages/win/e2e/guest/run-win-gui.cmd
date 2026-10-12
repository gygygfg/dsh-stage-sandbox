@echo off
rem === WinStage GUI automation runner (inside guest, administrator) ===
rem Runs pywinauto with the Python shipped in the DSH desktop app and drives the
rem UI by control name, replacing unreliable pixel clicks.
rem Results are written to the Samba share \\host.lan\Data\ (dsh-gui.log /
rem dsh-gui-tree.txt / dsh-gui-shot.png).
rem NOTE: keep this file pure ASCII (R11): cmd.exe parses batch files in the OEM
rem code page, so non-ASCII comments get decoded as garbage and executed.
setlocal enableextensions
set "ROOT=%LOCALAPPDATA%\Programs\DeepSeek Harness"
set "RUNLOG=\\host.lan\Data\dsh-gui-run.txt"
set "SCRIPT=\\host.lan\Data\dsh_gui.py"
echo === dsh-gui runner %DATE% %TIME% === > "%RUNLOG%"

set "PY="
for /f "delims=" %%P in ('dir /b /s "%ROOT%\resources\runtime\primary-runtime\dependencies\python\python.exe" 2^>nul') do set "PY=%%P"
if not defined PY for /f "delims=" %%P in ('dir /b /s "%ROOT%\resources\runtime\python.exe" 2^>nul') do set "PY=%%P"
echo PY=%PY% >> "%RUNLOG%"
if not defined PY (
  echo python not found under %ROOT% >> "%RUNLOG%"
  exit /b 1
)

"%PY%" -m pip install --disable-pip-version-check --no-input pywinauto pillow >> "%RUNLOG%" 2>&1
echo pip-exit=%errorlevel% >> "%RUNLOG%"

"%PY%" "%SCRIPT%" %* >> "%RUNLOG%" 2>&1
echo script-exit=%errorlevel% >> "%RUNLOG%"
