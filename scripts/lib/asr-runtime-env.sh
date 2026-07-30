#!/usr/bin/env bash

load_capswriter_asr_runtime_env() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  local owner mode line key value
  owner="$(stat -c '%u' "$env_file")"
  mode="$(stat -c '%a' "$env_file")"
  if [[ "$owner" != "$(id -u)" ]]; then
    echo "Refusing ASR environment file not owned by the current user: $env_file" >&2
    return 1
  fi
  if (( 10#$mode % 100 != 0 )); then
    echo "Refusing ASR environment file readable by group or others: $env_file" >&2
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      echo "Invalid ASR environment line in $env_file" >&2
      return 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      CAPSWRITER_REALTIME_ASR_URL|CAPSWRITER_REALTIME_ASR_TOKEN|CAPSWRITER_REALTIME_ASR_FALLBACK_URL)
        export "$key=$value"
        ;;
      *)
        echo "Unsupported key in ASR environment file: $key" >&2
        return 1
        ;;
    esac
  done <"$env_file"
}
