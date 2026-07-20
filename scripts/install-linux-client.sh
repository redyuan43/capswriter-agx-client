#!/usr/bin/env bash
set -euo pipefail

# This template is rendered with the release tag before it is uploaded to GitHub.
REPOSITORY="redyuan43/capswriter-agx-client"
RELEASE_TAG="@RELEASE_TAG@"
INSTALL_DIR="${HOME}/.local/opt/capswriter-agx-client"
BIN_DIR="${HOME}/.local/bin"
APPLICATIONS_DIR="${HOME}/.local/share/applications"
AUTOSTART_DIR="${HOME}/.config/autostart"
AUTO_START=1
LAUNCH_NOW=1

usage() {
  cat <<'EOF'
Usage: install-capswriter-agx-client.sh [options]

Installs the matching CapsWriter AGX Client AppImage for the current CPU,
registers desktop login autostart, and starts it in tray/background mode.

Options:
  --install-dir PATH  Install AppImage under PATH.
  --no-autostart      Do not create the desktop-login autostart entry.
  --no-launch         Do not start the client after installation.
  -h, --help          Show this help message.
EOF
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
  --pattern "SHA256SUMS.txt" \
  --dir "$TEMP_DIR"

EXPECTED_SHA256="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TEMP_DIR/SHA256SUMS.txt")"
if [ -z "$EXPECTED_SHA256" ]; then
  echo "Checksum for ${ASSET} was not found in SHA256SUMS.txt." >&2
  exit 1
fi

ACTUAL_SHA256="$(sha256sum "$TEMP_DIR/$ASSET" | awk '{ print $1 }')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "Checksum verification failed for ${ASSET}." >&2
  exit 1
fi

echo "Checksum verified."

# Replace a previous AppImage instance before its on-disk payload is updated.
mapfile -t RUNNING_PIDS < <(pgrep -u "$(id -u)" -f 'CapsWriter-GUI.*\.AppImage' || true)
if [ "${#RUNNING_PIDS[@]}" -gt 0 ]; then
  echo "Stopping existing CapsWriter client: ${RUNNING_PIDS[*]}"
  kill -TERM "${RUNNING_PIDS[@]}" 2>/dev/null || true
  sleep 2
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$APPLICATIONS_DIR" "$AUTOSTART_DIR"
APPIMAGE_PATH="${INSTALL_DIR}/CapsWriter-GUI.AppImage"
install -m 0755 "$TEMP_DIR/$ASSET" "${APPIMAGE_PATH}.new"
mv -f "${APPIMAGE_PATH}.new" "$APPIMAGE_PATH"

LAUNCHER_PATH="${BIN_DIR}/capswriter-agx-client"
printf '%s\n' '#!/usr/bin/env bash' > "$LAUNCHER_PATH"
printf '%s\n' 'set -euo pipefail' >> "$LAUNCHER_PATH"
printf 'APPIMAGE_PATH=%q\n' "$APPIMAGE_PATH" >> "$LAUNCHER_PATH"
printf '%s\n' 'LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/capswriter-agx-client"' >> "$LAUNCHER_PATH"
printf '%s\n' 'LOG_FILE="${LOG_DIR}/capswriter-agx-client.log"' >> "$LAUNCHER_PATH"
printf '%s\n' 'mkdir -p "$LOG_DIR"' >> "$LAUNCHER_PATH"
printf '%s\n' 'if pgrep -u "$(id -u)" -f "$APPIMAGE_PATH" >/dev/null 2>&1; then exit 0; fi' >> "$LAUNCHER_PATH"
printf '%s\n' 'exec "$APPIMAGE_PATH" --no-sandbox "$@" >>"$LOG_FILE" 2>&1' >> "$LAUNCHER_PATH"
chmod 0755 "$LAUNCHER_PATH"

DESKTOP_ENTRY="${APPLICATIONS_DIR}/capswriter-agx-client.desktop"
cat > "$DESKTOP_ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=CapsWriter AGX Client
Comment=Speech transcription client
Exec=${LAUNCHER_PATH}
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
Exec=${LAUNCHER_PATH}
Terminal=false
Categories=AudioVideo;
StartupNotify=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
EOF
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
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
    nohup "$LAUNCHER_PATH" >/dev/null 2>&1 &
    echo "CapsWriter started in background mode."
  else
    echo "No graphical session detected; CapsWriter will start at the next desktop login."
  fi
fi
