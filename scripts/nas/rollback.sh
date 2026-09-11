#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：bash scripts/nas/rollback.sh <完整镜像地址:标签或@sha256:摘要>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/.env"
TARGET_IMAGE="$1"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE。" >&2
  exit 1
fi

if [[ "$TARGET_IMAGE" != ghcr.io/*:* && "$TARGET_IMAGE" != ghcr.io/*@sha256:* ]]; then
  echo "镜像地址应为 ghcr.io/所有者/仓库:标签，或使用不可变的 @sha256:摘要。" >&2
  exit 1
fi

umask 077
BACKUP_FILE="$ENV_FILE.before-rollback.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP_FILE"

TEMP_FILE="$(mktemp "${ENV_FILE}.XXXXXX")"
awk -v image="PAGE_WATCH_IMAGE=$TARGET_IMAGE" '
  BEGIN { replaced = 0 }
  /^PAGE_WATCH_IMAGE=/ { print image; replaced = 1; next }
  { print }
  END { if (!replaced) print image }
' "$ENV_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "已将镜像切换为：$TARGET_IMAGE"
echo "原配置备份于：$BACKUP_FILE"
exec bash "$ROOT_DIR/scripts/nas/update.sh"
