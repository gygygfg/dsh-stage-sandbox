@echo off
rem ---------------------------------------------------------------------------
rem  verify.cmd - run every OFFLINE deterministic suite.
rem
rem  These suites need no Win32 sandbox, no restricted token, and no reboot, so
rem  they run in any session (including a confined one). Use them before asking
rem  anyone to re-run the in-sandbox audit.
rem
rem  NOTE: keep this file pure ASCII. cmd.exe parses batch files using the OEM
rem  code page, so non-ASCII comments get decoded as garbage and executed.
rem  This is documented residual boundary R11 in the Windows feature list
rem  document, section 13 (that .md file is UTF-8; this .cmd must not be).
rem ---------------------------------------------------------------------------
setlocal EnableExtensions EnableDelayedExpansion
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
cd /d "%~dp0"
rem  Seal-hatch guard: this file runs the WHOLE gate, so it must never inherit the
rem  dev-only "unsealed" escape hatch. tests\baseline-integrity.ts honours
rem  WINSTAGE_ALLOW_UNSEALED=1 (or --allow-unsealed) by printing
rem  "RESULT: SKIP manifest-unsealed-allowed" and exiting 0. That is correct for a
rem  human running that one suite by hand, but if the gate inherited it, moving
rem  the source baseline manifest (docs\source baseline, SHA-256 list) away would
rem  still end in "RESULT: ALL PASS" - the gate's final line is its authority, so
rem  the seal could be silently disabled in that configuration.
rem  Clearing it here covers every child process of this run; src\testrunner.ts
rem  deletes the same key for every suite it spawns (autotest.ts and the HTTP
rem  test service included). Keep this file pure ASCII (residual boundary R11).
set "WINSTAGE_ALLOW_UNSEALED="
set FAIL=0
rem  The list below must match src\testrunner.ts OFFLINE_SUITES **id for id, in
rem  the same order and with the same count** (tests\suite-wiring.ts enforces
rem  this mechanically; before that guard existed the two lists had silently
rem  drifted in order). History, so nobody re-introduces the same defect:
rem    - fix phase: added appcontainer-layout + meta-runner (they existed but
rem      verify.cmd never ran them, which made "verify is green" weaker than it
rem      looked), plus paths-masks and workspace-regressions (both new).
rem    - FIX-C: registry-guard existed and was green by hand, but was in neither
rem      list, so nothing would have noticed it breaking.
rem    - FIX-F: appcontainer-runtime + probe-selfkill-guard, same story.
rem    - this round: netpolicy / mitigations / limits / integration-wiring
rem      (three new offline capabilities plus the wiring acceptance suite) and
rem      wfp-layout (pre-existing, offline by its own header, never registered).
rem  Also added: the two governance suites suite-wiring + residual-baseline,
rem  which turn "the registry drifted" and "a residual boundary disappeared"
rem  into hard failures instead of something a human has to remember.
rem  Latest round (C3): policy-never-consistency - the machine guard for the
rem  approval-policy (ask -> never) user-visible surface: an explicit
rem  defaultPreset in the active profile (missing => the composer access-mode
rem  control disappears entirely), a static narrowest sandboxMode, a
rem  policy-independent slot takeover, no platform approval seam, and an audit
rem  mirror that never fabricates an approval decision.
rem  This round: baseline-integrity + dsh-patch-guard.
rem    - tests\baseline-integrity.ts: the .gitignore ignores tests/ and tools/
rem      is untracked, so "comments only, no behaviour change" had no baseline
rem      to check against. docs\source baseline manifest (Chinese file name,
rem      docs\<U+6E90><U+7801><U+57FA><U+7EBF>.sha256) is now a hard gate.
rem    - tests\dsh-patch-guard.ts: DSH is an npx cache install tree, so a hand
rem      edit is silently lost on reinstall/upgrade. The guard requires the
rem      installed file hash to be exactly before or after, else RED.
rem  Both are offline (no subprocess, no network, no admin) and are registered
rem  in src\testrunner.ts OFFLINE_SUITES in this exact order.
rem  NOTE: tests\integration-wiring.ts is created by a parallel agent; if it is
rem  still absent, this loop WILL fail - that is the honest outcome, not a
rem  reason to drop it from the list.
rem  Latest round (fix-3): boundary-degraded-failclosed - defect 3 (a single T0 run
rem  left an AppContainer package-SID ACE on the staged root, which permanently
rem  broke T1 staging writes while exec still ran the command and returned 0).
rem  Section A is pure/deterministic; section B injects one ACE into a scratch
rem  workspace under .t\ and always removes it again.
rem  This round (finisher): whiteout-candidate-capture - defect 1b (a shim whiteout
rem  marker under <staged>\wo\... used to be reported as a bogus `wo\...` create
rem  while a deletion of a never-staged real file produced NO delta at all, i.e.
rem  "deleted 0 items"). The suite was promoted verbatim from
rem  .t\shim-delete\test-whiteout-capture.ts and needs no shim and no sandbox.
rem  This round (fix-2): assembly-toggle-selftest - the shell half of the sandbox was
rem  gated on the process env var WINSTAGE_SHELL, so the second instance never mounted
rem  winstage-shell and its ctx.shell stayed the platform one: no shim, hence no
rem  registry overlay and registry writes survived only as a kernel denial. The gate
rem  is now the profile switch. The suite pins the two `disabled: !!js` expressions in
rem  dsh-plugin\cordis.patch.yml as exact mutual inverses across env x profile, and
rem  also pins the YAML shape (a scalar starting with `!` is parsed as a second tag
rem  and skips the whole bundle patch).
for %%S in (tests\selftest.ts tests\e2e-flow.ts tests\struct-layout.ts tests\appcontainer-layout.ts tests\resolve-exec.ts tests\executor-stub.ts tests\audit-parse.ts tests\paths-masks.ts tests\registry-guard.ts tests\workspace-regressions.ts tests\meta-runner.ts tests\appcontainer-runtime.ts tests\probe-selfkill-guard.ts tests\netpolicy.ts tests\mitigations.ts tests\limits.ts tests\integration-wiring.ts tests\wfp-layout.ts tests\suite-wiring.ts tests\residual-baseline.ts tests\policy-never-consistency.ts tests\baseline-integrity.ts tests\dsh-patch-guard.ts tests\boundary-degraded-failclosed.ts tests\whiteout-candidate-capture.ts tests\assembly-toggle-selftest.ts tests\session-enclosure-selftest.ts tests\sandbox-audit.ts tests\environment-gate.ts tests\plugin-approval-align.ts tests\crosscheck-boundaries.ts tests\crosscheck-r17.ts) do (
  rem R11 hermeticity fix: without an explicit per-suite root every suite in this
  rem loop shares %LOCALAPPDATA%\Temp\winstage-stage\<DSH_SESSION_ID>. Leftover
  rem staged files/candidates from an earlier suite then leak into a later one:
  rem whiteout-candidate-capture read a foreign a.txt (create=4 instead of 1) and
  rem failed apply with BLOB_MISSING a.txt -- reproducible in-gate, green when run
  rem alone. A unique pinned root per suite is the supported escape hatch.
  rem NOTE: base it on LOCALAPPDATA (long form), NOT %TEMP% -- this box exports
  rem TEMP as the 8.3 alias C:\Users\ADMINI~1\... and the store-internal-marker
  rem check compares against the long path, so a short-form root fails it.
  set "WINSTAGE_STAGE_ROOT=%LOCALAPPDATA%\Temp\winstage-stage-gate-%%~nS-!RANDOM!!RANDOM!"
  echo === %%S ===
  "%NODE_EXE%" %%S
  if errorlevel 1 set FAIL=1
)
echo.
if "%FAIL%"=="1" (echo RESULT: FAIL) else (echo RESULT: ALL PASS)
exit /b %FAIL%
