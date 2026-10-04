#!/usr/bin/env bash
# Run on nx6 only after tests/model evaluation; automatic rewriting stays gated.
set -euo pipefail
umask 077
root="$(cd "$(dirname "$0")/.." && pwd)"
artifact="$root/dist/CapsWriter-GUI-1.0.36-linux-arm64.AppImage"
[[ $(uname -m) == aarch64 && -s "$artifact" ]] || { echo 'Missing verified arm64 AppImage' >&2; exit 1; }
cd "$root"
DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 dist/linux-arm64-unpacked/speech-transcription \
 scripts/verify-speech-package.cjs dist/linux-arm64-unpacked/resources/app.asar > artifacts/natural/activation-package-check.log 2>&1
bash scripts/verify-appimage-native-arch.sh > artifacts/natural/appimage-native-check.log 2>&1
backup="$HOME/.local/share/capswriter-backups/$(date +%Y%m%d-%H%M%S)-natural-cutover"
mkdir -p "$backup"
systemctl --user stop capswriter-agx-client.service
cp -a "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage" "$backup/"
cp -a "$HOME/.local/bin/capswriter-gui" "$backup/"
cp -a "$HOME/.config/systemd/user/capswriter-agx-client.service" "$HOME/.config/systemd/user/capswriter-agx-client.service.d" "$backup/"
python3 - "$backup" <<'PY'
import pathlib,sqlite3,sys,shutil,json
backup=pathlib.Path(sys.argv[1]);data=pathlib.Path.home()/'.config/语音转写'
con=sqlite3.connect(data/'transcriptions.db')
with sqlite3.connect(backup/'transcriptions.db') as out:con.backup(out)
for name in ('hot-words.txt','hot-rule.txt','hot-words.json'):
 if (data/name).exists():shutil.copy2(data/name,backup/name)
with con:
 for key,value in [('text_processing_mode','natural'),('text_polish_enabled',True),('text_polish_hot_rule',True),('long_text_format_enabled',True),('natural_model_approved',False),('natural_model_approval',None)]:
  con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,json.dumps(value)))
con.close()
# Confine the launcher's existing AppImage cleanup to this app's private directory.
launcher=pathlib.Path.home()/'.local/bin/capswriter-gui'
s=launcher.read_text();s=s.replace('rm -rf "${TMPDIR:-/tmp}"/appimage_extracted_* 2>/dev/null || true', 'export TMPDIR="$LOG_DIR/tmp"\nmkdir -p "$TMPDIR"\nrm -rf "$TMPDIR"/appimage_extracted_* 2>/dev/null || true')
launcher.write_text(s)
PY
node scripts/configure-natural-hotwords.cjs "$HOME/.config/语音转写"
mkdir -p "$HOME/.config/systemd/user/capswriter-agx-client.service.d"
cat > "$HOME/.config/systemd/user/capswriter-agx-client.service.d/50-natural.conf" <<'UNIT'
[Unit]
Wants=capswriter-cec3.service
After=capswriter-cec3.service
UNIT
install -m 0755 "$artifact" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.new"
mv "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.new" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage"
rm -f "$HOME/.cache/capswriter-agx-client/intentional-quit"
systemctl --user daemon-reload
systemctl --user reset-failed capswriter-agx-client.service capswriter-cec3.service 2>/dev/null || true
printf '%s\n' "$backup" > artifacts/natural/backup-path.txt
systemctl --user start capswriter-agx-client.service
sha256sum "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage" > artifacts/natural/installed-appimage.sha256
printf 'Installed 1.0.36 with model delivery gated. Rollback backup: %s\n' "$backup"
