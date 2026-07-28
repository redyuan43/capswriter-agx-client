#!/usr/bin/env bash
set -euo pipefail

case "$(uname -m)" in
  x86_64)
    expected_machine='Advanced Micro Devices X86-64'
    artifact_arch='x86_64'
    ;;
  aarch64)
    expected_machine='AArch64'
    artifact_arch='arm64'
    ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

version="$(node -p "require('./package.json').version")"
appimage="dist/CapsWriter-GUI-${version}-linux-${artifact_arch}.AppImage"
test -f "$appimage"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

(
  cd "$workdir"
  "$OLDPWD/$appimage" --appimage-extract >/dev/null
)

verify_native_module() {
  module_name="$1"
  search_root="$2"
  native_module="$(find "$search_root" -type f -name '*.node' -print -quit)"
  test -n "$native_module"
  readelf -h "$native_module" | grep -F 'Machine:' | grep -Fq "$expected_machine"
  printf 'Verified packaged %s %s native module: %s\n' \
    "$expected_machine" "$module_name" "$native_module"
}

verify_native_module \
  uiohook \
  "$workdir/squashfs-root/resources/app.asar.unpacked/node_modules/uiohook-napi/build/Release"
verify_native_module \
  better-sqlite3 \
  "$workdir/squashfs-root/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"
