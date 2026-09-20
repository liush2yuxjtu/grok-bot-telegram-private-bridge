#!/usr/bin/env bash
# Self-recovery wrapper for telegram-grok-bridge and sibling event-driven inputs.
# TERM the child process group on stop; exponential backoff (1,2,4,... cap 30s)
# on unexpected child exit; parent stays alive. Does not restart after SIGTERM.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

umask 077
ensure_run_dir

touch "$LOG_FILE"
chmod 0600 "$LOG_FILE"

log() {
  # Never log credential contents, Bearer values, URLs, or token-file values.
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"
}

if ! mkdir -m 0700 "$LOCK_DIR" 2>/dev/null; then
  previous_pid=$(read_pid "$SUPERVISE_PID_FILE")
  if pid_alive "$previous_pid"; then
    log "status=already-locked"
    exit 1
  fi
  rm -rf "$LOCK_DIR"
  if ! mkdir -m 0700 "$LOCK_DIR" 2>/dev/null; then
    log "status=lock-failed"
    exit 1
  fi
fi

stopping=0
child_pid=""
delay_pid=""
restart_delay_s=1

stop_supervisor() {
  stopping=1
  if [ -n "${delay_pid}" ]; then
    kill -TERM "${delay_pid}" 2>/dev/null || true
  fi
  if [ -n "${child_pid}" ]; then
    kill -TERM -- "-${child_pid}" 2>/dev/null ||
      kill -TERM "${child_pid}" 2>/dev/null ||
      true
  fi
}
trap stop_supervisor TERM INT

cleanup_and_exit() {
  rm -f "$SUPERVISE_PID_FILE" "$CHILD_PID_FILE"
  rmdir "$LOCK_DIR" 2>/dev/null || true
  log "status=stopped"
  exit 0
}

write_pid_file "$SUPERVISE_PID_FILE" "$$"
if [ -n "${TELEGRAM_TOKEN_FILE:-}" ]; then
  log "status=supervisor-start pid=$$ token_file_set=yes"
else
  log "status=supervisor-start pid=$$ token_file_set=no"
fi

child_script="${BRIDGE_CHILD:-${BRIDGE_ROOT}/src/main.mjs}"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$node_bin" ]; then
  log "status=missing-node"
  exit 1
fi

while [ "${stopping}" = "0" ]; do
  env_cmd=(env -i "PATH=${PATH:-/usr/bin:/bin}" "HOME=${HOME:-}")
  if [ -n "${TELEGRAM_TOKEN_FILE:-}" ]; then
    env_cmd+=("TELEGRAM_TOKEN_FILE=${TELEGRAM_TOKEN_FILE}")
  fi
  if [ -n "${STATE_PATH:-}" ]; then
    env_cmd+=("STATE_PATH=${STATE_PATH}")
  fi
  if [ -n "${GATEWAY_PATH:-}" ]; then
    env_cmd+=("GATEWAY_PATH=${GATEWAY_PATH}")
  fi
  if [ -n "${TELEGRAM_API_BASE:-}" ]; then
    env_cmd+=("TELEGRAM_API_BASE=${TELEGRAM_API_BASE}")
  fi
  if [ -n "${GROK_AGENT_NAME:-}" ]; then
    env_cmd+=("GROK_AGENT_NAME=${GROK_AGENT_NAME}")
  fi
  if [ -n "${AIRTABLE_TASK_HOST:-}" ]; then
    env_cmd+=("AIRTABLE_TASK_HOST=${AIRTABLE_TASK_HOST}")
  fi
  if [ -n "${AIRTABLE_TASK_PORT:-}" ]; then
    env_cmd+=("AIRTABLE_TASK_PORT=${AIRTABLE_TASK_PORT}")
  fi
  if [ -n "${AIRTABLE_TASK_RATE_LIMIT_PER_MINUTE:-}" ]; then
    env_cmd+=("AIRTABLE_TASK_RATE_LIMIT_PER_MINUTE=${AIRTABLE_TASK_RATE_LIMIT_PER_MINUTE}")
  fi
  if [ -n "${AIRTABLE_TASK_GATEWAY_TIMEOUT_MS:-}" ]; then
    env_cmd+=("AIRTABLE_TASK_GATEWAY_TIMEOUT_MS=${AIRTABLE_TASK_GATEWAY_TIMEOUT_MS}")
  fi

  touch "$CHILD_LOG_FILE"
  chmod 0600 "$CHILD_LOG_FILE"
  setsid "${env_cmd[@]}" "$node_bin" "$child_script" </dev/null >>"$CHILD_LOG_FILE" 2>&1 &
  child_pid=$!
  write_pid_file "$CHILD_PID_FILE" "$child_pid"
  log "status=launch child_pid=${child_pid}"

  if [ "${stopping}" = "1" ]; then
    stop_supervisor
  fi

  wait "${child_pid}" 2>/dev/null
  child_status=$?
  log "status=exit child_pid=${child_pid} exit_code=${child_status}"

  kill -KILL -- "-${child_pid}" 2>/dev/null || true
  child_pid=""

  if [ "${stopping}" = "1" ]; then
    cleanup_and_exit
  fi

  log "status=backoff delay_s=${restart_delay_s}"
  sleep "${restart_delay_s}" &
  delay_pid=$!
  wait "${delay_pid}" 2>/dev/null || true
  delay_pid=""
  if [ "${stopping}" = "1" ]; then
    cleanup_and_exit
  fi
  restart_delay_s=$((restart_delay_s * 2))
  if [ "${restart_delay_s}" -gt 30 ]; then
    restart_delay_s=30
  fi
done

cleanup_and_exit
