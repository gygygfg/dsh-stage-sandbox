#!/usr/bin/env bash
# dshnt M0 host runner: create a disposable Windows 10 VM, inject the OEM
# first-logon script, wait for RESULT_M0.json, and keep the VM for inspection.
#
# ⚠ M0 RESULT (2026-11-22): the first-attempt m0-phase1.ps1 hangs in
# dotnet-install inside the guest. The successful path (cross-built provider +
# VS DriverKit component + pnputil + fltmc attach) is documented in
# ../../docs/nt/M0-REPORT.md §3. Treat this runner as a record, not a
# one-command reproducible path, until phase1-v2 lands.
#
# Usage:
#   ./run-host.sh [--iso PATH] [--run-id m0] [--web-port 8077] [--timeout-min 180] [--cleanup]
#
# Requires: docker, /dev/kvm, /dev/net/tun, an Windows 10/11 ISO, and the ebk
# compose skill. Linux host only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_WIN="$(cd "$HERE/../.." && pwd)"
WORK="${DSHNT_M0_WORK:-/srv/ebk/dshnt-m0}"
ISO="${DSHNT_M0_ISO:-/mnt/f6c8858d-4d92-4d0b-bf2f-e485fa194660/system_images/Win10_22H2_Chinese_Simplified_x64v1.iso}"
RUN_ID="m0"
WEB_PORT="8077"
TIMEOUT_MIN="180"
CLEANUP="0"
COMPOSE_SKILL="${EBK_COMPOSE_SKILL:-/root/.config/opencode/skills/ebk-compose/scripts/ebk-compose.mjs}"

while [ $# -gt 0 ]; do
  case "$1" in
    --iso) ISO="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="$2"; shift 2 ;;
    --cleanup) CLEANUP="1"; shift ;;
    --work) WORK="$2"; shift 2 ;;
    --help|-h) sed -n '1,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SHARED="$WORK/shared"
OEM="$WORK/oem"
STORAGE="$WORK/storage"
COMPOSE_DIR="$WORK/compose"
COMPOSE="$COMPOSE_DIR/docker-compose.yml"
LOG="$SHARED/host-run.log"

mkdir -p "$SHARED" "$OEM" "$STORAGE" "$COMPOSE_DIR"
: > "$LOG"
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }

if [ ! -f "$ISO" ]; then
  log "FATAL ISO not found: $ISO"
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  log "FATAL docker daemon unavailable"
  exit 2
fi
if [ ! -e /dev/kvm ]; then
  log "FATAL /dev/kvm missing"
  exit 2
fi

log "work=$WORK iso=$ISO run=$RUN_ID web=$WEB_PORT"
# cmd.exe/PowerShell 5.1 are happiest with CRLF; normalize the guest scripts.
copy_crlf() { sed 's/\r$//' "$1" | sed 's/$/\r/' > "$2"; }
copy_crlf "$HERE/guest/m0-phase1.ps1" "$SHARED/m0-phase1.ps1"
copy_crlf "$HERE/guest/m0-phase2.ps1" "$SHARED/m0-phase2.ps1"
cp -f "$HERE/guest/m0-client.c" "$SHARED/m0-client.c"
copy_crlf "$HERE/guest/install.bat" "$OEM/install.bat"
chmod -R a+rX "$SHARED" "$OEM"

if [ ! -f "$COMPOSE" ]; then
  log "generating compose"
  node "$COMPOSE_SKILL" \
    --os-id win10 --run-id "$RUN_ID" \
    --ram 6G --cpu 4 --disk 100G \
    --test-dir "$SHARED" --oem-dir "$OEM" --storage "$STORAGE" \
    --web-port "$WEB_PORT" --rdp-port 3391 \
    --username Docker --password admin --language zh-CN \
    --out "$COMPOSE" | tee -a "$LOG"
fi

# dockur/windows prioritizes storage/custom.iso over the network download.
if [ ! -f "$STORAGE/custom.iso" ]; then
  log "seeding custom.iso (hardlink or copy)"
  ln "$ISO" "$STORAGE/custom.iso" 2>/dev/null || cp --reflink=auto "$ISO" "$STORAGE/custom.iso"
fi

log "starting VM (container win10-$RUN_ID)"
docker compose -p "dshnt-$RUN_ID" -f "$COMPOSE" up -d 2>&1 | tee -a "$LOG"

deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
announced=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -f "$SHARED/RESULT_M0.json" ]; then
    log "RESULT_M0.json arrived"
    cat "$SHARED/RESULT_M0.json" | tee -a "$LOG"
    if [ "$CLEANUP" = "1" ]; then
      log "cleanup requested"
      docker compose -p "dshnt-$RUN_ID" -f "$COMPOSE" down -v --remove-orphans 2>&1 | tee -a "$LOG" || true
    else
      log "keeping VM: http://127.0.0.1:$WEB_PORT/ (container win10-$RUN_ID)"
    fi
    if grep -Eq '"ok"[[:space:]]*:[[:space:]]*false' "$SHARED/RESULT_M0.json"; then
      log "M0 FAILED (ok=false)"
      exit 1
    fi
    log "M0 PASSED (ok=true)"
    exit 0
  fi
  now=$(date +%s)
  if [ $((now % 300)) -lt 30 ] && [ "$announced" != "$now" ]; then
    announced="$now"
    log "--- phase1 tail ---"
    tail -n 4 "$SHARED/m0-phase1.log" 2>/dev/null | tee -a "$LOG" || true
    tail -n 4 "$SHARED/m0-phase2.log" 2>/dev/null | tee -a "$LOG" || true
  fi
  sleep 30
done

log "TIMEOUT after ${TIMEOUT_MIN}m"
log "--- phase1 tail ---"
tail -n 80 "$SHARED/m0-phase1.log" 2>/dev/null | tee -a "$LOG" || true
log "--- phase2 tail ---"
tail -n 80 "$SHARED/m0-phase2.log" 2>/dev/null | tee -a "$LOG" || true
log "--- docker logs tail ---"
docker logs --tail 80 "win10-$RUN_ID" 2>&1 | tee -a "$LOG" || true
exit 1
