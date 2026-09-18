# NAS 镜像部署

这套部署文件不在 NAS 构建源码。GitHub Actions 在每次推送 `main` 后构建 `linux/amd64` 单容器镜像并发布到 GitHub Container Registry（GHCR）；NAS 只拉取已验证的镜像。

## 一次性准备

1. 在 GitHub 创建一个**私有**空仓库，并把本项目推送到 `main` 分支。
2. 打开仓库的 **Actions** 页面，等待 `Build and publish Page Watch image` 成功。首次成功后会出现 GHCR 软件包和 `stable` 标签。
3. 在 NAS 安装 Git、Docker 和 Docker Compose，然后克隆仓库：

   ```bash
   git clone git@github.com:YOUR_GITHUB_OWNER/YOUR_REPOSITORY.git /volume1/docker/page-watch
   cd /volume1/docker/page-watch
   ```

   如果未配置 SSH Deploy Key，也可以用 HTTPS 克隆；建议为 NAS 单独创建只读 Deploy Key，不要把个人 GitHub 密码或写权限令牌留在 NAS。

4. 私有 GHCR 镜像需要 NAS 登录一次。创建一个只带 `read:packages` 权限的 GitHub Personal Access Token (classic)，然后执行：

   ```bash
   echo 'TOKEN_VALUE' | docker login ghcr.io -u YOUR_GITHUB_OWNER --password-stdin
   ```

   令牌只由 Docker 保存，用于拉取私有镜像；不要放进 `deploy/.env`、代码仓库或 Page Watch 数据库。

5. 运行首次初始化：

   ```bash
   bash scripts/nas/first-deploy.sh
   ```

   它会创建 `page-watch-backend` 共享网络和 `deploy/.env`。编辑 `deploy/.env`：

   - `PAGE_WATCH_IMAGE` 改成实际 GHCR 地址，例如 `ghcr.io/your-name/page-watch:stable`；
   - 个人部署可将 `APP_ENCRYPTION_KEY` 留空；服务会在 `data/app-encryption-key` 自动生成并持久保存密钥。高级部署可自行填写 32 字节 Base64URL 密钥，后续升级必须保持不变；
   - NAS 没有代理时保持 `OUTBOUND_PROXY=` 为空。

6. 将 MySQL 与 Jellyfin 服务也加入 `page-watch-backend` 网络。长期方案是在各自 Compose 文件中声明这个 `external` 网络；临时检查可以使用：

   ```bash
   docker network connect page-watch-backend MYSQL_CONTAINER_NAME
   docker network connect page-watch-backend JELLYFIN_CONTAINER_NAME
   ```

   后者在容器重建后可能失效，建议最终写进 MySQL、Jellyfin 的 Compose 配置。

7. 启动：

   ```bash
   bash scripts/nas/update.sh
   ```

打开 `http://NAS_LAN_IP:3030`。首次安装先在网页填写 MySQL 服务地址、数据库名、专用账号及密码；验证与建表成功后，连接信息会经 `APP_ENCRYPTION_KEY` 加密保存至项目的 `data/database-bootstrap.json`，不会随镜像升级丢失。Page Watch 只运行一个容器；容器内常驻网页 API/SSE 进程和轻量执行引擎，网页执行器（含 Chromium）与 Jellyfin 全量同步器只会在有任务时启动，并在完成/空闲后退出。任务中心仍会分别展示网页检查、发行日期、磁力检索、qBittorrent 下载和 Jellyfin 同步任务。

## 内部服务地址

Page Watch 和 MySQL、Jellyfin 同在 `page-watch-backend` 网络后，应使用容器服务名：

| 服务 | 在 Page Watch 中填写 |
| --- | --- |
| MySQL | 在首次网页引导填写 `mysql`（实际服务名为准） |
| Jellyfin | `http://jellyfin:8096`（实际服务名为准） |
| qBittorrent（原生 NAS 服务） | `http://NAS_LAN_IP:QB_WEB_UI_PORT` |

qBittorrent 不在 Docker 中，不能填写容器服务名，也不能填写 `127.0.0.1`；后者会指向 Page Watch 容器。请确保 qB Web UI 监听 NAS 局域网地址，且仅允许 NAS/Docker 网段访问。

在网页的“下载与影视库”页，分别重新测试 qBittorrent 和 Jellyfin 连接。Jellyfin 改为内部地址后，既不会走公网，也不会绕行 NAS 的局域网 IP。

## 日常发布与升级

电脑开发完成后：

```bash
git add .
git commit -m "说明本次变更"
git push origin main
```

等待 GitHub Actions 的验证、构建与发布成功，再在 NAS 运行：

```bash
cd /volume1/docker/page-watch
git pull --ff-only
bash scripts/nas/update.sh
```

`stable` 指向最后一次 `main` 的成功构建；每次构建还会有不可变的 `sha-<提交哈希>` 标签。发布正式版本可在电脑执行：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 回滚

升级前建议先按既有策略备份 MySQL 的 `page_watch` 数据库。若镜像升级后出现问题，在 GitHub Actions 页面或 GHCR 包页面找到上一版的 `sha-...`、`v...` 标签或摘要，再执行：

```bash
cd /volume1/docker/page-watch
bash scripts/nas/rollback.sh ghcr.io/YOUR_GITHUB_OWNER/YOUR_REPOSITORY:sha-PASTE_COMMIT_SHA_HERE
```

脚本会备份当前 `deploy/.env`，持久地切换 `PAGE_WATCH_IMAGE` 后拉取并重启容器。推荐在确认稳定的版本上使用 `@sha256:...` 摘要，以避免标签变动。

## 常用诊断命令

```bash
docker network inspect page-watch-backend
docker compose --env-file deploy/.env -f deploy/docker-compose.nas.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.nas.yml logs -f app
```

不要把 `.env`、GitHub 令牌、MySQL 密码、qBittorrent/Jellyfin API 密钥提交进 Git。`deploy/.env` 已被 `.gitignore` 排除。
