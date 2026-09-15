#!/bin/sh
set -eu

# The production supervisor intentionally stays a tiny POSIX shell. Keeping a
# third Node process alive solely to supervise API/runner was measurable on a
# small NAS, while Docker+tini already handle PID 1 and signal delivery.
export WORKER_EVENT_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export WORKER_EVENT_URL="${WORKER_EVENT_URL:-http://127.0.0.1:${PORT:-3030}}"
export RUNNER_INTERNAL_PORT="${RUNNER_INTERNAL_PORT:-3031}"

api_pid=''
runner_pid=''
runner_not_before=''
stopping=0

start_api() {
  node build/server/index.js &
  api_pid=$!
  echo "[主管理器] 已启动：网页服务（PID ${api_pid}）"
}

start_runner() {
  if [ -n "$runner_not_before" ]; then
    ENGINE_MEMORY_RECYCLE_NOT_BEFORE="$runner_not_before" node --expose-gc build/server/runner.js &
  else
    node --expose-gc build/server/runner.js &
  fi
  runner_pid=$!
  echo "[主管理器] 已启动：统一执行引擎（PID ${runner_pid}）"
}

stop_all() {
  [ "$stopping" = 1 ] && return
  stopping=1
  echo "[主管理器] 正在停止 Page Watch。"
  [ -n "$api_pid" ] && kill -TERM "$api_pid" 2>/dev/null || true
  [ -n "$runner_pid" ] && kill -TERM "$runner_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  wait "$runner_pid" 2>/dev/null || true
  exit 0
}

trap stop_all INT TERM

echo '[主管理器] Page Watch 单容器模式已启动。'
start_api
start_runner

while :; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    code=0
    wait "$api_pid" || code=$?
    echo "[主管理器] 网页服务已退出（退出码 ${code}），容器将交由 Docker 重启。" >&2
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
    exit "$code"
  fi
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    code=0
    wait "$runner_pid" || code=$?
    if [ "$code" -eq 75 ]; then
      runner_not_before="$(date -u -d '+30 minutes' '+%Y-%m-%dT%H:%M:%S.000Z')"
      echo '[主管理器] 统一执行引擎已完成空闲内存回收，1 秒后恢复。'
      sleep 1
    else
      echo "[主管理器] 统一执行引擎已退出（退出码 ${code}），5 秒后重启。" >&2
      sleep 5
    fi
    start_runner
  fi
  sleep 1
done
