#!/usr/bin/env bash
set -euo pipefail

# This template is rendered with the release tag before it is uploaded to GitHub.
REPOSITORY="redyuan43/capswriter-agx-client"
RELEASE_TAG="@RELEASE_TAG@"
INSTALL_DIR="${HOME}/.local/opt/capswriter-agx-client"
BIN_DIR="${HOME}/.local/bin"
APPLICATIONS_DIR="${HOME}/.local/share/applications"
AUTOSTART_DIR="${HOME}/.config/autostart"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
ICONS_DIR="${HOME}/.local/share/icons/hicolor/64x64/apps"
ICON_NAME="capswriter-agx-client.png"
ICON_ID="capswriter-agx-client"
AUTO_START=1
LAUNCH_NOW=1
CONFIGURE_INPUT_PERMISSION=1
CONFIGURE_BLUETOOTH_RECOVERY_PERMISSION=1
MINIJOY_UDEV_RULE_NAME="70-capswriter-minijoy-input.rules"
MINIJOY_UDEV_RULE_PATH="/etc/udev/rules.d/${MINIJOY_UDEV_RULE_NAME}"
M5_RECOVERY_HELPER_NAME="capswriter-m5-recover-bluetooth"
M5_RECOVERY_HELPER_PATH="/usr/libexec/${M5_RECOVERY_HELPER_NAME}"
M5_RECOVERY_POLICY_NAME="com.speechtranscription.m5-recover.policy"
M5_RECOVERY_RULE_NAME="49-capswriter-m5-recover.rules"
M5_DOCTOR_NAME="m5bridge-doctor.py"
SERVICE_NAME="capswriter-agx-client.service"

usage() {
  cat <<'EOF'
Usage: install-capswriter-agx-client.sh [options]

Installs the matching CapsWriter AGX Client AppImage for the current CPU,
registers desktop login autostart, and starts it in tray/background mode.

Options:
  --install-dir PATH  Install AppImage under PATH.
  --no-autostart      Do not create the desktop-login autostart entry.
  --no-launch         Do not start the client after installation.
  --skip-input-permission
                      Do not install the MiniJoy input-device access rule.
  --skip-bluetooth-recovery-permission
                      Do not install the restricted Bluetooth recovery helper.
  -h, --help          Show this help message.
EOF
}

report_runtime_dependencies() {
  local missing_tools=()

  for tool in wtype ydotool ydotoold; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing_tools+=("$tool")
    fi
  done

  if [ "${#missing_tools[@]}" -eq 0 ]; then
    echo "Wayland auto-paste tools detected (wtype and ydotool)."
  else
    echo "Warning: automatic paste needs the following tools: ${missing_tools[*]}." >&2
    echo "Install the distribution packages for wtype and ydotool, then log out and back in if prompted." >&2
    echo "Dictation remains available; recognized text will stay in the clipboard until auto-paste is available." >&2
  fi

  if ! command -v pactl >/dev/null 2>&1; then
    echo "Note: pactl is unavailable. CapsWriter will use Electron's default microphone capture on Linux." >&2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="${2:?missing value for --install-dir}"
      shift 2
      ;;
    --no-autostart)
      AUTO_START=0
      shift
      ;;
    --no-launch)
      LAUNCH_NOW=0
      shift
      ;;
    --skip-input-permission)
      CONFIGURE_INPUT_PERMISSION=0
      shift
      ;;
    --skip-bluetooth-recovery-permission)
      CONFIGURE_BLUETOOTH_RECOVERY_PERMISSION=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

configure_minijoy_input_permission() {
  if [ "$CONFIGURE_INPUT_PERMISSION" -ne 1 ]; then
    return
  fi

  if ! command -v udevadm >/dev/null 2>&1; then
    echo "Warning: udevadm is unavailable; MiniJoy trackball input permission was not configured." >&2
    echo "Re-run this installer on a systemd/udev Linux desktop, or use --skip-input-permission." >&2
    return
  fi

  local rule_file="${TEMP_DIR}/${MINIJOY_UDEV_RULE_NAME}"
  cat > "$rule_file" <<'EOF'
# Allow the active graphical user to read keyboard events and the MiniJoy mouse event device.
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_KEYBOARD}=="1", TAG+="uaccess"
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{name}=="VibeStick MiniJoy Mouse", TAG+="uaccess"
# Allow the CapsWriter device mapper to create virtual keyboard events.
KERNEL=="uinput", TAG+="uaccess"
# Keep the verified LiQi raw HID interface address stable across reboots.
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="514c", ATTRS{idProduct}=="4155", SYMLINK+="knob-mapper-raw", TAG+="uaccess"
EOF

  echo "Configuring MiniJoy trackball input permission..."
  sudo install -m 0644 "$rule_file" "$MINIJOY_UDEV_RULE_PATH"
  sudo udevadm control --reload-rules
  sudo udevadm trigger --subsystem-match=input --sysname-match="event*" --action=change
  echo "MiniJoy input rule installed. Reconnect MiniJoy once if its current session does not pick up the new ACL."
}

configure_bluetooth_recovery_permission() {
  if [ "$CONFIGURE_BLUETOOTH_RECOVERY_PERMISSION" -ne 1 ]; then
    return
  fi
  if ! command -v pkexec >/dev/null 2>&1 || ! command -v systemctl >/dev/null 2>&1; then
    echo "Warning: Polkit/systemctl is unavailable; Bluetooth automatic recovery was not configured." >&2
    return
  fi
  echo "Configuring restricted MiniJoy Bluetooth recovery permission..."
  sudo install -D -m 0755 "$TEMP_DIR/$M5_RECOVERY_HELPER_NAME" "$M5_RECOVERY_HELPER_PATH"
  sudo install -D -m 0644 "$TEMP_DIR/$M5_RECOVERY_POLICY_NAME" "/usr/share/polkit-1/actions/$M5_RECOVERY_POLICY_NAME"
  sudo install -D -m 0644 "$TEMP_DIR/$M5_RECOVERY_RULE_NAME" "/etc/polkit-1/rules.d/$M5_RECOVERY_RULE_NAME"
  echo "Bluetooth recovery helper installed. It is limited to restarting bluetooth.service."
}

case "$(uname -m)" in
  x86_64|amd64)
    ARCH="x86_64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported Linux architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

VERSION="${RELEASE_TAG#v}"
VERSION="${VERSION%-agx-client}"
ASSET="CapsWriter-GUI-${VERSION}-linux-${ARCH}.AppImage"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required to download this private release." >&2
  echo "Install gh and run: gh auth login" >&2
  exit 1
fi

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

echo "Downloading ${ASSET} from ${REPOSITORY}@${RELEASE_TAG}..."
gh release download "$RELEASE_TAG" \
  --repo "$REPOSITORY" \
  --pattern "$ASSET" \
  --pattern "$ICON_NAME" \
  --pattern "$M5_DOCTOR_NAME" \
  --pattern "$M5_RECOVERY_HELPER_NAME" \
  --pattern "$M5_RECOVERY_POLICY_NAME" \
  --pattern "$M5_RECOVERY_RULE_NAME" \
  --pattern "SHA256SUMS.txt" \
  --dir "$TEMP_DIR"

verify_release_asset() {
  local asset="$1"
  local expected actual
  expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' "$TEMP_DIR/SHA256SUMS.txt")"
  if [ -z "$expected" ]; then
    echo "Checksum for ${asset} was not found in SHA256SUMS.txt." >&2
    exit 1
  fi
  actual="$(sha256sum "$TEMP_DIR/$asset" | awk '{ print $1 }')"
  if [ "$actual" != "$expected" ]; then
    echo "Checksum verification failed for ${asset}." >&2
    exit 1
  fi
}

verify_release_asset "$ASSET"
verify_release_asset "$ICON_NAME"
verify_release_asset "$M5_DOCTOR_NAME"
verify_release_asset "$M5_RECOVERY_HELPER_NAME"
verify_release_asset "$M5_RECOVERY_POLICY_NAME"
verify_release_asset "$M5_RECOVERY_RULE_NAME"

echo "Checksums verified."

report_runtime_dependencies
configure_minijoy_input_permission
configure_bluetooth_recovery_permission

# Replace a previous AppImage instance before its on-disk payload is updated.
systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
mapfile -t RUNNING_PIDS < <(pgrep -u "$(id -u)" -f 'CapsWriter-GUI.*\.AppImage' || true)
if [ "${#RUNNING_PIDS[@]}" -gt 0 ]; then
  echo "Stopping existing CapsWriter client: ${RUNNING_PIDS[*]}"
  kill -TERM "${RUNNING_PIDS[@]}" 2>/dev/null || true
  sleep 2
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$APPLICATIONS_DIR" "$AUTOSTART_DIR" "$ICONS_DIR" "$SYSTEMD_USER_DIR"
DOCTOR_DIR="${HOME}/.local/lib/capswriter-agx-client"
mkdir -p "$DOCTOR_DIR"
install -m 0755 "$TEMP_DIR/$M5_DOCTOR_NAME" "$DOCTOR_DIR/$M5_DOCTOR_NAME"
DOCTOR_LAUNCHER_PATH="${BIN_DIR}/m5bridge-doctor"
cat > "$DOCTOR_LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
exec python3 "$DOCTOR_DIR/$M5_DOCTOR_NAME" "\$@"
EOF
chmod 0755 "$DOCTOR_LAUNCHER_PATH"
APPIMAGE_PATH="${INSTALL_DIR}/CapsWriter-GUI.AppImage"
install -m 0755 "$TEMP_DIR/$ASSET" "${APPIMAGE_PATH}.new"
mv -f "${APPIMAGE_PATH}.new" "$APPIMAGE_PATH"
install -m 0644 "$TEMP_DIR/$ICON_NAME" "${ICONS_DIR}/${ICON_NAME}"

LAUNCHER_PATH="${BIN_DIR}/capswriter-agx-client"
printf '%s\n' '#!/usr/bin/env bash' > "$LAUNCHER_PATH"
printf '%s\n' 'set -euo pipefail' >> "$LAUNCHER_PATH"
printf 'APPIMAGE_PATH=%q\n' "$APPIMAGE_PATH" >> "$LAUNCHER_PATH"
printf '%s\n' 'LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/capswriter-agx-client"' >> "$LAUNCHER_PATH"
printf '%s\n' 'LOG_FILE="${LOG_DIR}/capswriter-agx-client.log"' >> "$LAUNCHER_PATH"
printf '%s\n' 'mkdir -p "$LOG_DIR"' >> "$LAUNCHER_PATH"
printf '%s\n' 'if pgrep -u "$(id -u)" -f "$APPIMAGE_PATH" >/dev/null 2>&1; then exit 0; fi' >> "$LAUNCHER_PATH"
printf '%s\n' 'export CAPS_LISTENER_BACKEND="${CAPS_LISTENER_BACKEND:-evdev}"' >> "$LAUNCHER_PATH"
printf '%s\n' 'exec "$APPIMAGE_PATH" --no-sandbox "$@" >>"$LOG_FILE" 2>&1' >> "$LAUNCHER_PATH"
chmod 0755 "$LAUNCHER_PATH"

SERVICE_STARTER_PATH="${BIN_DIR}/capswriter-agx-client-service-start"
cat > "$SERVICE_STARTER_PATH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
environment_names=()
for name in DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_RUNTIME_DIR; do
  if [ -n "${!name:-}" ]; then
    environment_names+=("$name")
  fi
done
if [ "${#environment_names[@]}" -gt 0 ]; then
  systemctl --user import-environment "${environment_names[@]}"
fi
systemctl --user start capswriter-agx-client.service
EOF
chmod 0755 "$SERVICE_STARTER_PATH"

SERVICE_PATH="${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=CapsWriter AGX Client
After=graphical-session.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${LAUNCHER_PATH}
Restart=on-failure
RestartSec=2
KillMode=control-group
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload

DESKTOP_ENTRY="${APPLICATIONS_DIR}/capswriter-agx-client.desktop"
cat > "$DESKTOP_ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=CapsWriter AGX Client
Comment=Speech transcription client
Exec=${SERVICE_STARTER_PATH}
Icon=${ICON_ID}
Terminal=false
Categories=AudioVideo;
StartupNotify=false
EOF

if [ "$AUTO_START" -eq 1 ]; then
  AUTOSTART_ENTRY="${AUTOSTART_DIR}/capswriter-agx-client.desktop"
  cat > "$AUTOSTART_ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=CapsWriter AGX Client
Comment=Start CapsWriter AGX Client on desktop login
Exec=${SERVICE_STARTER_PATH}
Icon=${ICON_ID}
Terminal=false
Categories=AudioVideo;
StartupNotify=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
EOF
else
  rm -f "${AUTOSTART_DIR}/capswriter-agx-client.desktop"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "${HOME}/.local/share/icons/hicolor" >/dev/null 2>&1 || true
fi

if [[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* || "${XDG_CURRENT_DESKTOP:-}" == *ubuntu* ]]; then
  ENABLED_EXTENSIONS="$(gnome-extensions list --enabled 2>/dev/null || true)"
  if ! grep -qi "appindicator" <<<"$ENABLED_EXTENSIONS"; then
    echo "Warning: GNOME AppIndicator support is not enabled."
    echo "CapsWriter will run, but its S tray icon may not be visible."
    echo "Install and enable your distribution's AppIndicator extension, then log in again."
  fi
fi

echo "Installed ${RELEASE_TAG} to ${APPIMAGE_PATH}."
if [ "$AUTO_START" -eq 1 ]; then
  echo "Desktop-login autostart is enabled."
fi

if [ "$LAUNCH_NOW" -eq 1 ]; then
  if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
    "$SERVICE_STARTER_PATH"
    echo "CapsWriter started under the systemd user service."
  else
    echo "No graphical session detected; CapsWriter will start at the next desktop login."
  fi
fi
