#!/bin/sh
# Linux sandbox-backend conformance test.
#
# Verifies the mechanisms the plugin's Linux backend relies on: bubblewrap's
# read-only root / private PID / writable workspace bind, and the Landlock
# launcher. Intended to run inside a Linux VM where the kernel is unconstrained.
# Writes RESULT_<runId>.json to the shared 9p mount and to /tmp.
set -u

RUN_ID="${SANDBOX_RUN_ID:-linux}"
OUT="/tmp/RESULT_${RUN_ID}.json"
FAILS=""

record() {
    # $1 name, $2 pass(0/1), $3 detail
    if [ "$2" -eq 0 ]; then state=pass; else state=fail; FAILS="$FAILS $1"; fi
    printf '{"name":"%s","passed":%s,"detail":"%s"}\n' "$1" "$([ "$2" -eq 0 ] && echo true || echo false)" "$3"
}

results=""
add() { results="$results$1
"; }

# 1. bwrap present and can create the read-only profile.
if command -v bwrap >/dev/null 2>&1; then
    if bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true 2>/dev/null; then
        add "$(record bwrap-available 0 'bwrap ran the read-only profile')"
    else
        add "$(record bwrap-available 1 'bwrap profile failed')"
    fi
else
    add "$(record bwrap-available 1 'bwrap not installed')"
fi

# 2. read-only root denies a write outside the workspace.
if command -v bwrap >/dev/null 2>&1; then
    if bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- sh -c 'echo x > /opt/ebk-deny 2>/dev/null'; then
        add "$(record readonly-root-denies-write 1 'write to read-only root unexpectedly succeeded')"
    else
        add "$(record readonly-root-denies-write 0 'write to read-only root was denied')"
    fi
fi

# 3. workspace bind is writable.
WS="$(mktemp -d)"
if bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --bind "$WS" "$WS" -- sh -c "echo ok > '$WS/probe'"; then
    if [ -f "$WS/probe" ]; then add "$(record workspace-bind-writable 0 'workspace bind is writable')"; else add "$(record workspace-bind-writable 1 'probe file missing')"; fi
else
    add "$(record workspace-bind-writable 1 'bwrap workspace-write run failed')"
fi

# 4. PID namespace hides host processes.
if command -v bwrap >/dev/null 2>&1; then
    count="$(bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- sh -c 'ls /proc | grep -c "^[0-9]*$"' 2>/dev/null || echo 0)"
    if [ "$count" -le 5 ]; then add "$(record private-pid-namespace 0 "visible pids=$count")"; else add "$(record private-pid-namespace 1 "visible pids=$count")"; fi
fi

# 5. Landlock launcher available (optional rung).
if command -v landlock-run >/dev/null 2>&1; then
    add "$(record landlock-launcher 0 'landlock-run present')"
else
    add "$(record landlock-launcher 1 'landlock-run absent (bwrap rung selected)')"
fi

json="$(printf '{"runId":"%s","platform":"linux","kernel":"%s","results":[%s],"failures":"%s","passed":%s}' \
    "$RUN_ID" "$(uname -r)" "$(printf '%s' "$results" | tr -d '\n' | sed 's/,$//')" "$FAILS" "$([ -z "$FAILS" ] && echo true || echo false)")"
printf '%s\n' "$json" > "$OUT"

# Try to reach the shared 9p mount (tag "shared") and copy the result there.
mkdir -p /mnt/shared 2>/dev/null || true
mount -t 9p -o trans=virtio shared /mnt/shared 2>/dev/null || true
cp "$OUT" "/mnt/shared/RESULT_${RUN_ID}.json" 2>/dev/null || true
printf '%s\n' "$json"
