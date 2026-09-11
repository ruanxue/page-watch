# Page Watch

自托管网页订阅与内容变更监测工具。订阅网页地址并用 CSS Selector 提取所需元素；系统保留当前对比基准，将首次发现的内容归档。动态网页使用 Playwright 渲染。

## 本地开发

```bash
npm install
npm run dev
```

打开 `http://localhost:5173`。API 在 `http://localhost:3030`。

## Docker / NAS

本地或直接源码部署可使用下面的 Compose 文件：

```bash
docker compose up -d --build
```

打开 `http://NAS_IP:3030`。Compose 会启动网页服务、网页检查 Worker、发行日期 Worker、单线程磁力检索 Worker、qBittorrent 下载 Worker 和 Jellyfin 影视库同步 Worker。订阅、档案、发行日期、磁力检索、下载与影视库状态、运行日志保存在 MySQL；请按你的 NAS 备份策略备份 `page_watch` 数据库。

部署前请复制 `.env.example` 为 `.env`，填写 `MYSQL_HOST`、`MYSQL_DATABASE`、`MYSQL_USER` 与 `MYSQL_PASSWORD`。Docker 容器会通过这些变量连接 NAS 上已有的 MySQL，而不会自行创建数据库容器。网页服务带有 Docker 健康检查；检查、磁力检索、下载和影视库同步服务通过数据库心跳向网页报告状态，异常退出时 Docker 会自动重启它们。

### 首次访问与安全

首次打开网页会要求设置至少 12 位的访问密码；该密码使用加盐哈希保存，浏览器只持有 7 天有效的 HttpOnly 会话 Cookie。设置后，订阅、归档、日志、代理和 qBittorrent 配置接口都必须登录才能读取或修改。

如果 NAS 前面使用 HTTPS 反向代理，请在 `.env` 设置 `APP_SESSION_SECURE=true`，让会话 Cookie 仅通过 HTTPS 传输；直接使用 `http://NAS_IP:3030` 时保持默认 `false`。请不要把 Web UI 端口直接暴露到公网，建议仅限家庭局域网或经 VPN / 反向代理访问。

建议不要长期使用 MySQL `root` 账号运行网页服务。可在 NAS 的 MySQL 管理终端创建一个专用账号（将示例密码替换为强密码），然后更新 `.env` 中的 `MYSQL_USER` 和 `MYSQL_PASSWORD`：

```sql
CREATE USER 'page_watch_app'@'%' IDENTIFIED BY '请替换为强密码';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON page_watch.* TO 'page_watch_app'@'%';
FLUSH PRIVILEGES;
```

### 备份与恢复演练

建议每天从 NAS 执行一次一致性备份，并定期在临时库验证可恢复：

```bash
mysqldump --single-transaction --routines --events -h MYSQL_HOST -u page_watch_app -p page_watch > page_watch-$(date +%F).sql
```

备份文件应存放在不同于 MySQL 数据卷的位置。升级或修改抓取规则前，也建议先手动备份一次。运行日志最多保留最近 1,000 条，业务数据不会被该清理策略删除。

### 从旧版 SQLite 导入

如果仍持有旧版 SQLite 数据文件，可在首次切换前运行：

```bash
npm run migrate:mysql
```

迁移会在目标数据库为空时导入订阅、规则、内容档案、磁力状态、任务与运行日志；为防止覆盖，目标库已存在 Page Watch 数据时会停止。当前工作目录不会保留 SQLite 数据或备份。

## 网络代理

如果 NAS 无法直连某些网页，可在网页左侧的“网络代理”中填写 HTTP/HTTPS 代理，例如 `http://192.168.1.10:7890`。该设置会同时用于普通 HTML 抓取、Playwright 浏览器渲染和磁力检索。

也可在 NAS 的 `.env` 中设置 `OUTBOUND_PROXY=http://代理地址:端口`，它会覆盖网页内的设置。若代理运行在 NAS 外的另一台设备，请使用其局域网 IP；容器中的 `127.0.0.1` 指向容器自身。

本机开发时会自动使用已安装的 Chrome 或 Edge；NAS 的 Docker 镜像已自带 Chromium。若需指定其他浏览器，可设置 `PLAYWRIGHT_EXECUTABLE_PATH`。

### 推荐的 NAS 持续部署

生产 NAS 推荐使用 GitHub Actions 构建 GHCR 镜像，NAS 只拉取镜像，不在 NAS 构建源码。完整的首次部署、共享 Docker 网络、升级、回滚与内部服务通信说明见 [deploy/README.md](deploy/README.md)。

## 使用说明

1. 新建订阅，填写网页 URL 和目标 CSS Selector（例如 `.article-body` 或 `#price`）。
2. 点击“预览抽取”确认页面内容正确。
3. 保存后 worker 会按间隔检查；也可以在订阅卡片中手动触发。
4. 归档补全规则可在“检查规则”中配置：发行日期按详情页地址模板、字段标签、CSS Selector 和日期匹配式读取；旧档案也会在后台逐条补全。新增归档内容会自动进入磁力检索队列。旧档案可在订阅详情页点击“补全磁力链接”；找到后页面只显示“复制”按钮，不展示链接文本。
5. 磁力检索的节点、搜索地址模板、结果选择器、文件名前缀、详情链接与磁力值选择器均可在“检查规则”中编辑。多个节点会测速并优先使用更快节点；搜索或详情读取失败时会自动尝试下一个。可判定为临时网络故障的检查、磁力检索和下载任务会最多自动重试两次（30 秒、2 分钟）；规则、认证或配置错误会直接记录，避免反复请求。

## qBittorrent 下载

在左侧“下载设置”中填写 qBittorrent 的 Web UI 地址并选择认证方式。qBittorrent 5.2 及以上建议使用 Web UI 中生成的 API 密钥；旧版仍可使用账号和密码。保存后点击“保存并测试连接”。可选填写分类、标签和保存路径；保存路径必须是 qBittorrent 容器实际挂载的路径，例如 `/downloads`。

启用“新找到磁力链接后自动提交下载”后，后续新归档内容在磁力检索成功时会自动进入下载队列。已有内容可在内容档案中点击“提交可下载项”，也可逐条点击“下载/重试”。可选开启“下载完成后停止做种”，它仅通过 qBittorrent API 停止本网站提交且已完成的任务，不影响 qB 中的其他任务。页面始终不显示磁力链接文本；归档下载列仅显示紧凑状态：下载中显示百分比，完成显示“完成”，其余显示等待、暂停、已提交或已删除。qBittorrent 状态约每 5 秒同步一次，档案与运行日志则通过实时推送更新，页面不会再按 3 秒整表轮询。

## Jellyfin 影视库

在“下载与影视库”页面填写 Jellyfin Web 地址和 API 密钥，点击“保存并检测媒体库”后选择需要同步的库，再保存并点击“立即同步影视库”。密钥只保存于服务端，网页不会回显。同步 Worker 会按配置的间隔（默认 60 分钟）拉取所选媒体库的影片名称、原始标题和路径，在本地按 `前缀-数字` 番号匹配；内容档案会显示“已入库”“未入库”“待同步”或“同步失败”。Jellyfin 只用于判断媒体是否已经扫描入库，不会修改 Jellyfin 内的影片、元数据或文件。

初版把自动化边界控制在“订阅、提取、比较、记录”。`server/capture.ts` 是后续扩展页面登录、点击、填写、条件与通知动作的入口。
