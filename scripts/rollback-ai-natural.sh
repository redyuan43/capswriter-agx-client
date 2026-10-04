#!/usr/bin/env bash
# Restore previous client/config selection, keeping history added after cutover.
set -euo pipefail
backup="${1:?Usage: rollback-ai-natural.sh backup-directory}"
[[ -s "$backup/CapsWriter-GUI.AppImage" && -s "$backup/settings.json" ]] || exit 1
systemctl --user stop capswriter-agx-client.service
trap 'systemctl --user start capswriter-agx-client.service || true' EXIT
python3 - "$backup/settings.json" <<'PY'
import json,pathlib,sqlite3,sys
db=pathlib.Path.home()/'.config/语音转写/transcriptions.db'
if not db.is_file():raise SystemExit('Existing database required')
with sqlite3.connect(db) as con:
 for key,row in json.loads(pathlib.Path(sys.argv[1]).read_text()).items():
  if row is None:con.execute('DELETE FROM settings WHERE key=?',(key,))
  else:con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,row[0]))
PY
dropin="$HOME/.config/systemd/user/capswriter-agx-client.service.d/70-ai-natural.conf"
if [[ -f "$backup/service/dropin-absent" ]]; then rm -f "$dropin"; else cp -a "$backup/service/70-ai-natural.conf" "$dropin"; fi
install -m 0755 "$backup/CapsWriter-GUI.AppImage" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.new"
mv "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.new" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage"
systemctl --user daemon-reload
rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/capswriter-agx-client/intentional-quit"
systemctl --user start capswriter-agx-client.service
sleep 3
systemctl --user is-active --quiet capswriter-agx-client.service
trap - EXIT
echo 'Previous client and settings restored; newer history retained.'
