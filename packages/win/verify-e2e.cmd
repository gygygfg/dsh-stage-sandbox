@echo off
REM WinStage E2E gate (real DSH web processes / Playwright / network; not part of verify.cmd)
REM Usage: run verify-e2e.cmd from packages\win
setlocal
cd /d "%~dp0"
for %%S in (
  approval-thread.mjs
  ui-residue.mjs
  stealth-probes.mjs
  r34-pip.mjs
  r34-npm.mjs
  pending-restart.mjs
) do (
  echo.
  echo === e2e\r49\%%S ===
  node "e2e\r49\%%S"
  if errorlevel 1 (
    echo [verify-e2e] FAIL: %%S
    exit /b 1
  )
)
echo.
echo [verify-e2e] ALL PASS
exit /b 0
