#!/usr/bin/env bash
set -euo pipefail
umask 077
backup="${1:?Pass the punctuation-cutover backup directory}"
[[ -f "$backup/CapsWriter-GUI.AppImage" && -f "$backup/transcriptions.db" ]] || exit 1
systemctl --user stop capswriter-agx-client.service
trap 'systemctl --user start capswriter-agx-client.service || true' EXIT
python3 - "$backup" <<'PY'
import pathlib,sqlite3,json,sys,datetime,shutil
backup=pathlib.Path(sys.argv[1]);data=pathlib.Path.home()/'.config/语音转写/transcriptions.db'
con=sqlite3.connect(data);previous=sqlite3.connect('file:'+str(backup/'transcriptions.db')+'?mode=ro',uri=True)
with sqlite3.connect(backup/('pre-rollback-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.db')) as out:con.backup(out)
with con:
 for key in ['natural_formatter_profile','text_processing_mode','natural_model_approved','natural_model_approval']:
  row=previous.execute('select value from settings where key=?',(key,)).fetchone()
  if row:con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,row[0]))
  else:con.execute('DELETE FROM settings WHERE key=?',(key,))
con.close();previous.close()
drop=pathlib.Path.home()/'.config/systemd/user/capswriter-cec3.service.d/60-punctuation.conf'
old=backup/'capswriter-cec3.service.d/60-punctuation.conf'
if old.is_file():shutil.copy2(old,drop)
elif drop.is_file():drop.unlink()
PY
install -m 0755 "$backup/CapsWriter-GUI.AppImage" "$HOME/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage"
systemctl --user daemon-reload
systemctl --user reset-failed capswriter-cec3.service capswriter-agx-client.service 2>/dev/null || true
systemctl --user start capswriter-agx-client.service
trap - EXIT
