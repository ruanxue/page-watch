#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/.env"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.nas.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE。请先运行：bash scripts/nas/first-deploy.sh" >&2
  exit 1
fi

APP_ENCRYPTION_KEY="$(awk -F= '/^APP_ENCRYPTION_KEY=/ { value = $2 } END { print value }' "$ENV_FILE" | tr -d '\r')"
if [[ -z "$APP_ENCRYPTION_KEY" || "$APP_ENCRYPTION_KEY" == REPLACE_WITH_* || ! "$APP_ENCRYPTION_KEY" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
  echo "请先在 $ENV_FILE 配置 APP_ENCRYPTION_KEY（32 字节 Base64URL 主密钥）。" >&2
  echo "生成命令：node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"" >&2
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
