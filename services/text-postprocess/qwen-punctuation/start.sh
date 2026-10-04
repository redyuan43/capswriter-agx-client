#!/usr/bin/env bash
set -euo pipefail
runtime="$HOME/.local/opt/capswriter-cec3"
model="$HOME/weight/capswriter/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
status_dir="$HOME/.local/state/capswriter-cec3"
mkdir -p "$status_dir"
write_status() { printf '{"reason":"%s","updated_at":%s}\n' "$1" "$(date +%s)" > "$status_dir/status.json"; }
[[ -s "$model" ]] || { write_status model_missing; exit 78; }
available_kb=$(awk '/MemAvailable:/{print $2}' /proc/meminfo)
(( available_kb >= 5500000 )) || { write_status insufficient_memory; exit 75; }
write_status starting
export LD_LIBRARY_PATH="$runtime/bin:${LD_LIBRARY_PATH:-}"
exec "$runtime/bin/llama-server" --model "$model" --alias capswriter-qwen-punctuation \
 --host 127.0.0.1 --port 18088 --ctx-size 4096 --parallel 1 --threads 4 \
 --n-gpu-layers 99 --flash-attn on --fit off --jinja --reasoning-budget 0 \
 --chat-template-kwargs '{"enable_thinking":false}' --timeout 20 --no-webui
