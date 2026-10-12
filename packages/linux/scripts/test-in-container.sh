#!/usr/bin/env bash
# Run the full dsh-sandbox-linux test suite inside a Docker container.
#
# The container is the isolation boundary: bubblewrap, overlayfs, seccomp and
# cgroup v2 all run against a clean Debian userland, independent of the
# developer host. The plugin tree and the harness it imports are bind-mounted,
# so the current working tree is what gets tested.
#
# Usage:
#   scripts/test-in-container.sh [--build] [--keep] [--image TAG]
#                                [--harness DIR] [--run-id ID]
#
# Environment overrides: IMAGE, HARNESS_DIR, ARTIFACTS_DIR, RUN_ID, DOCKER.
#
# Pipeline (mirrors ebk's probe -> up -> test -> collect -> down):
#   probe host -> (build image) -> start container -> run stages -> collect -> down
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_DIR="${HARNESS_DIR:-/root/deepseek-harness}"
IMAGE="${IMAGE:-dsh-sandbox-test:latest}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/ebk/container-artifacts}"
RUN_ID="${RUN_ID:-container}"
DOCKER="${DOCKER:-docker}"
EBK_ENV_SCRIPT="${EBK_ENV_SCRIPT:-$HOME/.config/opencode/skills/ebk-environment/scripts/ebk-env.mjs}"

BUILD=0
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --keep) KEEP=1 ;;
    --image) IMAGE="$2"; shift ;;
    --harness) HARNESS_DIR="$2"; shift ;;
    --run-id) RUN_ID="$2"; shift ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

CONTAINER="sandbox-test-${RUN_ID}"

fail() { echo "error: $*" >&2; exit 1; }

# --- probe host -------------------------------------------------------------
command -v "$DOCKER" >/dev/null 2>&1 || fail "docker not found"
"$DOCKER" info >/dev/null 2>&1 || fail "docker daemon not reachable"
[ -d "$HARNESS_DIR" ] || fail "harness dir not found: $HARNESS_DIR (set HARNESS_DIR)"
[ -f "$REPO/package.json" ] || fail "not a dsh-sandbox-linux checkout: $REPO"
if [ -f "$EBK_ENV_SCRIPT" ]; then
  echo "== ebk probe =="
  node "$EBK_ENV_SCRIPT" probe || true
fi

# --- build image ------------------------------------------------------------
if [ "$BUILD" -eq 1 ] || ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "== building image $IMAGE =="
  "$DOCKER" build -t "$IMAGE" "$REPO/scripts/container" || fail "image build failed"
fi

mkdir -p "$ARTIFACTS_DIR/logs"
"$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || true

# --- run stages -------------------------------------------------------------
# --privileged: bubblewrap user/mount/net namespaces + overlay mount.
# --cgroupns=host: lets the cgroup v2 domain write memory.max.
# TMPDIR=/dev/shm (tmpfs): overlayfs cannot be nested on the container's
# overlay root, but a tmpfs lower/upper works.
echo "== running full suite in $CONTAINER =="
"$DOCKER" run --name "$CONTAINER" \
  --privileged \
  --cgroupns=host \
  --shm-size 1g \
  -e TMPDIR=/dev/shm \
  -e REPO_DIR="$REPO" \
  -e ARTIFACTS_DIR="$ARTIFACTS_DIR" \
  -e SANDBOX_RUN_ID="$RUN_ID" \
  -v "$HARNESS_DIR:$HARNESS_DIR:ro" \
  -v "$REPO:$REPO" \
  "$IMAGE" \
  bash "$REPO/scripts/container/run-tests.sh"
CODE=$?

# --- collect ----------------------------------------------------------------
if [ -f "$EBK_ENV_SCRIPT" ]; then
  echo "== collecting artifacts (ebk) =="
  node "$EBK_ENV_SCRIPT" collect --container "$CONTAINER" \
    --test-dir "$ARTIFACTS_DIR" --artifacts-dir "$ARTIFACTS_DIR" || true
fi
"$DOCKER" logs "$CONTAINER" > "$ARTIFACTS_DIR/logs/container.log" 2>&1 || true

# --- down -------------------------------------------------------------------
if [ "$KEEP" -eq 1 ]; then
  echo "kept container: $CONTAINER"
else
  "$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

echo "artifacts: $ARTIFACTS_DIR"
exit "$CODE"
