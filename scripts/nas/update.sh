#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/.env"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.nas.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE。请先运行：bash scripts/nas/first-deploy.sh" >&2
  exit 1
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

echo "拉取 Page Watch 镜像…"
"${COMPOSE[@]}" pull

echo "启动或更新服务…"
"${COMPOSE[@]}" up -d --remove-orphans

echo
"${COMPOSE[@]}" ps
echo
echo "更新完成。若需查看启动日志："
echo "  ${COMPOSE[*]} logs -f"
