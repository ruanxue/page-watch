#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/.env"

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 Docker，请先在 NAS 安装并启用 Docker Compose。" >&2
  exit 1
fi

CREATED_ENV=false
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT_DIR/deploy/.env.nas.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  CREATED_ENV=true
fi

NETWORK_NAME="$(awk -F= '/^PAGE_WATCH_NETWORK=/ { value = $2 } END { print value }' "$ENV_FILE" | tr -d '\r')"
NETWORK_NAME="${NETWORK_NAME:-page-watch-backend}"

if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "创建共享 Docker 网络：$NETWORK_NAME"
  docker network create "$NETWORK_NAME"
fi

if [[ "$CREATED_ENV" == true ]]; then
  echo "已创建 $ENV_FILE。请先编辑其中的镜像地址，再运行："
  echo "  bash scripts/nas/update.sh"
  exit 0
fi

echo "共享网络已就绪，配置文件已存在。"
echo "运行以下命令拉取并启动服务："
echo "  bash scripts/nas/update.sh"
