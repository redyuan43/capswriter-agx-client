#!/usr/bin/env bash
# nx6 deployment. Failed quality evidence can only install history-only mode.
set -euo pipefail
umask 077
mode="${1:-}"
evidence="${2:-artifacts/natural/ai-firstbatch-review.acceptance.json}"
[[ "$mode" == --history-only || "$mode" == --enable-reviewed ]] || { echo 'Usage: activate-ai-natural.sh --history-only|--enable-reviewed [acceptance.json]' >&2; exit 2; }
: "${CAPSWRITER_NATURAL_MODEL_ROOT:?Set CAPSWRITER_NATURAL_MODEL_ROOT to the verified model root before activation}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version="$(node -p "require('./package.json').version")"
artifact="$root/dist/CapsWriter-GUI-${version}-linux-arm64.AppImage"
[[ $(uname -m) == aarch64 && -s "$artifact" && -s "$evidence" ]] || exit 1
export CAPSWRITER_NATURAL_API_KEY_FILE="$HOME/.config/capswriter-natural/ai-api-key"
node - "$mode" "$evidence" <<'JS'
const fs = require('fs');
const { AiNaturalFormatter, POLICY_HASH } = require('./src/helpers/aiNaturalFormatter');
(async () => {
  const f = new AiNaturalFormatter(); const evidence = JSON.parse(fs.readFileSync(process.argv[3]));
  if (evidence.policy_hash !== POLICY_HASH) throw Error('评测与源码版本不一致');
  if (process.argv[2] === '--enable-reviewed' && !f.isApproved(evidence)) throw Error('质量验收未通过，禁止自动交付');
  const probe = await f.probe(); if (!probe.verified) throw Error('模型身份或连接检查失败');
  console.log(JSON.stringify({ profile: f.profile, model: f.model, verified: true, qualityPassed: evidence.passed }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
JS
DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 dist/linux-arm64-unpacked/speech-transcription scripts/verify-speech-package.cjs dist/linux-arm64-unpacked/resources/app.asar > artifacts/natural/ai-package-check.log 2>&1
backup="$HOME/.local/share/capswriter-backups/$(date +%Y%m%d-%H%M%S)-ai-natural"
mkdir -p "$backup/config" "$backup/service"
cp -a "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage" "$backup/"
dropin="$HOME/.config/systemd/user/capswriter-agx-client.service.d/70-ai-natural.conf"
if [[ -f "$dropin" ]]; then cp -a "$dropin" "$backup/service/"; else touch "$backup/service/dropin-absent"; fi
systemctl --user stop capswriter-agx-client.service
trap 'systemctl --user start capswriter-agx-client.service || true' EXIT
python3 - "$backup" "$mode" "$evidence" <<'PY'
import json,pathlib,shutil,sqlite3,sys
backup=pathlib.Path(sys.argv[1]);folder=pathlib.Path.home()/'.config/语音转写'
db=folder/'transcriptions.db'
if not db.is_file():raise SystemExit('Existing database required')
con=sqlite3.connect(db)
with sqlite3.connect(backup/'transcriptions.db') as target:con.backup(target)
for file in folder.iterdir():
 if file.is_file() and file.suffix in ('.json','.txt','.yaml','.yml'):shutil.copy2(file,backup/'config'/file.name)
keys=['natural_formatter_profile','text_processing_mode','text_polish_enabled','long_text_format_enabled','natural_model_approved','natural_model_approval']
(backup/'settings.json').write_text(json.dumps({k:con.execute('SELECT value FROM settings WHERE key=?',(k,)).fetchone() for k in keys}))
report=json.loads(pathlib.Path(sys.argv[3]).read_text());active=sys.argv[2]=='--enable-reviewed'
if active and report.get('passed') is not True:raise SystemExit('Quality gate failed')
with con:
 for key,value in [('natural_formatter_profile','ai-natural'),('text_processing_mode','natural'),('text_polish_enabled',True),('long_text_format_enabled',True),('natural_model_approved',active),('natural_model_approval',report)]:
  con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,json.dumps(value)))
con.close()
PY
mkdir -p "$(dirname "$dropin")"
cat > "$dropin" <<UNIT
[Service]
Environment=CAPSWRITER_NATURAL_ENDPOINT=http://127.0.0.1:28107/v1/chat/completions
Environment=CAPSWRITER_NATURAL_MODEL=siyuan/qwen38-v100-196k
Environment=CAPSWRITER_NATURAL_MODEL_ROOT=$CAPSWRITER_NATURAL_MODEL_ROOT
Environment=CAPSWRITER_NATURAL_API_KEY_FILE=$CAPSWRITER_NATURAL_API_KEY_FILE
UNIT
systemctl --user daemon-reload
install -m 0755 "$artifact" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.new"
mv "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.new" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage"
# Our managed stop creates the same marker as a user quit; permit this authorized restart.
rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/capswriter-agx-client/intentional-quit"
systemctl --user start capswriter-agx-client.service
sleep 3
systemctl --user is-active --quiet capswriter-agx-client.service
printf '%s\n' "$backup" > artifacts/natural/ai-backup-path.txt
sha256sum "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage" > artifacts/natural/ai-installed.sha256
trap - EXIT
printf 'Installed %s; mode=%s; backup=%s\n' "$version" "$mode" "$backup"
