# Linux Release Installation

## MiniJoy 蓝牙诊断与恢复

Linux 安装器会安装 `m5bridge-doctor`。接入 M5StickC Plus SE 的 USB 串口后，可运行：

```bash
m5bridge-doctor diagnose
m5bridge-doctor repair --recover-bluez
```

它分别报告 M5 串口、BlueZ 配对、HID/HFP、PipeWire 与 CapsWriter Bridge。`repair` 仅在主机和 M5 的绑定状态不一致时清理目标 MiniJoy；`--recover-bluez` 仅允许受限助手重启 `bluetooth.service`。

The official Linux release path installs the AppImage, verifies its SHA-256
checksum, enables desktop-login autostart, and starts CapsWriter under a
restartable systemd user service. It is intended for the current desktop user. By default it asks for `sudo`
once to configure MiniJoy trackball input access; use `--skip-input-permission`
to leave system permissions unchanged.

If AppImage startup reports that `libfuse.so.2` is missing, install the
distribution's FUSE 2 compatibility package first. On Ubuntu/Debian:

```bash
sudo apt-get install -y libfuse2
```

## Install

The repository is private, so authenticate GitHub CLI once:

```bash
gh auth login
```

Download the installer from the latest release and run it:

```bash
mkdir -p "$HOME/.cache/capswriter-installer"
gh release download \
  --repo redyuan43/capswriter-agx-client \
  --pattern "install-capswriter-agx-client.sh" \
  --dir "$HOME/.cache/capswriter-installer"
bash "$HOME/.cache/capswriter-installer/install-capswriter-agx-client.sh"
```

The installer automatically:

- selects the `x86_64` or `arm64` AppImage for the current machine;
- downloads `SHA256SUMS.txt` and verifies the AppImage;
- installs the client at `~/.local/opt/capswriter-agx-client/`;
- writes a launcher at `~/.local/bin/capswriter-agx-client`;
- creates one systemd user service plus a GNOME/XDG login starter;
- installs a udev `uaccess` rule for keyboard input and the `VibeStick MiniJoy Mouse` input device;
- imports the graphical-session environment and starts the monitored client;
- restarts the complete client process group after an unexpected crash.

After a system reboot, CapsWriter starts again when the user logs into the
graphical desktop. A GUI application cannot run before a user graphical session
exists.

## Tray Icon

The installer registers the green `S` icon for the application menu and
autostart entry. Its tray icon appears in the desktop status area and is the
entry point for the control menu.

GNOME requires an AppIndicator extension to display Electron tray icons. Ubuntu
normally enables `ubuntu-appindicators@ubuntu.com`; on other GNOME systems,
install and enable the distribution's AppIndicator extension before logging in
again. The installer warns when it cannot find an enabled AppIndicator
extension, because the client would otherwise be running without a visible tray
icon.

## Options

```bash
bash install-capswriter-agx-client.sh --no-autostart
bash install-capswriter-agx-client.sh --no-launch
bash install-capswriter-agx-client.sh --skip-input-permission
bash install-capswriter-agx-client.sh --install-dir "$HOME/.local/opt/capswriter"
```

## MiniJoy Trackball Permission

By default, the installer asks for `sudo` once to install
`/etc/udev/rules.d/70-capswriter-minijoy-input.rules`. The rule matches only
keyboard event devices and `VibeStick MiniJoy Mouse`, and uses `uaccess` to
grant the active graphical user access to them. The launcher enables evdev by
default, so it can distinguish ordinary Right Shift from MiniJoy input. The
rule remains effective when MiniJoy reconnects and does not add the user to the
global `input` group.

When multiple MiniJoy devices share the same Bluetooth name, CapsWriter uses
their Bluetooth MAC addresses to keep their HID buttons and HFP microphones
separate. The routing page shows a short suffix such as `MiniJoy F9:62`, and
the saved route survives `/dev/input/eventN` changes after reconnecting.

Use `--skip-input-permission` when MiniJoy is not used or system permissions
must remain unchanged. If MiniJoy was already connected during installation,
reconnect it once and restart CapsWriter.

## Verify

```bash
pgrep -af "CapsWriter-GUI.*AppImage"
systemctl --user status capswriter-agx-client.service
desktop-file-validate "$HOME/.config/autostart/capswriter-agx-client.desktop"
tail -f "$HOME/.cache/capswriter-agx-client/capswriter-agx-client.log"
```

## Remove

Stop the client first, then remove its files:

```bash
pkill -u "$(id -u)" -f "CapsWriter-GUI.*AppImage" || true
systemctl --user disable --now capswriter-agx-client.service || true
rm -f "$HOME/.config/autostart/capswriter-agx-client.desktop"
rm -f "$HOME/.config/systemd/user/capswriter-agx-client.service"
rm -f "$HOME/.local/share/applications/capswriter-agx-client.desktop"
rm -f "$HOME/.local/bin/capswriter-agx-client"
rm -f "$HOME/.local/bin/capswriter-agx-client-service-start"
rm -rf "$HOME/.local/opt/capswriter-agx-client"
```
