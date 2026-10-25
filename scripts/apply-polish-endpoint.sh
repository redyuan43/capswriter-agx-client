#!/usr/bin/env bash
# 把「逐字保真」（听写后的修断句/标点）从智谱 GLM 改到本机 OpenAI 兼容端点。
#
# 为什么需要它：
#   glm-4.7-flash 长期返回 1305「该模型当前访问量过大」，SpeechTextFormatter 拿不到结果就
#   整条降级回原文——用户看到的现象是「整个。资料。SBG。的。」这种碎句号没人管。
#   换成本机模型后这一层稳定生效，且不出网、不花钱。
#
# 做两件事：
#   1. 写 drop-in 30-polish-endpoint.conf（含 [Service] 段！漏了会被 systemd 静默忽略）
#      Environment=CAPSWRITER_POLISH_ENDPOINT / _MODEL / _FALLBACK_MODEL
#   2. 可选重启服务（--restart），并用一个固定短句探一次端点
#
# 用法:
#   scripts/apply-polish-endpoint.sh                          # 默认本机 halogen 别名代理
#   scripts/apply-polish-endpoint.sh --endpoint http://127.0.0.1:28107/v1/chat/completions \
#                                    --model siyuan/qwen38-v100-196k --restart
#   scripts/apply-polish-endpoint.sh --off                    # 撤销，回到默认 GLM
#
# 注意：CAPSWRITER_POLISH_API_KEY 默认留空（本机端点通常不开鉴权）。
#       端点若需要密钥，加 --api-key <value>。
set -euo pipefail

ENDPOINT="http://127.0.0.1:18111/v1/chat/completions"
MODEL="siyuan-local"
FALLBACK="glm-4.5-air"
API_KEY=""
RESTART=0
OFF=0

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint) ENDPOINT="${2:?}"; shift 2 ;;
    --model)    MODEL="${2:?}"; shift 2 ;;
    --fallback) FALLBACK="${2:?}"; shift 2 ;;
    --api-key)  API_KEY="${2:?}"; shift 2 ;;
    --restart)  RESTART=1; shift ;;
    --off)      OFF=1; shift ;;
    -h|--help)  sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

UNIT_DIR="$HOME/.config/systemd/user/capswriter-agx-client.service.d"
DROPIN="$UNIT_DIR/30-polish-endpoint.conf"
mkdir -p "$UNIT_DIR"

if [ "$OFF" = "1" ]; then
  if [ -f "$DROPIN" ]; then
    mv "$DROPIN" "$DROPIN.off-$(date +%Y%m%d-%H%M%S)"
    echo "已停用 $DROPIN（改名保留，想恢复改回来即可）"
  else
    echo "本来就没配，无需停用"
  fi
else
  # [Service] 段头不能省：systemd 对「Assignment outside of section」只发一行警告就整段丢弃，
  # 表现是变量怎么都不生效（这次踩过）。
  {
    echo "[Service]"
    echo "# 逐字保真（修断句/标点）走本机端点；glm-4.7-flash 长期 1305 限流会整条降级回原文。"
    echo "Environment=CAPSWRITER_POLISH_ENDPOINT=$ENDPOINT"
    echo "Environment=CAPSWRITER_POLISH_MODEL=$MODEL"
    echo "# 本机引擎熄火（owner 闲置即停）时回退云端，别让整理整条丢掉。"
    echo "Environment=CAPSWRITER_POLISH_FALLBACK_MODEL=$FALLBACK"
    if [ -n "$API_KEY" ]; then echo "Environment=CAPSWRITER_POLISH_API_KEY=$API_KEY"; fi
  } > "$DROPIN"
  chmod 600 "$DROPIN"
  echo "  写入        = $DROPIN"
  echo "  endpoint    = $ENDPOINT"
  echo "  model       = $MODEL"
  echo "  fallback    = $FALLBACK"
fi

systemctl --user daemon-reload
if systemd-analyze --user verify capswriter-agx-client.service 2>&1 | grep -q "polish-endpoint"; then
  echo "  ⚠️ drop-in 仍被 systemd 判为非法（大概率漏了 [Service] 段头）" >&2
fi

if [ "$OFF" != "1" ]; then
  # 固定短句探活：不发用户内容，只看端点是否真的会整理。
  probe='{"model":"'"$MODEL"'","temperature":0.1,"max_tokens":128,"stream":false,"messages":[{"role":"system","content":"只修标点，只输出原文。"},{"role":"user","content":"我们先把整个。资料。生成SVG的。"}]}'
  auth=()
  [ -n "$API_KEY" ] && auth=(-H "Authorization: Bearer $API_KEY")
  if reply="$(curl -s -m 20 "$ENDPOINT" -H 'Content-Type: application/json' "${auth[@]}" -d "$probe" 2>/dev/null)"; then
    echo "  探活        = $(printf '%s' "$reply" | head -c 160)"
  else
    echo "  探活        = 连不上（整理会回退到 $FALLBACK）"
  fi
fi

if [ "$RESTART" = "1" ]; then
  systemctl --user restart capswriter-agx-client.service
  echo "已重启 capswriter-agx-client"
else
  echo "改完需重启应用才生效：systemctl --user restart capswriter-agx-client（或加 --restart）"
fi
