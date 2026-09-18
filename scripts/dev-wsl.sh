#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "未找到 NVM：$NVM_DIR/nvm.sh。请先在 WSL 中安装 NVM 和 Node $(<"$ROOT_DIR/.nvmrc")。" >&2
  exit 1
fi

# The Codex desktop command runner and other automation shells are often
# non-interactive, so they do not source ~/.bashrc and would otherwise pick up
# a Windows Node installation inherited through WSL's PATH.
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
cd "$ROOT_DIR"
nvm use --silent
exec npm run dev
