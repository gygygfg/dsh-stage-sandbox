"""Fix browser-harness so `browser-use` works in this environment without manual setup.

Root causes fixed (see FIX-EDGE-RUNBOOK-v3.md):

1. `daemon.PROFILES` enumerates only well-known Chrome/Edge profile directories, so a
   dedicated automation profile outside that list is never polled for
   `DevToolsActivePort` -> `RuntimeError: DevToolsActivePort not found in [...]`.
2. `admin._launch_browser()` ignores `BH_CHROME_PATH` when the browser needs
   `--remote-debugging-port`, and the Windows branch shells out to
   `cmd /c start chrome` (Chrome is not installed here) -> nothing ever listens.
3. The browser is spawned into the WinStage file-staging sandbox, so its profile is
   redirected into the staging tree. A live browser then holds those staged files, which
   wedges the whole session's shell with `EBUSY`. The browser must run unshimmed.

Idempotent: safe to run repeatedly. Backs up once to *.bh-fix.bak.
Run with the tool's own python:
  C:\\Users\\Administrator\\AppData\\Roaming\\uv\\tools\\browser-use\\Scripts\\python.exe fix-browser-harness.py
"""

import os
import shutil
import sys
from pathlib import Path

MARK = "BH-FIX"


def _find_pkg():
    """Locate browser_harness: CLI arg > this interpreter's site-packages > uv tool root."""
    if len(sys.argv) > 1:
        cand = Path(sys.argv[1])
        return cand / "browser_harness" if (cand / "browser_harness").is_dir() else cand
    try:
        import browser_harness  # noqa: F401

        return Path(browser_harness.__file__).resolve().parent
    except Exception:
        pass
    for root in (
        Path(os.environ.get("APPDATA", "")) / "uv" / "tools" / "browser-use",
        Path.home() / ".local" / "share" / "uv" / "tools" / "browser-use",
    ):
        cand = root / "Lib" / "site-packages" / "browser_harness"
        if cand.is_dir():
            return cand
    return None


PKG = _find_pkg()
if not PKG or not PKG.is_dir():
    print(f"FAIL: browser_harness package not found (tried argv, import, uv tool roots)")
    sys.exit(1)

print(f"package: {PKG}")


def patch(name, old, new, label, marker=None):
    """Apply one edit. `marker` is the idempotency probe: if it is already present the
    edit was applied by an earlier run (using `new` as the probe would re-apply a
    whitespace-normalised variant every time)."""
    probe = marker or new
    path = PKG / name
    text = path.read_text(encoding="utf-8")
    if probe in text:
        print(f"  [skip] {label} (already applied)")
        return True
    if old not in text:
        print(f"  [FAIL] {label}: anchor not found in {name}")
        return False
    bak = path.with_suffix(path.suffix + ".bh-fix.bak")
    if not bak.exists():
        shutil.copy2(path, bak)
        print(f"  [backup] {bak.name}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"  [ok] {label}")
    return True


ok = True

# --- 1. let an explicit automation profile be part of discovery ------------------
ok &= patch(
    "daemon.py",
    '''def profile_dirs(system=None):
    system = system or platform.system()
    if system == "Windows":''',
    '''def profile_dirs(system=None):
    """Profile dirs to poll for DevToolsActivePort.

    BH-FIX: an explicit automation profile (BH_CHROME_USER_DATA_DIR) is honoured on
    every platform. Without this a dedicated profile outside the well-known list is
    never polled, and every call dies with "DevToolsActivePort not found".
    """
    system = system or platform.system()
    explicit = (os.environ.get("BH_CHROME_USER_DATA_DIR") or "").strip()
    if explicit:
        try:
            return [Path(explicit).expanduser()]
        except (OSError, ValueError):
            pass
    if system == "Windows":''',
    "daemon.profile_dirs honours BH_CHROME_USER_DATA_DIR",
)

# --- 2. spawn the browser with remote debugging and outside the staging shim -----
ok &= patch(
    "admin.py",
    '''    enabled = remote_debugging_toggle_profiles()
    known_profiles = enabled + [''',
    '''    # BH-FIX: honour an explicit user-data-dir, pass through extra browser args
    # (BH_CHROME_ARGS), and keep the browser out of the WinStage file-staging shim.
    # A staged browser profile locks the staging tree and wedges every later shell
    # call with EBUSY, so the browser must run unshimmed.
    def _bh_fix_env():
        env = dict(os.environ)
        if os.environ.get("DSH_REGSTAGE_ROOT") or os.environ.get("WINSTAGE_STAGE_ROOT"):
            env.setdefault("WINSTAGE_SHIM_DISABLE", "1")
        return env

    def _bh_fix_args(base_dir=None):
        extra = [a for a in (os.environ.get("BH_CHROME_ARGS") or "").split() if a]
        profile_arg = None
        if base_dir is not None:
            profile_arg = f"--user-data-dir={base_dir}"
        elif explicit_ud := (os.environ.get("BH_CHROME_USER_DATA_DIR") or "").strip():
            profile_arg = f"--user-data-dir={Path(explicit_ud).expanduser()}"
        merged, seen = [], set()
        for arg in ([profile_arg] if profile_arg else []) + extra:
            key = arg.split("=", 1)[0]
            if key.startswith("--") and key in seen:
                continue
            seen.add(key)
            merged.append(arg)
        return merged

    enabled = remote_debugging_toggle_profiles()
    explicit_ud = (os.environ.get("BH_CHROME_USER_DATA_DIR") or "").strip()
    if explicit_ud:
        try:
            explicit_base = Path(explicit_ud).expanduser()
        except (OSError, ValueError):
            explicit_base = None
        if explicit_base is not None and explicit_base not in enabled:
            enabled = [explicit_base] + enabled
    known_profiles = enabled + [''',
    "admin._launch_browser honours BH_CHROME_USER_DATA_DIR / BH_CHROME_ARGS",
)

ok &= patch(
    "admin.py",
    '''                process = subprocess.Popen(
                    [str(binary)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **ipc.spawn_kwargs(),
                )''',
    '''                process = subprocess.Popen(
                    [str(binary)] + _bh_fix_args(),
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env=_bh_fix_env(), **ipc.spawn_kwargs(),
                )''',
    "BH_CHROME_PATH launch passes profile + extra args",
)

ok &= patch(
    "admin.py",
    '''            subprocess.Popen(["cmd", "/c", "start", "", win_target or "chrome"] + profile_args, **ipc.spawn_kwargs())''',
    '''            subprocess.Popen(
                ["cmd", "/c", "start", "", win_target or "chrome"] + profile_args + _bh_fix_args(base),
                env=_bh_fix_env(), **ipc.spawn_kwargs(),
            )''',
    "Windows fallback launch passes extra args",
)

# --- 3. return the profile we actually launched, or the daemon kills it ----------
# On Windows the BH_CHROME_PATH branch returned `None` as the profile, so
# ensure_daemon()'s cleanup path (_cleanup_unattached_browser_launch) treated the
# browser we had just started as unattached residue and killed it -> the daemon could
# never attach and the shell always died with the DevToolsActivePort error.
ok &= patch(
    "admin.py",
    '''                profile = next(
                    (base for base in known_profiles if _browser_binary_matches_profile(binary, base)),
                    None,
                ) if system not in ("Darwin", "Windows") else None
                return process, profile''',
    '''                profile = next(
                    (base for base in known_profiles if _browser_binary_matches_profile(binary, base)),
                    None,
                )
                if profile is None:
                    # BH-FIX: report the profile we actually launched with. On Windows
                    # this used to be None, which made ensure_daemon() treat the browser
                    # we just started as unattached residue and kill it.
                    profile = explicit_base if explicit_ud else (known_profiles[0] if known_profiles else None)
                return process, profile''',
    "return the launched profile (Windows cleanup no longer kills the browser)",
    marker="report the profile we actually launched with",
)

# --- 4. keep the Windows `start` fallback from killing a valid launch ------------
ok &= patch(
    "admin.py",
    '''            return None, base
        for cmd in posix_cmds or _DEFAULT_LAUNCH[1]:''',
    '''            # BH-FIX: only report "no process" when there is genuinely no profile,
            # otherwise cleanup would kill a browser we just launched.
            return (None, base) if base else None
        for cmd in posix_cmds or _DEFAULT_LAUNCH[1]:''',
    "Windows start fallback returns a usable launch",
    marker="# BH-FIX: only report",
)

# --- 5. make sure "no browser running" auto-launches instead of asking the user -----
# `_needs_chrome_remote_debugging_prompt` also matches our message, and it is checked
# BEFORE the auto-launch branch -> the harness asked the user to open
# chrome://inspect instead of launching the configured browser.
ok &= patch(
    "admin.py",
    '''        if local and not opened_inspect and _needs_chrome_remote_debugging_prompt(msg):''',
    '''        if local and not opened_inspect and not _chrome_not_running(msg) and _needs_chrome_remote_debugging_prompt(msg):''',
    "auto-launch wins over the chrome://inspect prompt",
    marker="not _chrome_not_running(msg) and _needs_chrome_remote_debugging_prompt",
)

# --- 6. make the failure message actionable when nothing is listening ------------
ok &= patch(
    "daemon.py",
    '''    raise RuntimeError(
        f"DevToolsActivePort not found in {[str(p) for p in PROFILES]} — "
        "no CDP browser is listening. Fixes: (a) set BH_CHROME_PATH to a Chromium binary and "
        "BH_CHROME_ARGS='--remote-debugging-port=9222' so the harness can launch one, "
        "(b) set BH_CHROME_USER_DATA_DIR to the automation profile so it is polled, or "
        "(c) point BU_CDP_URL at an already-running browser. "
        "On Windows, also confirm the browser is not running inside a file-staging sandbox "
        "(a staged profile both breaks the browser and locks the staging tree)."
    )''',
    '''    raise RuntimeError(
        "chrome-not-running: no CDP browser is listening and none was found in "
        f"{[str(p) for p in PROFILES]}. Set BH_CHROME_PATH to a Chromium binary plus "
        "BH_CHROME_ARGS='--remote-debugging-port=9222' so the harness can auto-launch one, "
        "set BH_CHROME_USER_DATA_DIR to the automation profile so it is polled, or point "
        "BU_CDP_URL at an already-running browser. On Windows, also confirm the browser is "
        "not running inside a file-staging sandbox (a staged profile both breaks the browser "
        "and locks the staging tree with EBUSY)."
    )''',
    "chrome-not-running marker triggers auto-launch + actionable text",
    marker="chrome-not-running: no CDP browser is listening",
)

print("RESULT:", "ALL APPLIED" if ok else "PARTIAL — see failures above")
sys.exit(0 if ok else 1)
