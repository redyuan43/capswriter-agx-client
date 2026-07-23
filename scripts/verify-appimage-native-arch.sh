#!/usr/bin/env bash
set -euo pipefail

case "$(uname -m)" in
  x86_64) expected_machine='Advanced Micro Devices X86-64' ;;
  aarch64) expected_machine='AArch64' ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

appimage="$(find "dist" -maxdepth 1 -type f -name 'CapsWriter-GUI-*-linux-*.AppImage' -print -quit)"
test -n "$appimage"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

(
  cd "$workdir"
  "$OLDPWD/$appimage" --appimage-extract >/dev/null
)

native_module="$(find "$workdir/squashfs-root/resources/app.asar.unpacked/node_modules/uiohook-napi/build/Release" -type f -name '*.node' -print -quit)"
test -n "$native_module"
readelf -h "$native_module" | grep -F 'Machine:' | grep -Fq "$expected_machine"
printf 'Verified packaged %s uiohook native module: %s\n' "$expected_machine" "$native_module"
