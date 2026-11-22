#!/usr/bin/env bash
# Cross-build the dshnt ProjFS provider (self-contained win-x64) on Linux with
# the .NET SDK container. Output: native/provider/out/ (copy to the Windows box).
#
#   ./build.sh [--sdk 8.0] [--out /path/to/out]
#
# The guest never installs the .NET SDK: M0 showed the .NET CDN hanging inside
# the VM, and the provider is fully cross-compilable.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="8.0"
OUT="$HERE/out"

while [ $# -gt 0 ]; do
  case "$1" in
    --sdk) SDK="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

TFM="net8.0-windows10.0.17763.0"
echo "publishing $TFM self-contained win-x64 (SDK $SDK)"
docker run --rm -v "$HERE:/src" -w /src "mcr.microsoft.com/dotnet/sdk:$SDK" \
  dotnet publish Dshnt.Provider.csproj -c Release -f "$TFM" -r win-x64 \
    --self-contained true -p:PublishSingleFile=false -o /src/out

echo "provider -> $OUT"
ls -l "$OUT" | head
