@echo off
rem === WinStage GUI 自动化运行器（旅客机内，管理员）===
rem 用 DSH 桌面端自带的 Python 跑 pywinauto，按控件名驱动，替代不可靠的像素点击。
rem 结果写到 Samba 共享 \\host.lan\Data\（dsh-gui.log / dsh-gui-tree.txt / dsh-gui-shot.png）。
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
