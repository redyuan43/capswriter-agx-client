#!/usr/bin/env bash
# Explicit cutover only; never invoked by evaluation scripts or model fallback.
set -euo pipefail
umask 077
choice="${1:-}"
[[ "$choice" == --enable-punctuation || "$choice" == --history-only ]] || { echo 'Choose --enable-punctuation (explicit user approval) or --history-only' >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version="$(node -p "require('./package.json').version")"
artifact="$root/dist/CapsWriter-GUI-${version}-linux-arm64.AppImage"
[[ $(uname -m) == aarch64 && -s "$artifact" ]] || exit 1
model="$HOME/weight/capswriter/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
expected=3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597
[[ $(sha256sum "$model" | cut -d' ' -f1) == "$expected" ]] || { echo 'Model hash mismatch' >&2; exit 1; }
DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 dist/linux-arm64-unpacked/speech-transcription scripts/verify-speech-package.cjs dist/linux-arm64-unpacked/resources/app.asar > artifacts/natural/punctuation-activation-check.log 2>&1
backup="$HOME/.local/share/capswriter-backups/$(date +%Y%m%d-%H%M%S)-punctuation-cutover"
mkdir -p "$backup"
systemctl --user stop capswriter-agx-client.service
trap 'systemctl --user start capswriter-agx-client.service || true' EXIT
cp -a "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage" "$backup/"
if [[ -d "$HOME/.config/systemd/user/capswriter-cec3.service.d" ]]; then cp -a "$HOME/.config/systemd/user/capswriter-cec3.service.d" "$backup/"; fi
python3 - "$backup" "$choice" "$expected" <<'PY'
import pathlib,sqlite3,json,sys,datetime
backup=pathlib.Path(sys.argv[1]);con=sqlite3.connect(pathlib.Path.home()/'.config/语音转写/transcriptions.db')
with sqlite3.connect(backup/'transcriptions.db') as out:con.backup(out)
active=sys.argv[2]=='--enable-punctuation'
evidence={'profile':'qwen-punctuation','scope':'punctuation','prompt_version':'qwen-punctuation-v2','model_sha256':sys.argv[3],'body_preserved':True,'approved_by_user':active,'full_natural_quality_passed':False,'review_type':'AI text review, not audio ground truth','updated_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with con:
 for key,value in [('natural_formatter_profile','qwen-punctuation'),('text_processing_mode','natural'),('natural_model_approved',active),('natural_model_approval',evidence)]:
  con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,json.dumps(value)))
con.close()
PY
mkdir -p "$HOME/.local/opt/capswriter-punctuation" "$HOME/.config/systemd/user/capswriter-cec3.service.d"
install -m 0755 services/text-postprocess/qwen-punctuation/start.sh "$HOME/.local/opt/capswriter-punctuation/start.sh"
cat > "$HOME/.config/systemd/user/capswriter-cec3.service.d/60-punctuation.conf" <<'UNIT'
[Service]
ExecStart=
ExecStart=%h/.local/opt/capswriter-punctuation/start.sh
UNIT
install -m 0755 "$artifact" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.new"
mv "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.new" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage"
systemctl --user daemon-reload
systemctl --user reset-failed capswriter-cec3.service capswriter-agx-client.service 2>/dev/null || true
systemctl --user start capswriter-agx-client.service
printf '%s\n' "$backup" > artifacts/natural/punctuation-backup-path.txt
sha256sum "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage" > artifacts/natural/punctuation-installed.sha256
trap - EXIT
printf 'Installed %s; scope=punctuation; mode=%s; backup=%s\n' "$version" "$choice" "$backup"
