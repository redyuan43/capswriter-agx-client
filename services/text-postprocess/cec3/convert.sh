#!/usr/bin/env bash
set -euo pipefail
source_dir="${CEC3_SOURCE:-$HOME/weight/capswriter/cec3-official}"
engine="${CEC3_ENGINE:-$HOME/engines/llama.cpp-prism}"
python_bin="${CEC3_PYTHON:-$HOME/weight/fireredasr2-nx4/venv/bin/python}"
output_dir="${CEC3_OUTPUT:-$HOME/weight/capswriter}"
[[ $(git -C "$engine" rev-parse HEAD) == 1a07bfa5f4144274c8f1c9963821dd9d9a51854b ]] || { echo 'Unpinned llama.cpp runtime' >&2; exit 1; }
cd "$source_dir"
sha256sum -c <<'SUM'
28acad4933be8d1d44a8ff3dcc1f2acce3ed9043a36bf9feb32c10af2fe97dc6  model-00001-of-00002.safetensors
df435b82d09456f24bb55f6e3b1be091a1af1bc970799ac07aea23686af6dd7a  model-00002-of-00002.safetensors
SUM
# Reuse existing Python packages read-only. Do not install into the ASR runtime.
"$python_bin" "$engine/convert_hf_to_gguf.py" "$source_dir" --outtype bf16 \
 --outfile "$output_dir/ChineseErrorCorrector3-4B-e6d757f-BF16.gguf" --model-name ChineseErrorCorrector3-4B
"$engine/build-13/bin/llama-quantize" "$output_dir/ChineseErrorCorrector3-4B-e6d757f-BF16.gguf" \
 "$output_dir/ChineseErrorCorrector3-4B-e6d757f-Q4_K_M.gguf" Q4_K_M 4
cd "$output_dir"
sha256sum ChineseErrorCorrector3-4B-e6d757f-Q4_K_M.gguf > ChineseErrorCorrector3-4B-e6d757f-Q4_K_M.gguf.sha256
