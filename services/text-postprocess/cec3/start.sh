#!/usr/bin/env bash
set -euo pipefail
runtime="${CEC3_RUNTIME:-$HOME/.local/opt/capswriter-cec3}"
model="${CEC3_MODEL:-$HOME/weight/capswriter/ChineseErrorCorrector3-4B-e6d757f-Q4_K_M.gguf}"
status_dir="${CEC3_STATE:-$HOME/.local/state/capswriter-cec3}"
mkdir -p "$status_dir"
write_status() { printf '{"reason":"%s","updated_at":%s}\n' "$1" "$(date +%s)" > "$status_dir/status.json"; }
if [[ ! -s "$model" ]]; then write_status model_missing; echo 'CEC3 model missing; client will use base text' >&2; exit 78; fi
available_kb=$(awk '/MemAvailable:/{print $2}' /proc/meminfo)
if (( available_kb < 5500000 )); then write_status insufficient_memory; echo 'CEC3 insufficient free unified memory; client will use base text' >&2; exit 75; fi
write_status starting
# The separate user service cannot stop or reconfigure other inference workloads.
export LD_LIBRARY_PATH="$runtime/bin:${LD_LIBRARY_PATH:-}"
exec "$runtime/bin/llama-server" --model "$model" --alias capswriter-cec3-4b \
  --host 127.0.0.1 --port 18088 --ctx-size 4096 --parallel 1 --threads 4 \
  --n-gpu-layers 99 --flash-attn on --fit off --jinja --reasoning-budget 0 \
  --chat-template-kwargs '{"enable_thinking":false}' --timeout 20 --no-webui
