#!/usr/bin/env bash
# 把一台 Linux 机器切成「腾讯云 ASR 本机直连」并顺手修好识别质量。
#
# 做三件事（都可单独关掉）：
#   1. settings.asr_connection_profiles_v1.activeProfileId = tencent-direct
#      —— 不再经 ai-x10drg / spark 之类的中转机，客户端内建的 loopback 桥直连 asr.cloud.tencent.com
#   2. settings.tencent_realtime_engine = 16k_zh_en_2.0
#      —— 经典版 16k_zh 处理不了中英混说（"shift" 必丢），2.0 才行（付费，不吃免费额度）
#   3. 蓝牙麦克风增益 +12 dB
#      —— HFP 耳麦的原始电平常在 -23 dBFS 峰值，腾讯 VAD 在这档电平下明显降质；
#         PulseAudio/PipeWire 的音量是三次方曲线，158% = 1.58^3 ≈ 3.95 ≈ +12 dB
#
# 用法:
#   scripts/apply-tencent-direct-local.sh                      # 三步全做
#   scripts/apply-tencent-direct-local.sh --engine 16k_zh      # 留在免费经典版
#   scripts/apply-tencent-direct-local.sh --gain 0             # 不动麦克风增益
#   scripts/apply-tencent-direct-local.sh --source bluez_input.14_08_08_52_F9_62.0
#
# 前置：腾讯云凭据走环境变量 TENCENTCLOUD_APP_ID / SECRET_ID / SECRET_KEY
#       （建议放 systemd drop-in，别写进 JSON），否则直连桥起来也是 not_configured。
set -euo pipefail

ENGINE="16k_zh_en_2.0"
GAIN="158%"
SOURCE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE="${2:?}"; shift 2 ;;
    --gain)   GAIN="${2:?}"; shift 2 ;;
    --source) SOURCE="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

DB="${CAPSWRITER_DB:-$HOME/.config/语音转写/transcriptions.db}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if [ ! -f "$DB" ]; then
  echo "找不到配置库: $DB（客户端至少启动过一次才会有）" >&2
  exit 1
fi

cp -a "$DB" "$DB.bak-$(date +%Y%m%d-%H%M%S)"
DB="$DB" ENGINE="$ENGINE" python3 - <<'PY'
import json, os, sqlite3
db, engine = os.environ["DB"], os.environ["ENGINE"]
c = sqlite3.connect(db)
row = c.execute("SELECT value FROM settings WHERE key='asr_connection_profiles_v1'").fetchone()
cfg = json.loads(row[0]) if row else {"version": 1, "activeProfileId": "tencent-direct", "profiles": []}
# profiles 留空也能用：客户端启动时会用内置 PRESETS 重建全部预置项，只要 activeProfileId 命中即可
cfg["version"] = 1
cfg["activeProfileId"] = "tencent-direct"
c.execute("INSERT INTO settings(key,value) VALUES('asr_connection_profiles_v1',?) "
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          (json.dumps(cfg, ensure_ascii=False),))
c.execute("INSERT INTO settings(key,value) VALUES('tencent_realtime_engine',?) "
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (engine,))
c.commit()
print(f"  activeProfileId   = {cfg['activeProfileId']}")
print(f"  realtime_engine   = {engine}")
PY

if [ "$GAIN" != "0" ]; then
  if [ -z "$SOURCE" ]; then
    SOURCE="$(pactl list short sources 2>/dev/null | awk '/bluez_input/ {print $2; exit}')"
  fi
  if [ -n "$SOURCE" ]; then
    pactl set-source-volume "$SOURCE" "$GAIN"
    echo "  mic gain          = $(pactl get-source-volume "$SOURCE" | head -1 | sed 's/^[[:space:]]*//') ($SOURCE)"
  else
    echo "  未发现 bluez_input 源，跳过增益（蓝牙耳机/耳麦没连？）" >&2
  fi
fi

echo "完成。重连蓝牙后音量会自动恢复（wireplumber 存在 default-routes 里）。"
