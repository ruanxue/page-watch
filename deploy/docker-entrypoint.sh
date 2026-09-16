#!/bin/sh
set -eu

# The production supervisor intentionally stays a tiny POSIX shell. Keeping a
# third Node process alive solely to supervise API/runner was measurable on a
# small NAS, while Docker+tini already handle PID 1 and signal delivery.
export WORKER_EVENT_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export WORKER_EVENT_URL="${WORKER_EVENT_URL:-http://127.0.0.1:${PORT:-3030}}"
export RUNNER_INTERNAL_PORT="${RUNNER_INTERNAL_PORT:-3031}"

api_pid=''
stopping=0

start_api() {
  node build/server/index.js &
  api_pid=$!
  echo "[主管理器] 已启动：网页服务（PID ${api_pid}）"
}

stop_all() {
  [ "$stopping" = 1 ] && return
  stopping=1
  echo "[主管理器] 正在停止 Page Watch。"
  [ -n "$api_pid" ] && kill -TERM "$api_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  exit 0
}

trap stop_all INT TERM

echo '[主管理器] Page Watch 单容器模式已启动。'
start_api

while :; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    code=0
    wait "$api_pid" || code=$?
    echo "[主管理器] 网页服务已退出（退出码 ${code}），容器将交由 Docker 重启。" >&2
    exit "$code"
  fi
  sleep 1
done
