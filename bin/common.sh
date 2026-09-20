# Shared paths and helpers for telegram-grok-bridge control scripts.
# Sourced only; not executed.

_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${BRIDGE_ROOT:=$(cd "$_SCRIPT_DIR/.." && pwd)}"
: "${BRIDGE_RUN_DIR:=${BRIDGE_ROOT}/run}"
RUN_DIR="$BRIDGE_RUN_DIR"
SUPERVISE_PID_FILE="${RUN_DIR}/supervise.pid"
CHILD_PID_FILE="${RUN_DIR}/child.pid"
LOCK_DIR="${RUN_DIR}/supervise.lock"
LOG_FILE="${RUN_DIR}/supervise.log"
CHILD_LOG_FILE="${RUN_DIR}/child.log"
TOKEN_FILE="${TELEGRAM_TOKEN_FILE:-${BRIDGE_ROOT}/secrets/token}"

ensure_run_dir() {
  mkdir -p "$RUN_DIR"
  chmod 0700 "$RUN_DIR" 2>/dev/null || true
}

read_pid() {
  local f="${1:-}"
  if [ ! -f "$f" ]; then
    printf '%s' ""
    return 0
  fi
  tr -cd '0-9' < "$f"
}

pid_alive() {
  local pid="${1:-}"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

is_running() {
  local spid cpid
  spid=$(read_pid "$SUPERVISE_PID_FILE")
  cpid=$(read_pid "$CHILD_PID_FILE")
  pid_alive "$spid" && pid_alive "$cpid"
}

file_mode() {
  local f="$1"
  stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f"
}

write_pid_file() {
  local f="$1" pid="$2"
  printf '%s\n' "$pid" > "$f"
  chmod 0600 "$f"
}
