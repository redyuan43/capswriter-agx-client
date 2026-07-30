#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$APP_DIR/scripts/lib/asr-runtime-env.sh"
LOG_DIR="${CAPSWRITER_LOG_DIR:-$HOME/.cache/capswriter-agx-client}"
LOG_FILE="${CAPSWRITER_LOG_FILE:-$LOG_DIR/amd-latest.log}"
PID_FILE="$LOG_DIR/dev.pid"

DEFAULT_BACKEND_URL="http://spark-31d6.taild500c8.ts.net:18011"
DEFAULT_TTS_BASE_URL="http://ivan-ms-7b17.taild500c8.ts.net:8091"
DEFAULT_REALTIME_ASR_URL="ws://spark-31d6.taild500c8.ts.net:18011/api/asr/realtime"
DEFAULT_ASR_ENV_FILE="$HOME/.config/capswriter-agx-client/asr-public.env"

usage() {
  cat <<'EOF'
Usage:
  ./start.sh              Start the current AMD dev client in the background
  ./start.sh foreground   Start in the foreground
  ./start.sh restart      Restart the background dev client
  ./start.sh stop         Stop the background dev client started by this script
  ./start.sh status       Show whether this repo's dev client is running
  ./start.sh logs         Follow the startup log

Environment overrides:
  VITE_BACKEND_URL
  VITE_TTS_BASE_URL
  VITE_REALTIME_ASR_URL
  VITE_REALTIME_ASR_CONNECT_TIMEOUT_MS
  VITE_REALTIME_ASR_PRECONNECT_ENABLED (default: 1; set 0 for legacy gateway rollback)
  CAPSWRITER_ASR_ENV_FILE (default: ~/.config/capswriter-agx-client/asr-public.env)
  CAPSWRITER_REALTIME_ASR_URL
  CAPSWRITER_REALTIME_ASR_TOKEN
  CAPSWRITER_REALTIME_ASR_FALLBACK_URL
  CAPS_LISTENER_BACKEND
  M5_VOICE_BRIDGE_PORT
  START_REBUILD_NATIVE=1  Force electron native dependency rebuild
EOF
}

ensure_log_dir() {
  mkdir -p "$LOG_DIR"
}

repo_electron_pattern() {
  printf '%s/node_modules/.pnpm/electron.*/node_modules/electron/dist/electron . --dev' "$APP_DIR"
}

pid_is_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

pid_from_file() {
  [[ -f "$PID_FILE" ]] && sed -n '1p' "$PID_FILE" || true
}

find_repo_electron_pid() {
  pgrep -u "$(id -u)" -f "$(repo_electron_pattern)" 2>/dev/null | head -n 1 || true
}

find_repo_dev_pids() {
  {
    pgrep -u "$(id -u)" -f "$(repo_electron_pattern)" 2>/dev/null || true
    pgrep -u "$(id -u)" -f "$APP_DIR/node_modules/.bin/../vite/bin/vite.js" 2>/dev/null || true
  } | awk 'NF && !seen[$1]++'
}

is_running() {
  local pid
  pid="$(pid_from_file)"
  if pid_is_alive "$pid"; then
    return 0
  fi

  [[ -n "$(find_repo_electron_pid)" ]]
}

adopt_desktop_env() {
  if [[ -n "${DISPLAY:-}" ]]; then
    return 0
  fi

  local session_pid=""
  local candidate
  for candidate in gnome-shell plasmashell xfce4-session cinnamon-session mate-session; do
    session_pid="$(pgrep -u "$USER" -n "$candidate" 2>/dev/null || true)"
    if [[ -n "$session_pid" && -r "/proc/$session_pid/environ" ]]; then
      break
    fi
  done

  if [[ -z "$session_pid" || ! -r "/proc/$session_pid/environ" ]]; then
    echo "No desktop session environment found. Start this from the desktop terminal or set DISPLAY/XAUTHORITY." >&2
    exit 1
  fi

  while IFS= read -r entry; do
    case "$entry" in
      DISPLAY=*|XAUTHORITY=*|DBUS_SESSION_BUS_ADDRESS=*|XDG_CURRENT_DESKTOP=*|XDG_SESSION_TYPE=*|XDG_RUNTIME_DIR=*)
        export "$entry"
        ;;
    esac
  done < <(tr '\0' '\n' <"/proc/$session_pid/environ")
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack enable
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required but was not found in PATH." >&2
    exit 1
  fi
}

install_js_deps_if_needed() {
  if [[ -d "$APP_DIR/node_modules" ]]; then
    return 0
  fi

  echo "node_modules not found; installing dependencies..."
  (cd "$APP_DIR" && pnpm install --frozen-lockfile)
}

native_arch_expected() {
  case "$(uname -m)" in
    x86_64) echo "x86-64" ;;
    aarch64|arm64) echo "aarch64" ;;
    *) uname -m ;;
  esac
}

native_modules_match_arch() {
  local expected node_file
  expected="$(native_arch_expected)"
  node_file="$(find "$APP_DIR/node_modules" -path '*better-sqlite3*/build/Release/better_sqlite3.node' -print -quit 2>/dev/null || true)"

  [[ -n "$node_file" ]] || return 1
  file "$node_file" | grep -qi "$expected"
}

ensure_native_deps() {
  local electron_version marker
  electron_version="$(node -p "require('$APP_DIR/node_modules/electron/package.json').version")"
  marker="$LOG_DIR/native-deps-$(uname -m)-electron-$electron_version"

  if [[ "${START_REBUILD_NATIVE:-0}" == "1" || ! -f "$marker" ]] || ! native_modules_match_arch; then
    echo "Preparing Electron native dependencies for $(uname -m)..."
    (cd "$APP_DIR" && pnpm exec electron-builder install-app-deps)
    : >"$marker"
  fi
}

export_runtime_env() {
  load_asr_env
  export ELECTRON_DISABLE_SANDBOX="${ELECTRON_DISABLE_SANDBOX:-1}"
  export VITE_BACKEND_URL="${VITE_BACKEND_URL:-$DEFAULT_BACKEND_URL}"
  export VITE_TTS_BASE_URL="${VITE_TTS_BASE_URL:-$DEFAULT_TTS_BASE_URL}"
  export VITE_REALTIME_ASR_URL="${VITE_REALTIME_ASR_URL:-$DEFAULT_REALTIME_ASR_URL}"
  export VITE_REALTIME_ASR_CONNECT_TIMEOUT_MS="${VITE_REALTIME_ASR_CONNECT_TIMEOUT_MS:-30000}"
  export CAPS_LISTENER_BACKEND="${CAPS_LISTENER_BACKEND:-auto}"
}

load_asr_env() {
  local env_file="${CAPSWRITER_ASR_ENV_FILE:-$DEFAULT_ASR_ENV_FILE}"
  load_capswriter_asr_runtime_env "$env_file"
}

prepare() {
  ensure_log_dir
  adopt_desktop_env
  ensure_pnpm
  install_js_deps_if_needed
  ensure_native_deps
  export_runtime_env
}

start_background() {
  ensure_log_dir
  if is_running; then
    echo "CapsWriter dev client is already running."
    status
    return 0
  fi

  prepare
  : >"$LOG_FILE"
  (
    cd "$APP_DIR"
    setsid bash -lc 'exec pnpm run dev' >>"$LOG_FILE" 2>&1 < /dev/null &
    echo $! >"$PID_FILE"
  )

  sleep 2
  status || true
  echo "Log: $LOG_FILE"
}

start_foreground() {
  prepare
  cd "$APP_DIR"
  exec pnpm run dev
}

stop_background() {
  local pid
  pid="$(pid_from_file)"

  if pid_is_alive "$pid"; then
    echo "Stopping CapsWriter dev client pid=$pid..."
    kill -TERM "-$pid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      pid_is_alive "$pid" || break
      sleep 0.5
    done
    if pid_is_alive "$pid"; then
      kill -KILL "-$pid" >/dev/null 2>&1 || kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$PID_FILE"
    return 0
  fi

  rm -f "$PID_FILE"

  local repo_pids
  repo_pids="$(find_repo_dev_pids)"
  if [[ -n "$repo_pids" ]]; then
    echo "Stopping existing CapsWriter repo dev process(es): $repo_pids"
    kill $repo_pids >/dev/null 2>&1 || true
    sleep 1
    repo_pids="$(find_repo_dev_pids)"
    if [[ -n "$repo_pids" ]]; then
      kill -KILL $repo_pids >/dev/null 2>&1 || true
    fi
    return 0
  fi

  echo "No CapsWriter dev client is running."
}

status() {
  local pid repo_pid
  pid="$(pid_from_file)"
  if pid_is_alive "$pid"; then
    echo "running: pid=$pid"
    return 0
  fi

  repo_pid="$(find_repo_electron_pid)"
  if [[ -n "$repo_pid" ]]; then
    echo "running: repo electron pid=$repo_pid"
    return 0
  fi

  echo "not running"
  return 1
}

logs() {
  ensure_log_dir
  touch "$LOG_FILE"
  exec tail -f "$LOG_FILE"
}

case "${1:-start}" in
  start)
    start_background
    ;;
  foreground|fg)
    start_foreground
    ;;
  restart)
    stop_background
    start_background
    ;;
  stop)
    stop_background
    ;;
  status)
    status
    ;;
  logs|log)
    logs
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
