#!/usr/bin/env bash
# Build a self-contained Windows x64 SimpleProviderManaged (ProjFS) on Linux
# with the .NET SDK container, then copy the publish output to the M0 share.
#
# Why: installing the .NET SDK inside the Windows guest hung on the .NET CDN;
# the ProjFS managed API is cross-compilation friendly, so build it on the host.
#
# Usage: ./build-provider.sh [--work /srv/ebk/dshnt-m0] [--sdk 8.0]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${DSHNT_M0_WORK:-/srv/ebk/dshnt-m0}"
SDK="${DSHNT_M0_DOTNET_SDK:-8.0}"
SRC="${DSHNT_M0_PROJFS_SRC:-/tmp/opencode/projfs-src/ProjFS-Managed-API-main}"
TFM="net8.0-windows10.0.17763.0"

while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK="$2"; shift 2 ;;
    --sdk) SDK="$2"; shift 2 ;;
    --src) SRC="$2"; shift 2 ;;
    --help|-h) sed -n '1,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$SRC/simpleProviderManaged" ]; then
  mkdir -p "$(dirname "$SRC")"
  echo "downloading ProjFS-Managed-API to $SRC"
  curl -L --max-time 180 -sS https://github.com/microsoft/ProjFS-Managed-API/archive/refs/heads/main.zip -o "$SRC.zip"
  rm -rf "$SRC"
  unzip -q "$SRC.zip" -d "$(dirname "$SRC")"
  # zip extracts to ProjFS-Managed-API-main
  if [ -d "$(dirname "$SRC")/ProjFS-Managed-API-main" ]; then
    mv "$(dirname "$SRC")/ProjFS-Managed-API-main" "$SRC"
  fi
fi

# The upstream repo requires .NET 10 and targets net9/net10; the spike only
# needs the net8.0 target. Patch the temp source (never the repo) so SDK 8 works.
rm -f "$SRC/global.json"
sed -i 's#<TargetFrameworks>net48;net8.0-windows10.0.17763.0;net10.0-windows10.0.17763.0</TargetFrameworks>#<TargetFrameworks>net8.0-windows10.0.17763.0</TargetFrameworks>#' "$SRC/simpleProviderManaged/SimpleProviderManaged.csproj"
sed -i 's#<TargetFrameworks>netstandard2.0;net8.0;net9.0;net10.0</TargetFrameworks>#<TargetFrameworks>net8.0</TargetFrameworks>#' "$SRC/ProjectedFSLib.Managed/ProjectedFSLib.Managed.csproj"

echo "building $TFM self-contained win-x64 with .NET SDK $SDK"
docker run --rm \
  -v "$SRC:/src" \
  -w /src/simpleProviderManaged \
  "mcr.microsoft.com/dotnet/sdk:$SDK" \
  dotnet publish -c Release -f "$TFM" -r win-x64 --self-contained true \
    -p:EnableWindowsTargeting=true -p:PublishSingleFile=false \
    -o /src/out-win

mkdir -p "$WORK/shared/projfs-provider"
rm -rf "$WORK/shared/projfs-provider"/*
cp -a "$SRC/out-win/." "$WORK/shared/projfs-provider/"
echo "provider -> $WORK/shared/projfs-provider"
ls -l "$WORK/shared/projfs-provider" | head
