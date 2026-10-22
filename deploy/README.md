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
   - 新部署不需要设置 `APP_ENCRYPTION_KEY`；首次启动后在网页填写数据库（默认 PostgreSQL）地址、数据库名、账号和密码。只有从旧版升级时，才临时保留原 `APP_ENCRYPTION_KEY` 或 `data/app-encryption-key`，用于一次性迁移旧数据；
   - NAS 没有代理时保持 `OUTBOUND_PROXY=` 为空。

6. 将 PostgreSQL 与 Jellyfin 服务也加入 `page-watch-backend` 网络。长期方案是在各自 Compose 文件中声明这个 `external` 网络；临时检查可以使用：

   ```bash
   docker network connect page-watch-backend POSTGRES_CONTAINER_NAME
   docker network connect page-watch-backend JELLYFIN_CONTAINER_NAME
   ```

   后者在容器重建后可能失效，建议最终写进数据库、Jellyfin 的 Compose 配置。

7. 启动：

   ```bash
   bash scripts/nas/update.sh
   ```

打开 `http://NAS_LAN_IP:3030`。首次安装只需在网页填写数据库服务地址、数据库名、专用账号及密码（默认 PostgreSQL）。连接信息会以明文保存在 `data/database-bootstrap.json`，外部服务凭据会以明文保存在数据库；数据库备份也会包含这些凭据，请限制网络访问、账号权限和备份文件权限。Page Watch 只运行一个容器；容器内常驻网页 API/SSE 进程和轻量执行引擎，网页执行器（含 Chromium）与 Jellyfin 全量同步器只会在有任务时启动，并在完成/空闲后退出。任务中心仍会分别展示网页检查、发行日期、磁力检索、qBittorrent 下载和 Jellyfin 同步任务。

## 已有 PostgreSQL 部署升级

保留现有 PostgreSQL 数据库与 `data` 目录。程序只读取 `DATABASE_*` 环境变量，或带有 `driver: "postgres"` 的 version 2 引导文件；环境变量管理的连接不能在网页修改。旧 MySQL 连接、回退和搬迁工具均已删除，旧 `MYSQL_*` 变量或不明确的引导文件会被拒绝。旧的 `DB_DRIVER=postgres` 仍可读取，但已不需要配置。

若 PostgreSQL 中仍有旧版 `pwenc:v1` 外部服务凭据，请保留原 `APP_ENCRYPTION_KEY` 或 `data/app-encryption-key`。程序先验证全部密文，再用同一事务解密；原密钥缺失或错误时保留原值。此处只处理现有数据库中的凭据，不负责迁移旧引导文件。

## 内部服务地址

Page Watch 和 PostgreSQL、Jellyfin 同在 `page-watch-backend` 网络后，应使用容器服务名：

| 服务 | 在 Page Watch 中填写 |
| --- | --- |
| PostgreSQL | 在首次网页引导填写 `postgres`（实际服务名为准） |
| Jellyfin | `http://jellyfin:8096`（实际服务名为准） |
| qBittorrent（原生 NAS 服务） | `http://NAS_LAN_IP:QB_WEB_UI_PORT` |

qBittorrent 不在 Docker 中，不能填写容器服务名，也不能填写 `127.0.0.1`；后者会指向 Page Watch 容器。请确保 qB Web UI 监听 NAS 局域网地址，且仅允许 NAS/Docker 网段访问。

在网页的“下载与影视库”页，分别重新测试 qBittorrent 和 Jellyfin 连接。Jellyfin 改为内部地址后，既不会走公网，也不会绕行 NAS 的局域网 IP。

## 反向代理（lucky / Nginx）

项目支持挂在反向代理后面通过域名访问，但有三件事必须配对，否则会出现「登录后立刻掉线」「所有人都被限流」这类问题。

**1. 保持页面与接口同域。** 推荐用同一个域名、同一路径前缀反代到 `http://NAS_LAN_IP:3030`，例如 `https://pw.example.com/` 整体转发。页面与 `/api` 同源时，Cookie 与实时推送都能正常工作。如果你把页面放在 A 域名、接口反代到 B 域名，浏览器会按跨站处理，登录会失败。

**2. 在 `deploy/.env` 打开两个开关：**

```ini
# 通过 HTTPS 域名访问：让会话 Cookie 只走加密连接
APP_SESSION_SECURE=true
# 反代后面：让登录限流取到真实客户端 IP
APP_TRUST_PROXY=true
```

- 不设 `APP_TRUST_PROXY` 时，`request.ip` 永远是代理的地址，登录失败次数会被所有外网用户共享——7 次之后所有人一起被锁 10 分钟。若反代与容器不在同一台机器，可以只信任代理网段：`APP_TRUST_PROXY=172.16.0.0/12`。
- 设了 `APP_TRUST_PROXY=true` 就意味着完全信任 `X-Forwarded-For`，请确保 lucky / Nginx 会**覆盖**（而不是追加）客户端自带的该请求头，并且 3030 端口没有被直接暴露到公网。

**3. 实时推送需要关闭响应缓冲。** `/api/events` 是 SSE 长连接，项目已下发 `X-Accel-Buffering: no` 与 `Cache-Control: no-transform`。如果幸运面板里开了「响应缓冲 / 压缩 / 缓存」，请对 `/api/events` 关闭；同时把读超时放宽到 5 分钟以上，否则页面会频繁重连。

**关于两个访问入口的取舍：** 一旦 `APP_SESSION_SECURE=true`，用 `http://` 访问（含内网 IP 直连）时浏览器不会保存 Cookie，表现为「登录成功但立刻退回登录页」。这是 Secure 标志的正常行为。如果你既想外网 HTTPS 又想内网 HTTP 都能登录，可以把内网入口也套一层 HTTPS，或者内网只用 `http://NAS_LAN_IP:3030` 并从 `deploy/.env` 里去掉 `APP_SESSION_SECURE`（此时外网入口同样会失去该保护，请只在家用网络中取舍）。

**如果页面样式正常但功能全挂**，先看浏览器控制台的 CSP 报错：生产模式会下发 `Content-Security-Policy`，若反代注入了额外的脚本或统计代码，会被拦下。此时应关闭反代的脚本注入，而不是放宽 CSP。

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

升级前建议先按既有策略备份数据库（如 `pagewatch`）。若镜像升级后出现问题，在 GitHub Actions 页面或 GHCR 包页面找到上一版的 `sha-...`、`v...` 标签或摘要，再执行：

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

不要把 `.env`、GitHub 令牌、数据库密码、qBittorrent/Jellyfin API 密钥提交进 Git。`deploy/.env` 已被 `.gitignore` 排除。
