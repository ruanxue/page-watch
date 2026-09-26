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
   - 新部署不需要设置 `APP_ENCRYPTION_KEY`；首次启动后在网页填写 MySQL 地址、数据库名、账号和密码。只有从旧版升级时，才临时保留原 `APP_ENCRYPTION_KEY` 或 `data/app-encryption-key`，用于一次性迁移旧数据；
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

打开 `http://NAS_LAN_IP:3030`。首次安装只需在网页填写 MySQL 服务地址、数据库名、专用账号及密码。连接信息会以明文保存在 `data/database-bootstrap.json`，外部服务凭据会以明文保存在 MySQL；MySQL 备份也会包含这些凭据，请限制网络访问、账号权限和备份文件权限。Page Watch 只运行一个容器；容器内常驻网页 API/SSE 进程和轻量执行引擎，网页执行器（含 Chromium）与 Jellyfin 全量同步器只会在有任务时启动，并在完成/空闲后退出。任务中心仍会分别展示网页检查、发行日期、磁力检索、qBittorrent 下载和 Jellyfin 同步任务。

## 从旧版加密配置迁移

升级前先备份 `page_watch` 数据库和 `data` 目录，并停止旧版容器。新版启动时会使用原 `APP_ENCRYPTION_KEY` 或 `data/app-encryption-key`，先在一个 MySQL 事务中解密并迁移旧 `pwenc:v1` 设置，再把数据库连接文件原子改为 version 2 明文格式。旧密钥缺失或不正确时不会修改旧密文；保留旧密钥、修复数据库连接后再重试。

如果旧引导文件使用 `MYSQL_*` 环境变量启动，请确保环境变量连接的 MySQL 与旧 `database-bootstrap.json` 指向同一个数据库，否则新版会停止迁移且不写入文件。迁移时保留旧 NAS 使用的数据库地址，先完成迁移并确认 version 2。然后在本地新部署首次引导中填写同一个 `page_watch` 数据库的局域网地址、库名、账号和密码。若要让现有 NAS 容器改用另一台 MySQL，先备份并将完整 `page_watch` 数据库恢复到新服务器，再在 `deploy/.env` 中设置 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_DATABASE`、`MYSQL_USER` 和 `MYSQL_PASSWORD` 后重启容器；不要只改地址连到空库。`MYSQL_*` 设置会覆盖引导文件，网页不能修改这种环境变量管理的连接。迁移期间不要运行旧版容器。旧版不能读取 version 2 引导文件，而且可能将已迁移的设置重新加密。迁移完成后可从 `deploy/.env` 移除 `APP_ENCRYPTION_KEY`；不要删除 `data` 目录。若 MySQL 设置迁移成功但引导文件替换失败，保留旧密钥和备份，重启新版即可重试。可用下面的命令只查看引导文件版本，不会输出其中的连接密码：

```bash
docker exec pagewatch node -e "console.log(JSON.parse(require('fs').readFileSync('/data/database-bootstrap.json','utf8')).version)"
```

输出 `2` 表示引导文件已迁移。若原密钥永久丢失，旧密文无法解密，新版会停止迁移并保留原数据；需要恢复匹配的旧密钥，或在数据库备份后由管理员人工处理受影响的加密项。

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
