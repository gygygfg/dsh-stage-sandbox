#!/usr/bin/env bash
# In-container test runner for dsh-sandbox-linux.
#
# Runs the full suite against the bind-mounted working tree:
#   1. typecheck           (tsc --noEmit)
#   2. unit tests          (vitest, all spec files)
#   3. boot smoke          (mount provider + control service on Cordis)
#   4. dry-run/commit e2e  (real bwrap confinement, CAS publish)
#   5. runtime conformance (minimal root/masking, network, seccomp,
#                           overlay delta, selective publish, resident, cgroup)
#   6. security conformance (host secrets, namespace/seccomp escapes, device
#                           access, orchestrator sockets, network, resource,
#                           destructive-staging containment)
#
# Every stage runs even if an earlier one fails, so the report is complete.
# Writes RESULT_<runId>.json plus per-stage logs to $ARTIFACTS_DIR and exits
# non-zero when any required stage fails.
set -uo pipefail

REPO="${REPO_DIR:-/root/code/dsh-sandbox-linux}"
RUN_ID="${SANDBOX_RUN_ID:-container}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/ebk/container-artifacts}"
LOG_DIR="$ARTIFACTS_DIR/logs"
mkdir -p "$LOG_DIR"

cd "$REPO" || { echo "missing repo dir: $REPO" >&2; exit 2; }

STAGES=()
STATUSES=()
DETAILS=()

run_stage() {
  local name="$1" required="$2" desc="$3"
  shift 3
  local log="$LOG_DIR/${name}.log"
  printf '\n\033[1;36m===== [%s] %s =====\033[0m\n' "$name" "$desc"
  "$@" 2>&1 | tee "$log"
  local code=${PIPESTATUS[0]}
  STAGES+=("$name")
  DETAILS+=("exit=$code")
  if [ "$code" -eq 0 ]; then
    STATUSES+=("pass")
    printf '\033[1;32m[PASS]\033[0m %s\n' "$name"
  elif [ "$required" = "optional" ]; then
    STATUSES+=("skip")
    printf '\033[1;33m[SKIP]\033[0m %s (exit=%s)\n' "$name" "$code"
  else
    STATUSES+=("fail")
    printf '\033[1;31m[FAIL]\033[0m %s (exit=%s)\n' "$name" "$code"
  fi
  return 0
}

run_stage typecheck required "TypeScript typecheck (tsc --noEmit)" \
  bash -lc './node_modules/.bin/tsc --noEmit -p tsconfig.json'
run_stage unit-tests required "Vitest unit suite (tests/**/*.spec.ts)" \
  bash -lc './node_modules/.bin/vitest run'
run_stage smoke required "Boot smoke (provider + control service)" \
  bash -lc './node_modules/.bin/tsx scripts/smoke.ts'
run_stage e2e required "Dry-run / commit e2e through bwrap" \
  bash -lc './node_modules/.bin/tsx scripts/e2e.ts'
run_stage runtime-conformance required "Hardened runtime conformance" \
  bash -lc './node_modules/.bin/tsx scripts/runtime-conformance.ts'
run_stage security-conformance required "Sandbox escape / dangerous-command conformance" \
  bash -lc './node_modules/.bin/tsx scripts/security-conformance.ts'

# Build the result marker.
failed=0
entries=""
for i in "${!STAGES[@]}"; do
  [ "${STATUSES[$i]}" = "fail" ] && failed=1
  [ -n "$entries" ] && entries+=","
  entries+="{\"name\":\"${STAGES[$i]}\",\"status\":\"${STATUSES[$i]}\",\"detail\":\"${DETAILS[$i]}\"}"
done

overall=$([ "$failed" -eq 0 ] && echo pass || echo fail)
result="$ARTIFACTS_DIR/RESULT_${RUN_ID}.json"
printf '{"runId":"%s","platform":"linux-container","node":"%s","overall":"%s","stages":[%s]}\n' \
  "$RUN_ID" "$(node --version)" "$overall" "$entries" > "$result"

printf '\n\033[1m===== SUMMARY =====\033[0m\n'
printf '%-22s %s\n' "STAGE" "STATUS"
for i in "${!STAGES[@]}"; do printf '%-22s %s\n' "${STAGES[$i]}" "${STATUSES[$i]}"; done
printf '\nresult marker: %s\n' "$result"
printf 'overall: %s\n' "$overall"

[ "$failed" -eq 0 ]
