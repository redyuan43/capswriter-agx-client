#!/usr/bin/env bash
# 在 NX6 上部署一个新的 ARM64 AppImage。
#
# 为什么先等旧实例退出、再清理挂载：
#   2026-09-30 实测，用 SIGTERM/SIGKILL 粗暴结束旧实例会留下孤儿 chrome_crashpad_handler
#   与泄漏的 AppImage FUSE 挂载（/tmp/.mount_Caps*），随后新实例点「退出」会卡在
#   fuse_dev_release 上永不退出。这里按序处理：停服务 → 等进程真退出 → 清理孤儿与残留挂载
#   → 备份替换 → 启动。
#
# 用法:
#   scripts/deploy-nx6-appimage.sh <新 AppImage 路径> [备份标签]
#   scripts/deploy-nx6-appimage.sh dist/CapsWriter-GUI-1.0.33-linux-arm64.AppImage bordeaux-1033
#
# 依赖：bash、systemctl --user、pgrep/pkill、fusermount（可选）。脚本以 NX6 上的普通用户运行。
set -euo pipefail

APPIMAGE_SRC="${1:-}"
LABEL="${2:-appimage}"
if [ -z "$APPIMAGE_SRC" ]; then
  echo "用法: $0 <新 AppImage 路径> [备份标签]" >&2
  exit 2
fi
if [ ! -f "$APPIMAGE_SRC" ]; then
  echo "找不到 AppImage: $APPIMAGE_SRC" >&2
  exit 2
fi

# 通过 ssh 调用时必须显式给出用户会话总线，否则 systemctl --user 直接失败。
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

INSTALL_DIR="$HOME/.local/opt/capswriter-agx-client"
APPIMAGE="$INSTALL_DIR/CapsWriter-GUI.AppImage"
SERVICE="capswriter-agx-client.service"
CLIENT_PATTERN="CapsWriter-GUI[.]AppImage"
EXIT_WAIT_SECONDS="${EXIT_WAIT_SECONDS:-15}"
BACKUP_DIR="$HOME/.local/share/capswriter-backups/$(date +%Y%m%d-%H%M%S)-${LABEL}"

client_pids() {
  pgrep -f "$CLIENT_PATTERN" 2>/dev/null || true
}

echo "== 1/6 停止服务并等待旧实例退出（最多 ${EXIT_WAIT_SECONDS}s）"
systemctl --user stop "$SERVICE" >/dev/null 2>&1 || true
for _ in $(seq 1 "$EXIT_WAIT_SECONDS"); do
  [ -z "$(client_pids)" ] && break
  sleep 1
done
ORPHANS_LEFT="$(pgrep -f "/tmp/\.mount_Caps[^ ]*/chrome_crashpad_handler" 2>/dev/null || true)"
if [ -n "$ORPHANS_LEFT" ]; then
  echo "   退出超时，结束残留进程: $ORPHANS_LEFT"
  # shellcheck disable=SC2086
  kill -KILL $ORPHANS_LEFT 2>/dev/null || true
fi
REMAINING="$(client_pids)"
if [ -n "$REMAINING" ]; then
  echo "   旧实例仍在（可能是 FUSE 收尾卡死），SIGKILL: $REMAINING"
  # shellcheck disable=SC2086
  kill -KILL $REMAINING 2>/dev/null || true
  sleep 2
fi

echo "== 2/6 清理该客户端的孤儿 crashpad 与残留 AppImage 挂载"
LEFT_CRASHPAD="$(pgrep -f "/tmp/\.mount_Caps[^ ]*/chrome_crashpad_handler" 2>/dev/null || true)"
if [ -n "$LEFT_CRASHPAD" ]; then
  # shellcheck disable=SC2086
  kill -TERM $LEFT_CRASHPAD 2>/dev/null || true
  sleep 2
  # shellcheck disable=SC2086
  kill -KILL $LEFT_CRASHPAD 2>/dev/null || true
fi
for mount_point in $(mount | sed -n 's/.* on \(\/tmp\/\.mount_Caps[^ ]*\) type.*/\1/p'); do
  fusermount -u "$mount_point" 2>/dev/null || fusermount3 -u "$mount_point" 2>/dev/null \
    || umount "$mount_point" 2>/dev/null || echo "   挂载未能卸载（可稍后重试）: $mount_point"
done

echo "== 3/6 备份现有安装"
mkdir -p "$BACKUP_DIR"
if [ -f "$APPIMAGE" ]; then
  cp -a "$APPIMAGE" "$BACKUP_DIR/CapsWriter-GUI.AppImage"
  sha256sum "$BACKUP_DIR/CapsWriter-GUI.AppImage" > "$BACKUP_DIR/previous-appimage.sha256"
fi
sha256sum "$APPIMAGE_SRC" > "$BACKUP_DIR/new-appimage.sha256"
cat "$BACKUP_DIR/new-appimage.sha256"

echo "== 4/6 替换安装"
install -m 0755 "$APPIMAGE_SRC" "$APPIMAGE.new"
mv -f "$APPIMAGE.new" "$APPIMAGE"

echo "== 5/6 刷新桌面图标与 autostart 图标引用"
ASSETS_DIR="$(cd "$(dirname "$APPIMAGE_SRC")/.." && pwd)/assets"
if [ -f "$ASSETS_DIR/tray-icon.png" ]; then
  mkdir -p "$HOME/.local/share/icons/hicolor/64x64/apps"
  install -m 0644 "$ASSETS_DIR/tray-icon.png" \
    "$HOME/.local/share/icons/hicolor/64x64/apps/capswriter-agx-client.png"
fi
if [ -f "$HOME/.config/autostart/capswriter-agx-client.desktop" ]; then
  sed -i 's|^Icon=.*|Icon=capswriter-agx-client|' "$HOME/.config/autostart/capswriter-agx-client.desktop"
fi

echo "== 6/6 启动并校验"
systemctl --user reset-failed "$SERVICE" >/dev/null 2>&1 || true
systemctl --user start "$SERVICE"
for _ in $(seq 1 15); do
  [ -n "$(client_pids)" ] && break
  sleep 1
done
echo "   服务状态: $(systemctl --user is-active "$SERVICE")"
echo "   运行进程: $(client_pids | tr '\n' ' ')"
echo "   已安装包: $(sha256sum "$APPIMAGE" | cut -d' ' -f1)"
echo "   备份目录: $BACKUP_DIR"
