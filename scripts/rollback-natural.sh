#!/usr/bin/env bash
# Restore the pre-natural client/config, preserving all subsequent history.
set -euo pipefail
backup="${1:?Usage: rollback-natural.sh BACKUP_DIRECTORY}"
[[ -f "$backup/CapsWriter-GUI.AppImage" && -f "$backup/transcriptions.db" ]] || { echo 'Incomplete rollback backup' >&2; exit 1; }
restore_point="$HOME/.local/share/capswriter-backups/$(date +%Y%m%d-%H%M%S)-before-rollback"
mkdir -p "$restore_point"
systemctl --user stop capswriter-agx-client.service
systemctl --user stop capswriter-cec3.service || true
python3 - "$backup" "$restore_point" <<'PY'
import pathlib,sqlite3,sys,shutil
backup,point=map(pathlib.Path,sys.argv[1:]);data=pathlib.Path.home()/'.config/语音转写'
con=sqlite3.connect(data/'transcriptions.db')
with sqlite3.connect(point/'transcriptions.db') as snapshot:con.backup(snapshot)
old=sqlite3.connect(backup/'transcriptions.db')
with con:
 for key in ('text_processing_mode','text_polish_enabled','text_polish_hot_rule','long_text_format_enabled','natural_model_approved','natural_model_approval'):
  row=old.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()
  if row:con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,row[0]))
  else:con.execute('DELETE FROM settings WHERE key=?',(key,))
con.close();old.close()
for name in ('hot-words.txt','hot-rule.txt','hot-words.json'):
 current=data/name
 if current.exists():shutil.copy2(current,point/name)
 source=backup/name
 if source.exists():shutil.copy2(source,current)
 elif name=='hot-words.json' and current.exists():current.unlink()
PY
install -m 0755 "$backup/CapsWriter-GUI.AppImage" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.restore"
mv "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage.restore" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage"
rm -f "$HOME/.config/systemd/user/capswriter-agx-client.service.d/50-natural.conf"
rm -f "$HOME/.cache/capswriter-agx-client/intentional-quit"
systemctl --user daemon-reload
systemctl --user reset-failed capswriter-agx-client.service 2>/dev/null || true
systemctl --user start capswriter-agx-client.service
printf 'Restored previous client and settings. Current history retained; backup: %s\n' "$restore_point"
