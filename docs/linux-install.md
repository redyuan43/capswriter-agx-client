# Linux Release Installation

The official Linux release path installs the AppImage, verifies its SHA-256
checksum, enables desktop-login autostart, and starts CapsWriter in tray/background
mode. It is intended for the current desktop user. By default it asks for `sudo`
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
- creates a menu entry and a GNOME/XDG autostart entry;
- installs a udev `uaccess` rule for keyboard input and the `VibeStick MiniJoy Mouse` input device;
- starts the client in the current graphical desktop session.

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

Use `--skip-input-permission` when MiniJoy is not used or system permissions
must remain unchanged. If MiniJoy was already connected during installation,
reconnect it once and restart CapsWriter.

## Verify

```bash
pgrep -af "CapsWriter-GUI.*AppImage"
desktop-file-validate "$HOME/.config/autostart/capswriter-agx-client.desktop"
tail -f "$HOME/.cache/capswriter-agx-client/capswriter-agx-client.log"
```

## Remove

Stop the client first, then remove its files:

```bash
pkill -u "$(id -u)" -f "CapsWriter-GUI.*AppImage" || true
rm -f "$HOME/.config/autostart/capswriter-agx-client.desktop"
rm -f "$HOME/.local/share/applications/capswriter-agx-client.desktop"
rm -f "$HOME/.local/bin/capswriter-agx-client"
rm -rf "$HOME/.local/opt/capswriter-agx-client"
```
