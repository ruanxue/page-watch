# Page Watch

自托管网页订阅与内容变更监测工具。订阅网页地址并用 CSS Selector 提取所需元素；系统保留当前对比基准，将首次发现的内容归档。动态网页使用 Playwright 渲染。

## 本地开发

在 Windows 上直接开发即可，不需要 WSL。请把项目放在本地磁盘目录（例如 `D:\Code\page-watch`），不要放在网络驱动器或同步盘中，否则 Playwright 和 Vite 会明显变慢。Node 版本以 [`.nvmrc`](.nvmrc) 为准。

首次安装或重新执行依赖校验时：

```powershell
npm ci
npx playwright install chromium
```

启动开发服务：

```powershell
npm run dev
```

前端通过 Vite 热更新；服务端文件变更会自动重启本地 API。要停止服务，按 `Ctrl+C`。

打开 `http://localhost:5173`。API 在 `http://localhost:3030`。

本地开发通常连接 NAS 上的同一个 PostgreSQL 库，本地引擎会直接接续 NAS 容器中的队列；任务状态只保存在数据库，因此不会重复执行，但两边会共用同一批数据与运行日志。

## 数据库回归测试

先准备 PostgreSQL 18 专用测试库，库名必须包含 `test`，测试账号需要创建临时数据库的权限。显式设置连接后运行：

```powershell
$env:PAGE_WATCH_TEST_DATABASE_URL="postgresql://测试账号:测试密码@数据库地址:5432/pagewatch_test"
npm run test:postgres
```

测试不会读取日常数据库配置作为替代连接；缺少测试连接会直接失败。每轮创建独立的临时测试库并在结束后删除，不改写提供连接的基础测试库或日常数据库。自动验证流程使用 PostgreSQL 18 测试服务。

## Docker / NAS

本地或直接源码部署可使用下面的 Compose 文件：

```bash
docker compose up -d --build
```

打开 `http://NAS_IP:3030`。Compose 只启动一个 Page Watch 容器；容器内常驻的只有网页 API/SSE 进程与轻量执行引擎。网页检查、发行日期、磁力检索与预览由按需网页执行器处理，并和 Chromium 一起在设定的空闲时间后退出；Jellyfin 全量同步同样由按需同步器分页写入 PostgreSQL。任务中心仍展示六项独立逻辑服务，订阅、档案、队列、下载与影视库状态、运行日志保存在 PostgreSQL；请按你的 NAS 备份策略备份 `pagewatch` 数据库。

部署前请复制 `.env.example` 为 `.env`。项目只支持 PostgreSQL；首次在网页填写连接信息，或使用 `DATABASE_*` 环境变量。现有明确标记为 PostgreSQL 的 version 2 引导文件可继续使用；旧 MySQL 配置、旧 `MYSQL_*` 变量和未注明类型的旧引导文件会被明确拒绝，不会误连或覆盖。连接信息保存在 `data/database-bootstrap.json`，外部服务凭据保存在数据库，请限制备份与数据目录的访问权限。健康检查使用 `/api/ready`，安装引导未完成时返回 503。

### 已有 PostgreSQL 部署升级

保留现有数据库和 `data` 目录即可。项目已移除 MySQL 运行、回退与搬迁工具。`DB_DRIVER=postgres` 可暂时保留，但其他驱动值不再接受，部署示例也不再提供此开关。

如果已搬到 PostgreSQL 的 `app_settings` 中仍有 `pwenc:v1` 凭据，保留原 `APP_ENCRYPTION_KEY` 或 `data/app-encryption-key`，新版会先验证全部密文，再在同一事务中统一解密；密钥缺失或错误时不会改写原值。该能力只处理现有 PostgreSQL 内的凭据，不迁移旧数据库引导文件。

### 首次访问与安全

首次打开网页依次要求连接数据库（默认 PostgreSQL）、设置至少 12 位的访问密码，并可选配置 Jellyfin/qBittorrent；后两者绝不会在容器启动时自动连接。该密码使用加盐哈希保存，浏览器只持有 7 天有效的 HttpOnly 会话 Cookie。设置后，订阅、归档、日志、代理和 qBittorrent 配置接口都必须登录才能读取或修改。

如果 NAS 前面使用 HTTPS 反向代理，请在 `.env` 设置 `APP_SESSION_SECURE=true`，让会话 Cookie 仅通过 HTTPS 传输；直接使用 `http://NAS_IP:3030` 时保持默认 `false`。请不要把 Web UI 端口直接暴露到公网，建议仅限家庭局域网或经 VPN / 反向代理访问。

建议不要长期使用数据库超级用户（如 `postgres`）运行网页服务。可在数据库管理终端创建一个专用账号（将示例密码替换为强密码），然后更新 `.env` 中的 `DATABASE_USER` 和 `DATABASE_PASSWORD`：

```sql
CREATE ROLE page_watch_app LOGIN PASSWORD '请替换为强密码';
GRANT CONNECT ON DATABASE pagewatch TO page_watch_app;
GRANT USAGE, CREATE ON SCHEMA public TO page_watch_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO page_watch_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO page_watch_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO page_watch_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO page_watch_app;
```

### 备份与恢复演练

建议每天从 NAS 执行一次一致性备份，并定期在临时库验证可恢复：

```bash
pg_dump -h DATABASE_HOST -U page_watch_app -d pagewatch -Fc -f pagewatch-$(date +%F).dump
```

恢复演练可用 `pg_restore -h 临时库 -U 账号 -d 库名 pagewatch-日期.dump`。备份文件应存放在不同于数据库数据卷的位置。升级或修改抓取规则前，也建议先手动备份一次。运行日志最多保留最近 1,000 条，业务数据不会被该清理策略删除。

## 网络代理

如果 NAS 无法直连某些网页，可在网页左侧的“网络代理”中填写 HTTP/HTTPS 代理，例如 `http://192.168.1.10:7890`。该设置会同时用于普通 HTML 抓取、Playwright 浏览器渲染和磁力检索。

也可在 NAS 的 `.env` 中设置 `OUTBOUND_PROXY=http://代理地址:端口`，它会覆盖网页内的设置。若代理运行在 NAS 外的另一台设备，请使用其局域网 IP；容器中的 `127.0.0.1` 指向容器自身。

本地开发使用项目版本对应的 Playwright Chromium；首次运行前执行 `npx playwright install chromium`，不要依赖系统已安装的 Chrome 或 Edge。NAS 的 Docker 镜像已自带 Chromium。若需指定其他浏览器，可设置 `PLAYWRIGHT_EXECUTABLE_PATH`。网页中的“网络代理”设置同时提供“运行性能”：默认“稳妥”模式只运行一个 MissAV 页面，浏览器空闲 10 分钟自动回收；“性能”模式最多两页并发，会增加内存和站点访问风险。运行中心会分别显示 API、执行引擎、网页执行器与 Jellyfin 同步器的内存；网页执行器显示“已回收”时，承载 Playwright/Cheerio 的 Node 进程和 Chromium 都已退出。大批任务完成后，若网页执行器和 Jellyfin 同步器均已退出、所有队列和 Worker 都持续空闲而执行引擎 RSS 仍超过回收阈值（默认 160MB，可用 `ENGINE_MEMORY_RECYCLE_THRESHOLD_MB` 调整，有效范围 64-4096），系统会先执行受控 GC；仍未回落才只重启执行引擎。网页服务自身则只做内存告警（默认 256MB，可用 `APP_MEMORY_GUARD_MB` 调整），不会因内存偏高而重启，以免中断 SSE 与登录会话。网页 API、SSE 与登录会话不中断，全部任务状态由 PostgreSQL 队列续跑。

### 推荐的 NAS 持续部署

生产 NAS 推荐使用 GitHub Actions 构建 GHCR 镜像，NAS 只拉取镜像，不在 NAS 构建源码。完整的首次部署、共享 Docker 网络、升级、回滚与内部服务通信说明见 [deploy/README.md](deploy/README.md)。

## 使用说明

1. 新建订阅，填写网页 URL 和目标 CSS Selector（例如 `.article-body` 或 `#price`）。
2. 点击“预览抽取”确认页面内容正确。
3. 保存后 worker 会按间隔检查；也可以在订阅卡片中手动触发。
4. 归档补全规则可在“检查规则”中配置：发行日期按详情页地址模板、字段标签、CSS Selector 和日期匹配式读取；旧档案也会在后台逐条补全。新增归档内容会自动进入磁力检索队列。旧档案可在订阅详情页点击“补全磁力链接”；找到后页面只显示“复制”按钮，不展示链接文本。
5. 磁力检索的节点、搜索地址模板、结果选择器、文件名前缀、详情链接与磁力值选择器均可在“检查规则”中编辑。多个节点会测速并优先使用更快节点；搜索或详情读取失败时会自动尝试下一个。可判定为临时网络故障的检查、磁力检索和下载任务会最多自动重试两次（30 秒、2 分钟）；规则、认证或配置错误会直接记录，避免反复请求。

## 通知

在左侧“通知设置”中可选择企业微信机器人、钉钉机器人或通用 Webhook 作为唯一主通知渠道。默认仅发送“发现新内容”和“任务最终失败”；“已找到磁力链接”“下载完成”可按需开启。首次建立内容历史不会发送通知；一次检查发现多条新内容时会汇总为一条，并最多列出 5 条。企业微信机器人发送纯文本，以便个人微信查看；钉钉使用 Markdown 格式。

通知地址、钉钉签名密钥和 Webhook HMAC 密钥以明文保存在数据库中，网页只显示是否已配置。业务事件先写入数据库 Outbox，发送失败会自动重试三次；相同订阅的相同最终错误会在 30 分钟内合并。通用 Webhook 使用 JSON `POST`，包含事件类型、时间、订阅、任务和条目摘要；配置 HMAC 密钥后，请用 `X-Page-Watch-Timestamp` 与 `X-Page-Watch-Signature`（`sha256=<hex>`，签名输入为 `timestamp.body`）验签。

## qBittorrent 下载

在左侧“下载设置”中填写 qBittorrent 的 Web UI 地址并选择认证方式。qBittorrent 5.2 及以上建议使用 Web UI 中生成的 API 密钥；旧版仍可使用账号和密码。保存后点击“保存并测试连接”。可选填写分类、标签和保存路径；保存路径必须是 qBittorrent 容器实际挂载的路径，例如 `/downloads`。

启用“新找到磁力链接后自动提交下载”后，后续新归档内容在磁力检索成功时会自动进入下载队列。已有内容可在内容档案中点击“提交可下载项”，也可逐条点击“下载/重试”。可选开启“下载完成后停止做种”，它仅在 qBittorrent 报告进度为 100% 且已进入做种状态后，才通过 API 停止本网站提交的任务，不影响 qB 中的其他任务。页面始终不显示磁力链接文本；归档下载列仅显示紧凑状态：下载中显示百分比，完成显示“完成”，其余显示等待、暂停、已提交或已删除。qBittorrent 状态约每 5 秒同步一次，档案与运行日志则通过实时推送更新，页面不会再按 3 秒整表轮询。

## Jellyfin 影视库

在“下载与影视库”页面填写 Jellyfin Web 地址和 API 密钥，点击“保存并检测媒体库”后选择需要同步的库，再保存并点击“立即同步影视库”。密钥只保存于服务端，网页不会回显。点击同步会立即返回“已加入同步队列”，读取媒体库、建立索引与批量写入进度在运行中心实时显示。同步器按配置间隔（默认 60 分钟）拉取所选媒体库的完整快照，按页写入 PostgreSQL；新归档及后续匹配都只查询本地索引，不会逐条访问 Jellyfin。内容档案会显示“已入库”“未入库”“待同步”或“同步失败”。Jellyfin 只用于判断媒体是否已经扫描入库，不会修改 Jellyfin 内的影片、元数据或文件。

初版把自动化边界控制在“订阅、提取、比较、记录”。`server/capture.ts` 是后续扩展页面登录、点击、填写、条件与通知动作的入口。
首次安装或重新执行依赖校验时：


```bash
首次安装或重新执行依赖校验时：

```bash
