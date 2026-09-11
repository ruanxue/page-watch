#!/usr/bin/env bash
set -Eeuo pipefail

# Run this script from the NAS task scheduler.  It has Docker access on the
# host; Page Watch only exchanges a small status file and an update request
# with it, so the web container never receives the Docker socket.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/.env"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.nas.yml"
STATE_DIR="$ROOT_DIR/deploy/update-state"
STATUS_FILE="$STATE_DIR/status.json"
REQUEST_FILE="$STATE_DIR/update-request.json"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE，请先完成 Page Watch 部署。" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/.update-check.lock"
  flock -n 9 || exit 0
fi

write_status() {
  local phase="$1"
  local available="$2"
  local message="$3"
  local temporary="$STATUS_FILE.tmp"
  printf '{"checkedAt":"%s","phase":"%s","updateAvailable":%s,"message":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$phase" "$available" "$message" > "$temporary"
  mv "$temporary" "$STATUS_FILE"
  chmod 600 "$STATUS_FILE"
}

IMAGE="$(awk -F= '/^PAGE_WATCH_IMAGE=/ { value = substr($0, index($0, "=") + 1) } END { print value }' "$ENV_FILE" | tr -d '\r')"
if [[ -z "$IMAGE" ]]; then
  write_status failed false '未配置 Page Watch 镜像地址。'
  exit 1
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
write_status idle false '正在检查新版本。'

if ! "${COMPOSE[@]}" pull; then
  write_status failed false '无法检查或拉取 GHCR 镜像。'
  exit 1
fi

CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' pagewatch 2>/dev/null || true)"
TARGET_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
if [[ -z "$TARGET_IMAGE_ID" ]]; then
  write_status failed false '已完成拉取，但无法读取镜像信息。'
  exit 1
fi

if [[ "$CURRENT_IMAGE_ID" == "$TARGET_IMAGE_ID" ]]; then
  rm -f "$REQUEST_FILE"
  write_status idle false '已是最新版本。'
  exit 0
fi

if [[ -f "$REQUEST_FILE" ]]; then
  write_status applying true '正在安装新版本，Page Watch 将短暂重启。'
  if ! "${COMPOSE[@]}" up -d --force-recreate --remove-orphans; then
    write_status failed true '新版本启动失败；当前镜像仍可在 Docker 中检查。'
    exit 1
  fi
  rm -f "$REQUEST_FILE"
  write_status completed false '新版本已启动。'
else
  write_status ready true '发现新版本，等待从网页确认安装。'
fi
