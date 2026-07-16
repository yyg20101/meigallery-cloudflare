# Cloudflare 部署说明

## 1. 架构概览

本项目完全基于 Cloudflare Workers 部署，不使用 Cloudflare Pages。

| 组件 | 服务 | 说明 |
|------|------|------|
| 前端 | `meigallery-web` Worker | Nuxt 4 + Nitro `cloudflare-module` + Workers Assets 静态资源托管 |
| API | `meigallery-api` Worker | Hono 框架，独立 Worker |
| 数据库 | D1（`meigallery-db`） | 结构化数据存储 |
| 存储 | R2（`meigallery-media`） | 图片、导入包、缩略图 |
| 视频 | Cloudflare Stream | 当前未接入；作为后续视频上传、编码、播放和访问控制目标 |
| 人机验证 | Turnstile | 登录、注册等关键操作保护 |

## 2. 域名结构

- `616618.xyz` → Web Worker（前台 + 后台管理）
- `api.616618.xyz` → API Worker
- Dev 测试入口使用 Workers dev 子域。当前真实 dev 地址为 `https://meigallery-web-dev.wajie.workers.dev` 和 `https://meigallery-api-dev.wajie.workers.dev`，不绑定生产主域。

配置步骤：

1. 将域名接入 Cloudflare DNS。
2. 在 Workers 设置中绑定自定义域名（Custom Domains）。
3. 开启 HTTPS，使用 Cloudflare 自动证书。

## 3. 部署命令

本项目使用 pnpm workspace，统一通过 `corepack pnpm` 调用仓库锁定的 pnpm 版本。

```bash
# 首次初始化
./scripts/setup.sh

# 生产部署（唯一允许的 production migration / Worker 发布入口）
# 重要警告：生产环境中，当待发布包含 0017_cases_cleanup.sql 时，禁止直接运行一键部署。
# 必须先完成本地或 CI 构建预检，再按“R2 Cases 对象迁移”专项顺序完成
# dry-run、复制和目标对象验证，然后才执行 D1 remote migration 和部署。
./scripts/deploy.sh production

# release PR 前运行完整验证；production 脚本不会再次重复整套 release 验证
corepack pnpm verify:release

# production Contract 待执行时可单独生成仓库外 D1 备份
corepack pnpm backup:production

# 部署后只读复核
node scripts/verify-release.mjs assert-production-attribution
node scripts/verify-release.mjs assert-production-identity
corepack pnpm verify:seo:production
```

禁止单独执行 remote D1 migration。根目录和 API package 的 `db:migrate:remote` 均会以 `PRODUCTION_MIGRATION_REQUIRES_DEPLOY_SCRIPT` 失败，避免绕过备份、Worker 切换和部署后健康校验形成半完成状态。

## 4. CI/CD

**手动部署**：生产部署只通过 `./scripts/deploy.sh production` 执行。完整测试、覆盖率、类型检查、Playwright 和构建由 release PR/CI 先完成；脚本在干净 `main` 上只执行一次 `verify:quick`，随后完成必要备份、migration、API/Web 部署、通用归因状态校验和 smoke，不再重复执行 `verify:release`。GitHub Actions 不负责生产部署。

```bash
# 已通过 PR 合入 main 后执行生产发布。
./scripts/deploy.sh production
corepack pnpm verify:seo:production
# 已知生产站点名称和 SEO 标题时，建议显式写入期望值，避免 API 与 Web 同时回退默认标题仍误判通过。
corepack pnpm verify:seo:production -- --expect-site-name 星耀传媒 --expect-title 星耀传媒 --expect-description "用专业服务点亮每一次相遇."
```

部署后 SEO 校验会读取 `/api/settings/public`，并检查 `616618.xyz` 与 `www.616618.xyz` 首页 SSR 原始 HTML 的 `<title>`、description 和 OG 信息是否与后台站点设置一致。若 API 已返回新设置但首页 `<head>` 仍显示旧默认值，说明 Web Worker 未部署到最新版本或边缘仍在返回旧 HTML，必须在上线验收中阻断。若 `/api/settings/public` 本身未返回后台保存的新值，优先确认 API Worker 已部署包含站点设置 upsert 的版本，并检查 `site_settings` 缺失行是否已由后台保存动作补齐。

## 5. 发布验证分层

发布验证分为四层，避免所有场景都跑同一套重验证：

| 命令 | 使用场景 | 说明 |
|------|----------|------|
| `corepack pnpm verify:quick` | 日常开发、提交前快速自检 | 执行依赖、Lint、资源隔离、测试、类型检查、构建和 Worker dry-run。 |
| `corepack pnpm verify:local-runtime` | 需要验证 Worker 本地运行时、D1/Queue/归因降级链路时 | 在本机 Cloudflare 兼容运行时做链路验证，不依赖远端 dev 域名。 |
| `corepack pnpm verify:dev-rehearsal` | 上线前的 dev 环境演练 | 依赖独立 dev 资源与 dev Workers URL，验证 remote migration、dev 部署和核心 smoke。运行前需设置 `VERIFY_DEV_API_URL`、`VERIFY_DEV_WEB_URL`。 |
| `corepack pnpm verify:release` | 生产部署前最终放行 | 在干净工作区串联前述验证并生成 `mode=release` 报告，供生产 gate 校验。 |

### 生产放行要求

- release PR/CI 必须先完成完整测试、类型检查、构建、迁移 fixture 和三平台隔离验证；生产脚本不以重复执行整套门禁代替 CI。
- production 只允许从干净的 `main` 执行，脚本为 API/Web 注入同一 `RELEASE_COMMIT`，部署后必须通过 identity 校验。
- `0052` 待应用时，脚本自动执行 `verify:quick -> D1 export + Time Travel bookmark -> migration -> API/Web -> 通用归因健康校验 -> smoke`；Contract guard 不满足时 D1 migration 整体失败。
- `0052` 已应用后的普通发布跳过迁移前 D1 备份，不重复历史回填或平台测试事件。
- production 必须预先存在 `meigallery-ad-meta`、`meigallery-ad-meta-dlq`、`meigallery-ad-tiktok`、`meigallery-ad-tiktok-dlq`、`meigallery-ad-google`、`meigallery-ad-google-dlq`；使用 `./scripts/setup.sh production` 幂等创建。
- `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 必须是 32 字节随机值的标准 Base64，并通过 `openssl rand -base64 32 | wrangler secret put ...` 或交互式 `wrangler secret put` 配置；previous 仅在主密钥轮换窗口存在。Secret 值不得进入命令参数、文档、报告或日志。
- 部署后门禁要求 `0052`、`0053` 已应用且全局地区策略存在，启用的 production 连接有当前验证、无 critical incident、无过期 Outbox、无 dead letter 且 rollout 一致。
- 部署脚本不修改平台 enabled、mode、rollout、凭证或验证证据，也不调用 Meta、TikTok 或 Google Ads 事件 API。

### 广告平台 schema 契约

- `0051` 已创建最终 11 张 `attribution_*` 表并完成 production 事实回填。
- `0052` 在 facts 覆盖完整、旧 Server delivery 静止和旧 Outbox 为空时，迁移 Meta 质量历史并删除旧表、旧列和 bridge trigger。
- `0052` 是不可回退到旧 Worker 的 Contract 边界；发布前必须已有 D1 export、Time Travel bookmark 和可用的前一版本 Worker 产物。
- Contract 后应用和运维脚本只允许访问 `attribution_*` 表，不保留双读、双写或旧平台 fallback。

### 推荐执行顺序

1. 日常开发或文档更新后运行 `corepack pnpm verify:quick`。
2. 涉及 Worker 运行时、D1、Queue、归因或发布链路改动时，再运行 `corepack pnpm verify:local-runtime`。
3. 准备上线时设置：

```bash
export VERIFY_DEV_API_URL=https://meigallery-api-dev.wajie.workers.dev
export VERIFY_DEV_WEB_URL=https://meigallery-web-dev.wajie.workers.dev
corepack pnpm verify:dev-rehearsal
```

4. PR 合入 `main` 后，切到最新 `main` 的待发 commit，在干净工作区运行：

```bash
export VERIFY_DEV_API_URL=https://meigallery-api-dev.wajie.workers.dev
export VERIFY_DEV_WEB_URL=https://meigallery-web-dev.wajie.workers.dev
corepack pnpm verify:release
./scripts/deploy.sh production
```

### 数据分析上线顺序

站内一方数据分析默认关闭，`site_settings.analytics_enabled=false` 时 Web SDK 不初始化 visitor/session，API 采集接口返回 disabled 且不写 D1。生产启用必须按以下顺序执行：

1. 执行 D1 migrations，确保 `0023_analytics_core.sql` 到 `0026_analytics_exports.sql` 已应用到目标环境。
2. 部署 API Worker，使 `/api/analytics/events`、`/api/analytics/session/end`、`/api/invites/:code/status`、`/api/admin/analytics/*` 和 `/api/admin/invite-codes` 先可用。
3. 部署 Web Worker，此时公开设置仍关闭，前端 SDK 不应初始化或写本地存储。
4. 登录后台确认 `/admin/analytics`、来源、内容、链路、点击、时长、邀请和健康页能加载空数据或聚合数据，并展示 D1 usage。
5. Owner 在后台设置中打开 `analytics_enabled`，必要时调整 `analytics_sample_rate`，再观察采集健康日报、Worker Logs 和 D1 rows read/write。

上线前必须通过以下验证：

- API 性能成本 fixture：10,000 sessions/day、平均 3 PV/session、2 clicks/session 时 D1 rows written <= 80,000/day。
- 后台报表 fixture：100,000 事件规模下总览、来源、页面、点击、时长和邀请 6 个接口 30 天范围 P95 <= 1 秒，且默认查询不扫描 `analytics_events`。
- Playwright smoke：`首页 -> 搜索 -> 图库详情 -> 打开联系 -> 点击联系方式 -> 带 invite 注册页`，mock API 收到 page、click/contact、invite 和 register 事件，payload 不含 token、api key、联系值、私有 R2 key 或完整敏感 URL。

### 数据分析回滚顺序

数据分析异常时优先回滚开关，不优先回滚 schema：

1. Owner 关闭 `analytics_enabled`。
2. 确认新打开页面不初始化 Web SDK，不再创建 visitor/session 队列。
3. 向 `/api/analytics/events` 发送旧页面缓存事件，确认 API 返回 `{ disabled: true }` 且 D1 rows written 不增加。
4. 如需回滚 Web Worker，保留 API Worker 的采集接口兼容旧缓存页面；旧页面继续发送事件时只收到 disabled 响应。
5. 如需回滚 API Worker，先确认 Web 已关闭采集并清空前端入口，再部署 API 旧版本；不要删除已经应用的 D1 migration，除非有单独的数据库回滚方案和备份。

达到以下任一阈值时进入 Phase 9 规模增强评估，而不是临时放宽当前预算：采集接口 P95 > 300ms 且主要耗时来自 D1 写入；或 D1 rows written 超过 80,000/day 的 80% 连续 3 天。Phase 9 才评估 Cloudflare Queues 批处理和 Workers Analytics Engine；评估前必须重新核对 Cloudflare 官方 limits、pricing、batching、retry 和 retention 文档。

### Meta 正式投放上线顺序

Meta 正式事件仅为 `Contact`、`CompleteRegistration`。`attribution_conversion_facts` 是唯一事实源，Pixel / CAPI 只是同步渠道，关闭或失败都不得阻断站内转化记账。

Dataset Quality 使用 production Dataset，由通用 collector 每日写入 `attribution_quality_snapshots`。dev 不配置 CAPI token、不采集或伪造 production 质量快照。

后台与证据的状态口径必须严格区分：Pixel `attempted` 只表示浏览器已按服务端指令尝试调用，**不代表 Meta 已接收**；只有 CAPI delivery 为 `accepted` 且 Graph API 返回 `events_received=1`，才可表述为 Meta 已接收。两项正式事件的 Browser/Server 同 ID 与 Meta 去重结果，必须由 Owner 在 Events Manager 中确认并生成脱敏 live evidence。

Test Event Code 仅由 Owner 在 `/admin/attribution/platforms?provider=meta` 的当次验证请求中提交；服务端不持久化、不审计、不回显。production CAPI payload 绝不携带 `test_event_code`。Meta 使用 `meigallery-ad-meta` / `meigallery-ad-meta-dlq`，Token 由统一后台写入 D1 加密凭证库。

正式发布必须按下列顺序完成：

1. 在 release 分支完成 migration 演练、测试、类型检查、构建和 Worker dry-run，通过 GitHub CI 后以 PR 合入 `main`。
2. 执行 `./scripts/setup.sh production`，确认通用 Queue 和凭证主密钥存在。
3. 在干净 `main` 执行 `./scripts/deploy.sh production`；部署不修改 Meta mode、开关、rollout 或凭证。
4. 在统一后台保存 Pixel ID、CAPI Token 和两项事件映射，保持 rollout `0` 后启动连接验证。
5. 在 Events Manager 确认 Contact / CompleteRegistration 的 Browser/Server 同 ID 去重和增强匹配。
6. 验证通过后由 Owner 从 `0 -> 10 -> 50 -> 100` 人工放量，每级观察质量、积压、dead letter 和 incident。

### Meta 回滚顺序

优先回滚运行开关，不删除 Queue、DLQ、secret、D1 表或已应用 migration：

1. Owner 先将 `attribution_platform_connections.rollout_target_percentage` 降为 `0` 并关闭 Server，停止创建新的 CAPI delivery；站内事实继续写入。
2. 将连接 mode 切回 `disabled`，阻止新的 Meta Browser/Server delivery。
3. 如需进一步停止浏览器侧调用，再关闭 Browser；不要把 Pixel `attempted` 误读为接收量。
4. Queue 或外部失败异常时记录 backlog、DLQ、failed 原因并暂停投递；修复后先在 `test` mode 重做 Owner Test Event，再依序恢复 production mode 与 CAPI 开关。
5. 如必须回退 Worker，先完成前述关闭态，再部署旧版本；保留 schema 和 delivery 账本用于核对损失窗口与恢复验证。

### TikTok Pixel / Events API 上线顺序

TikTok 与 Meta 共享通用事实和投递状态机，但不共享 Queue、凭证、连接 revision 或 rollout。代码部署不会自动启用 TikTok；TikTok 使用 `meigallery-ad-tiktok` / `meigallery-ad-tiktok-dlq`，Access Token 由统一后台写入加密凭证库。

上线顺序固定为：

1. 本地通过 migration `0001..0053`、API/Web 测试、类型检查、Nuxt production build 和 Worker dry-run。
2. 通过 `./scripts/setup.sh production` 确认统一 Queue；dev/local 不创建或绑定真实广告平台资源。
3. 在 `/admin/attribution/platforms?provider=tiktok` 保存 Pixel ID 与 Access Token，保持 Server 关闭且 rollout `0`。
4. 在 TikTok Events Manager 打开 Test Events，输入当次 Test Event Code 后点击“验证 Events API”。API 每次都会发送新的 `Contact` 与 `CompleteRegistration` 测试事件；连接身份未变化时复用现有 revision，不改写验证状态。Test Event Code 不写入 D1、审计或长期 secret，审计日志只记录发送数量、验证状态与 revision。
5. 确认两项服务器测试事件均被接收，且 `Contact` 不携带注册身份，`CompleteRegistration` 包含允许的匹配标识。连接身份变化后必须重新验证。
6. 先开启 Browser Pixel 并观察，再开启 Server API，从 `10%` 开始人工放量；后台按 TikTok 平台查看 Pixel、Server API、失败、等待、重试耗尽及 `_ttp/ttclid` 覆盖。
7. 在 TikTok Events Manager 检查 Browser / Server 使用相同 event name 与 event ID 后的去重结果。未确认去重前不得提高到 `50%` 或 `100%`。

后台切换到 TikTok 后只显示 TikTok 配置和发布检查，逐项核对 Pixel ID、Access Token、Queue、数据密钥、连接验证、Browser Pixel、Events API 与 rollout；Meta incident 和 CAPI rollout 不参与 TikTok 放量判断。

回滚时先关闭 TikTok `server_enabled` 并将 rollout 降为 `0`，再把 mode 切为 `disabled`，最后按需关闭 Browser Pixel。保留 Queue、DLQ、D1 delivery 和加密 outbox 用于诊断，不删除已应用 migration。

### Google Ads Tag / Data Manager API 上线顺序

Google 与 Meta、TikTok 共用标准事实，但只消费 Google click ID、签名投放链接或明确 Google Ads 来源。Google 使用独立 `meigallery-ad-google` / `meigallery-ad-google-dlq`；不接入 GA4，不需要 Developer Token。

1. 在 Google Cloud 启用 Data Manager API，为 Service Account 配置 Service Usage Consumer，并在 Google Ads 中授予对应账户权限。
2. 分别为 Contact、CompleteRegistration 创建 Google Ads 网站转化操作，取得各自 `AW-.../label` 与 `WEBPAGE` Conversion Action ID。
3. 在 `/admin/attribution/platforms?provider=google` 原子保存 Tag ID、Customer ID、Cloud Project ID、两个事件绑定和 Service Account JSON，保持 Server 关闭且 rollout `0`。
4. 运行 `validateOnly` 连接验证；Tag Assistant 确认浏览器事件的 `send_to`、`transaction_id` 与当前 Google 连接一致。
5. 开启 Server 后只从 `10%` 开始。Data Manager HTTP 2xx 返回安全 `requestId` 才进入 `accepted`；Cron 最早 30 分钟后查询 `requestStatus.retrieve`，最终成功才进入 `processed`。Free 计划下每次 Cron 最多处理 40 条，给 50 个外部 subrequest 上限保留安全余量。
6. 观察 `processed/rejected`、diagnostic timeout、DLQ、incident 和容量后再按 `10 -> 50 -> 100` 人工放量。Google 不使用 Test Event Code。

回滚时先将 Google Server rollout 降为 `0` 并关闭 Server，再按需关闭 Browser Tag；已 `accepted` 的请求仍保留异步诊断，避免丢失最终状态。

## 6. 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `SESSION_SECRET` | API Worker secret | 会话签名密钥 |
| `TURNSTILE_SECRET_KEY` | API Worker secret | Turnstile 验证密钥 |
| `STREAM_ACCOUNT_ID` | API Worker secret | Cloudflare Stream 账户 ID |
| `STREAM_API_TOKEN` | API Worker secret | Stream API 令牌 |
| `CORS_ORIGIN` | API Worker vars | 前端域名（如 `https://616618.xyz`） |
| `IMAGE_RESIZING_ENABLED` | API Worker vars | 是否启用 Cloudflare Images Transformations；启用前需在 Dashboard 打开 Images > Transformations |
| `IMPORT_TOKEN_DAILY_LIMIT` | API Worker vars | 单个 Import Token 每日可创建的外部导入记录上限，未设置时 API 默认 100 |
| `TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>` | API Worker secret | Telegram 外部导入拉取 file_id 所需 Bot Token，例如 `ops_gallery_bot` 对应 `TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT` |
| `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` | API Worker secret | 通用平台凭证库和 Outbox 的当前主密钥；production 必填 |
| `AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS` | API Worker secret | 仅统一主密钥轮换窗口使用 |
| `NUXT_PUBLIC_API_BASE_URL` | Web Worker vars | API 地址（如 `https://api.616618.xyz`） |

设置 secret：

```bash
corepack pnpm --filter @meigallery/api exec wrangler secret put SESSION_SECRET
corepack pnpm --filter @meigallery/api exec wrangler secret put TURNSTILE_SECRET_KEY
corepack pnpm --filter @meigallery/api exec wrangler secret put STREAM_ACCOUNT_ID
corepack pnpm --filter @meigallery/api exec wrangler secret put STREAM_API_TOKEN
corepack pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT
# 如有独立案例导入 Bot：
corepack pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_CASE_BOT
openssl rand -base64 32 | corepack pnpm --filter @meigallery/api exec wrangler secret put AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT --env=""
# 仅统一主密钥轮换窗口执行：
corepack pnpm --filter @meigallery/api exec wrangler secret put AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS --env=""
```

## 7. Cloudflare 产品绑定

### Zone/Account 信息

- Account ID: `32b73e607476d0224c7ca40d28be1120`
- Zone ID: `2f7f49183fa463345e09432719af2c7d`（616618.xyz，Free 计划）
- D1 Database ID: `714929cb-003b-4cb1-bd9f-545fa1895e8c`
- R2 Bucket: `meigallery-media`
- Queue: `meigallery-ad-meta` / `meigallery-ad-meta-dlq`
- Queue: `meigallery-ad-tiktok` / `meigallery-ad-tiktok-dlq`
- Queue: `meigallery-ad-google` / `meigallery-ad-google-dlq`
- D1 Database（dev）: `meigallery-db-dev`
- R2 Bucket（dev）: `meigallery-media-dev`

### Dev 环境

- `meigallery-api-dev` / `meigallery-web-dev`：用于正式上线后的开发测试环境。
- Dev Worker 使用 Workers dev 子域访问，不接入 `616618.xyz` 主域，不进入 sitemap、导航或公开链接。
- 当前真实 dev 地址：`https://meigallery-api-dev.wajie.workers.dev`、`https://meigallery-web-dev.wajie.workers.dev`。
- Dev 环境使用独立 D1/R2，不连接生产资源，也不绑定任何广告平台 Queue。
- Dev 页面必须带测试环境标识，并建议设置 `X-Robots-Tag: noindex, nofollow` 或等价 meta，避免搜索引擎收录。

### Dev / Production 资源隔离

| 类型 | Production | Dev |
|------|------------|-----|
| Web Worker | `meigallery-web` | `meigallery-web-dev` |
| API Worker | `meigallery-api` | `meigallery-api-dev` |
| Web 域名 | `https://616618.xyz` / `https://www.616618.xyz` | `https://meigallery-web-dev.wajie.workers.dev` |
| API 域名 | `https://api.616618.xyz` | `https://meigallery-api-dev.wajie.workers.dev` |
| D1 | `meigallery-db` | `meigallery-db-dev` |
| R2 | `meigallery-media` | `meigallery-media-dev` |
| Queue（主 / DLQ） | Meta、TikTok、Google 各自独立的 production Queue / DLQ | 不配置 |

要求：

- dev 的 D1、R2 必须与 production 完全隔离；Meta / TikTok / Google Queue 与凭证仅允许 production 配置。
- `verify:quick` 的 `dev-resource-isolation` 必须持续通过，确保 `env.dev` 绑定不会回退到生产资源。
- 任何“dev 可连接生产 D1/R2 或真实广告平台”口径均视为历史策略，当前不再适用。

Workers：

- `meigallery-web`：承载前台页面和后台管理界面，静态资源通过 Workers Assets 分发。
- `meigallery-api`：提供 API，校验登录、会员等级、媒体权限；受保护图片由 Worker 代理返回，Stream 接入后视频使用 signed token。

D1：

- 存储结构化数据（图库、标签、用户、会员等级、审计日志）。
- 使用 migrations 管理 schema。

R2：

- 存储导入包、图片原图、缩略图、错误报告。
- 私有 bucket 存储受保护图片。

Stream（**当前状态：未接入**，secrets 为占位符）：

- 存储和分发视频。
- 区分试看视频和完整视频。
- 完整视频使用签名访问或服务端授权播放。

Turnstile：

- 登录、注册/验证码发送和后台导入任务创建/处理保护。
- 后台没有独立登录端点，管理员进入后台前复用普通登录入口的 Turnstile 校验。

Email：

- Cloudflare Email Service 使用前需按 Cloudflare 官方文档和 Dashboard 当前状态确认可用计划、发信额度和费用；当前 `email_verification_enabled` 默认为 `false`。

### 生产速率限制

API Worker 已内置应用内兜底限流，但该实现使用 Worker isolate 内存计数，不保证跨边缘节点、跨 isolate 或重启后的全局一致性。生产环境必须额外配置 Cloudflare WAF / Rate Limiting Rules 作为边缘强防护。

建议生产规则：

| 规则 | 匹配表达式示例 | 计数特征 | 阈值 | 动作 |
|------|----------------|----------|------|------|
| 登录/注册 | `http.host eq "api.616618.xyz" and http.request.uri.path matches "^/api/auth/(login|register)$"` | IP | 5 次 / 60 秒 | Managed Challenge 或 Block |
| 公开 JSON API | `http.host eq "api.616618.xyz" and http.request.uri.path matches "^/api/(galleries|tags|search|cases|contact-methods)(/.*)?$"` | IP | 60 次 / 60 秒 | Managed Challenge 或 Block |
| Meta 资源 attestation | `http.host eq "api.616618.xyz" and http.request.uri.path eq "/api/meta/resource-attestation" and http.request.method eq "POST"` | IP | 60 次 / 60 秒 | Block |
| 管理员 API | `http.host eq "api.616618.xyz" and http.request.uri.path starts_with "/api/admin/"` | session cookie 或 IP | 120 次 / 60 秒 | Managed Challenge 或 Block |
| 媒体访问接口 | `http.host eq "api.616618.xyz" and http.request.uri.path matches "^/api/media/[^/]+/access$"` | session cookie 或 IP | 30 次 / 60 秒 | Managed Challenge 或 Block |
| 外部导入 API | `http.host eq "api.616618.xyz" and http.request.uri.path starts_with "/api/imports/"` | IP | 120 次 / 60 秒 | Block |

配置要求：

- 先使用 Log 或 Managed Challenge 验证阈值，再切换到 Block。
- 规则的 Period、Requests、Characteristics、Mitigation timeout 和 Action 必须按 Dashboard 当前可用选项配置；不同 Cloudflare WAF 计划可用规则数和周期不同。
- 当前 Zone 为 Free 计划时，若规则数量不足以完整覆盖上表，至少启用登录/注册与 Meta 资源 attestation 规则，并保留代码内兜底限流；媒体访问接口和管理员 API 需在上线风险清单中标注。
- 如果后续需要强一致的用户级或 session 级应用限流，可评估 Cloudflare Workers Rate Limiting binding、Durable Objects 或 D1 计数表；Workers Rate Limiting binding 仍按 Cloudflare location 本地生效，不应被描述为全球强一致。

### Workers Logs 与兼容日期

`packages/api/wrangler.toml` 和 `packages/web/wrangler.toml` 已显式启用 Workers Logs：

```toml
[observability]
enabled = true
head_sampling_rate = 1
```

`env.dev` 使用 `[env.dev.observability]` 单独配置，避免环境覆盖后丢失日志采集。`head_sampling_rate = 1` 表示当前阶段保留 100% 请求日志；生产流量升高后可按 Cloudflare Workers Logs 当前额度、保留期和费用调整采样率。

兼容日期更新流程：

1. 上线前查阅 Cloudflare Workers compatibility dates / flags 官方文档和当前 Wrangler config schema。
2. 将 API/Web 的 `wrangler.toml` `compatibility_date` 和 Web 的 `nuxt.config.ts` `compatibilityDate` 同步更新到本次验证日期。
3. 运行 `corepack pnpm --filter @meigallery/api exec wrangler deploy --dry-run --env=""` 和 `corepack pnpm --filter @meigallery/web exec wrangler deploy --dry-run --env=""` 验证生产配置。
4. 如改动会影响 dev，同时运行 `--env=dev` dry-run。
5. 完成 API 类型检查、Web 构建和核心测试后，再执行真实部署。
6. 部署后在 Cloudflare Dashboard 的 Workers Observability / Logs 中确认 API 与 Web 均有请求日志；日志内容不得包含 token、cookie、Telegram Bot Token、R2 私有 key 或用户密码。

## 8. 全球 CDN 加速

- 静态资源由 Workers Assets 自动分发到全球边缘节点。
- 公共缩略图使用长缓存，文件名带 hash。
- `IMAGE_RESIZING_ENABLED=true` 时公共缩略图优先使用 Cloudflare Images Transformations，首期固定只请求 `w=480` 单规格，避免 Free 每月 5,000 unique transformations 被多规格消耗。
- Transformations 未启用、失败或返回 Free 超限错误（例如 9422）时，API 会回退返回原图，并继续设置 `Cache-Control: public, max-age=604800` 保持业务可用。
- API 默认不做长缓存，只缓存公开且稳定的数据。
- 受保护媒体不放入公共缓存。

## 9. 套餐建议

| 产品 | 当前策略 | 对本项目的影响 |
|------|----------|----------------|
| Workers | 生产上线前按官方 pricing 确认当前计划、请求量和是否需要 Paid | 内测后需要监控请求量、CPU 时间和构建部署限制 |
| D1 | 按官方 D1 limits 和 pricing 确认读写量、存储和备份策略 | 图库搜索、会员校验和后台列表是重点监控项 |
| R2 Standard | 按官方 R2 pricing 确认存储、读写请求和对象生命周期策略 | 图片原图、缩略图和导入包会持续增加存储与请求量 |
| Stream | 接入前按官方 Stream pricing 确认存储分钟、分发分钟和 signed URL 能力 | 视频是成本重点，MVP 应限制体量 |

注意：Cloudflare 套餐、限制和价格会变化。每次上线或采购前都要以 Cloudflare 官方 pricing 和 docs 为准。

## 10. 上线检查清单

- [ ] 域名 DNS 已接入 Cloudflare
- [ ] `meigallery-web` Worker 已部署并绑定 `616618.xyz`
- [ ] `meigallery-api` Worker 已部署并绑定 `api.616618.xyz`
- [ ] D1 数据库 `meigallery-db` 已创建，`0001` 到 `0049` migrations 已依次执行
- [ ] R2 bucket `meigallery-media` 已创建并设置私有访问策略
- [ ] Stream 上传和播放流程验证通过（当前未接入）
- [ ] 所有 Worker secrets 已配置（SESSION_SECRET、TURNSTILE_SECRET_KEY、STREAM_ACCOUNT_ID、STREAM_API_TOKEN）
- [ ] CORS_ORIGIN 和 NUXT_PUBLIC_API_BASE_URL 已设置
- [ ] Turnstile site key 已在前端配置
- [ ] 后台管理员账号已创建
- [ ] 外部导入所需 Import Token 已在后台创建，权限、过期时间和 `allowedSourceBotKeys` 已确认
- [ ] 每个 `sourceBotKey` 对应的 `TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>` secret 已配置
- [ ] 生产 6 条 `meigallery-ad-*` Queue 已创建且 backlog 正常
- [ ] `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT` 已作为 production secret 配置；dev 不配置
- [ ] `0052_unified_attribution_contract.sql` 与 `0053_attribution_privacy_policy.sql` 已应用且全局地区策略存在，启用的平台连接具有当前有效验证，无 critical incident、过期 Outbox 或 dead letter
- [ ] Meta 的 `Contact` / `CompleteRegistration` 已完成人工 Browser/Server 同 ID 去重确认
- [ ] `/admin/attribution` 可按 Meta / TikTok / Google 分别查看 Browser、Server、质量与容量；平台验证成功后才允许对应 Server 开关与 rollout
- [ ] 如接入 Ops Hub 自动导入，Ops Hub 侧 `sourceBotKey` 与 MeiGallery Import Token allowlist 完全一致，且只提交 `metadata.type=gallery/case`
- [ ] 已用 Ops Hub 或等价脚本完成 `#gallery` 单图、`#case` 相册、重复 `externalMessageId`、未授权 `sourceBotKey` 和旧 `testimonial_case` 拒绝验收
- [ ] WAF 和基本 rate limiting 已启用
- [ ] 登录、搜索、详情、媒体权限、导入流程通过验收
- [ ] 数据分析 migrations、API、Web、后台页面和 Owner 开关顺序已完成；默认关闭态和回滚 disabled 响应已验证
- [ ] 数据分析 Playwright smoke、10,000 sessions/day 写入成本 fixture 和 100,000 事件报表性能 fixture 已通过
- [ ] `corepack pnpm verify:seo:production` 通过，首页 `<head>` 与后台站点设置一致
- [ ] 已在干净工作区运行 `corepack pnpm verify:release`，并持有当前待发 commit 的通过报告
- [ ] `./scripts/deploy.sh production` 的 production gate 已确认放行

## 11. 旧站迁移部署计划

迁移 `https://zuole.me/` 时建议分阶段进行：

1. 新系统先部署到临时域名验证。
2. 使用 WordPress REST API 读取公开文章、分类、标签和媒体 URL。
3. 将图片迁移到 R2，将视频迁移到 Stream。
4. 所有迁移内容先进入草稿或待审核。
5. 完成分类和标签清洗后再批量发布。
6. 为旧文章 URL 生成跳转映射。
7. 正式切换域名时，将 `zuole.me` DNS 指向 Cloudflare Workers 自定义域名。
8. 保留旧 WordPress 站点只读备份，至少覆盖一个完整审核周期。

## 12. R2 Cases 对象迁移

`0017_cases_cleanup.sql` 会将真实案例表从 `testimonial_*` 切换为 `cases` / `case_images`，并将数据库中的 R2 key 从 `testimonials/...` 改为 `cases/...`。生产执行时必须先迁移 R2 对象，再执行 D1 迁移，避免数据库切表后引用不存在的对象。

执行前确认 Cloudflare Images Transformations 已按当前设计启用或已有等价降级策略，避免迁移后图片访问链路出现缩略图生成差异。

生产顺序：

```bash
# 1. 先完成本地或 CI 构建预检，不修改远程 D1 或 R2
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist
corepack pnpm --filter @meigallery/web exec nuxt build

# 2. 查看将复制和将删除的映射，不修改 R2 或 D1
node scripts/migrate-cases-r2.mjs --dry-run --remote

# 3. 复制 testimonials/ 对象到 cases/，并通过 sha256 验证新旧对象内容一致
node scripts/migrate-cases-r2.mjs --remote

# 4. 完成 R2 验证后，只能通过统一部署脚本执行 D1 migration 和 Worker 发布。
# 显式变量仅解除 0017 专项保护，不绕过其他 production 门禁。
ALLOW_CASES_CLEANUP_MIGRATION=true ./scripts/deploy.sh production

# 5. 部署 API 和 Web Worker，并完成 smoke 测试
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --var "RELEASE_COMMIT:${GIT_COMMIT}"
corepack pnpm --filter @meigallery/web exec wrangler deploy --env="" --var "RELEASE_COMMIT:${GIT_COMMIT}"

# 6. smoke 通过后，显式删除旧 testimonials/ 对象
node scripts/migrate-cases-r2.mjs --remote --delete-old --confirm-delete-old=testimonials-to-cases
```

脚本说明：

- 默认 R2 bucket 为 `meigallery-media`，可用 `R2_BUCKET` 覆盖。
- 默认 D1 database 为 `meigallery-db`，可用 `D1_DATABASE` 覆盖。
- `--remote` 表示查询远程 D1，并对远程 R2 执行 `get` / `put` / `delete`；不带时使用本地 D1/R2。
- `--dry-run` 只打印 `testimonials/... -> cases/...` 映射和将删除的旧 key，不会写入 R2 或 D1。
- 正式复制时脚本会先 `r2 object get` 到临时文件，再带原始 MIME 类型 `r2 object put` 到新 key，并再次 `r2 object get` 目标 key；随后比较新旧临时文件 sha256，确保复制后内容一致。R2 操作会对临时网络错误自动重试。
- `--delete-old` 只删除旧 `testimonials/` 对象，必须同时带 `--remote` 和 `--confirm-delete-old=testimonials-to-cases`，并且必须在复制、验证、D1 migration、部署和 smoke 测试后执行；脚本不会自动执行 D1 migration。
- 删除阶段会先完整遍历所有映射，分别读取旧 `testimonials/...` 和新 `cases/...` 对象并比较 sha256；全部一致后才第二轮删除旧对象。如果旧对象不存在但新对象存在，会打印“跳过：旧对象不存在，可能是迁移后新增对象”，不失败也不删除；如果旧对象存在但新对象不存在或 hash 不一致，会中止并以非 0 状态退出，不删除任何旧对象。
- 映射清单合并 `testimonial_case_images.r2_key` 与 `external_import_files.r2_key` 两个来源，并按旧 `testimonials/...` key 去重。
- D1 已切表后，如果旧 `testimonial_case_images` 表已不存在，普通复制模式会合并 `case_images.r2_key` 与 `external_import_files.r2_key` 中的 `cases/...` key，并反推旧 `testimonials/...` key，用于补齐目标 R2 对象；删除阶段也使用同一映射来源。
- `scripts/deploy.sh` 会先完成 API dry-run 和 Web build，再进入 D1 migration 阶段；生产环境如果发现 `0017_cases_cleanup.sql` 仍在待执行迁移列表中，且未设置 `ALLOW_CASES_CLEANUP_MIGRATION=true`，会在 D1 migration 前中止，防止误跑一键部署导致 D1 先于 R2 迁移。0017 已应用或不在待执行列表时不会继续拦截后续生产部署。
- 如果本地 D1 已执行 `0017_cases_cleanup.sql`，旧表 `testimonial_case_images` 可能已不存在；此时本地 dry-run 提示旧表不存在属于预期，不代表脚本实现失败。

## 13. 参考资料

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Workers Assets: https://developers.cloudflare.com/workers/frameworks/
- Workers Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- D1: https://developers.cloudflare.com/d1/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- R2: https://developers.cloudflare.com/r2/
- Stream: https://developers.cloudflare.com/stream/
- Turnstile: https://developers.cloudflare.com/turnstile/
- Cloudflare Queues batching / retries: https://developers.cloudflare.com/queues/configuration/batching-retries/
- Cloudflare Queues JavaScript APIs: https://developers.cloudflare.com/queues/configuration/javascript-apis/
- Workers Analytics Engine limits: https://developers.cloudflare.com/analytics/analytics-engine/limits/
- Workers Analytics Engine pricing: https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- Cloudflare pricing: https://www.cloudflare.com/plans/
