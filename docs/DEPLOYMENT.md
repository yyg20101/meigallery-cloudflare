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

本项目使用 pnpm workspace，推荐通过 `corepack pnpm` 调用仓库锁定的 pnpm 版本；`scripts/deploy.sh` 会自动检测裸 `pnpm`，不存在时回退到 `corepack pnpm`。

```bash
# 首次初始化
./scripts/setup.sh

# 生产部署（推荐；脚本会在远端 migration 前执行 production gate，并向 API/Web 注入当前 commit）
# 重要警告：生产环境中，当待发布包含 0017_cases_cleanup.sql 时，禁止直接运行一键部署。
# 必须先完成本地或 CI 构建预检，再按“R2 Cases 对象迁移”专项顺序完成
# dry-run、复制和目标对象验证，然后才执行 D1 remote migration 和部署。
./scripts/deploy.sh production

# 或以下安全等价手动步骤：
# 1. API Worker 构建预检，不部署
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist

# 2. 构建前端
corepack pnpm --filter @meigallery/web exec nuxt build

# 3. 记录当前 commit，并在任何 remote migration 前执行 production gate。
GIT_COMMIT="$(git rev-parse HEAD)"
env -u VERIFY_RELEASE_ALLOW_BRANCH node scripts/verify-release.mjs assert-production-allowed

# 4. D1 迁移
# 重要警告：如果待执行 migrations 包含 0017_cases_cleanup.sql，必须先完成：
# 构建预检 -> R2 Cases dry-run -> R2 复制和目标对象验证，再执行此 D1 remote migration。
corepack pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --env="" --remote

# 5. 部署 API Worker
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --var "RELEASE_COMMIT:${GIT_COMMIT}"

# 6. 部署 Web Worker
corepack pnpm --filter @meigallery/web exec wrangler deploy --env="" --var "RELEASE_COMMIT:${GIT_COMMIT}"

# 7. 部署后 SEO 校验
corepack pnpm verify:seo:production
```

## 4. CI/CD

**手动部署**：生产部署推荐只通过 `./scripts/deploy.sh production` 执行。该脚本会在任何远端 migration 前执行 production gate，并为 API/Web 注入当前 `RELEASE_COMMIT`。GitHub Actions 不负责生产部署，避免合入分支后自动影响线上用户。

```bash
# 已完成同 commit release 验证后的生产发布。
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
| `corepack pnpm verify:quick` | 日常开发、提交前快速自检 | 先执行资源隔离与 `meta-secret-leaks`，阻断 dev 误连生产资源或静态泄漏。 |
| `corepack pnpm verify:meta-secrets` | 修改 Meta、release evidence 或运维脚本后 | 扫描 tracked 文件和 ignored release evidence；输出仅含相对路径与规则 ID。 |
| `corepack pnpm verify:local-runtime` | 需要验证 Worker 本地运行时、D1/Queue/归因降级链路时 | 在本机 Cloudflare 兼容运行时做链路验证，不依赖远端 dev 域名。 |
| `corepack pnpm verify:dev-rehearsal` | 上线前的 dev 环境演练 | 依赖独立 dev 资源与 dev Workers URL，验证 remote migration、dev 部署和核心 smoke。运行前需设置 `VERIFY_DEV_API_URL`、`VERIFY_DEV_WEB_URL`。 |
| `corepack pnpm verify:release` | 生产部署前最终放行 | 在干净工作区串联前述验证并生成 `mode=release` 报告，供生产 gate 校验。 |

### 生产放行要求

- `./scripts/deploy.sh production` 每次都必须重新执行完整、不可跳过的 `verify:release`，随后只校验本次新生成的同 commit 报告；本地旧 `latest.json` 即使内容显示通过也不能跳过 fresh gate。
- 合入 `main` 后，只要最新待发布 HEAD 与现有 release 报告中的 commit 不完全一致，就必须在 `main` 上重新运行 `corepack pnpm verify:release`；任何旧 commit 报告都不能放行新的生产 HEAD。
- `scripts/deploy.sh production` 会在远端 migration 前依次执行 fresh `verify:release` 和 `env -u VERIFY_RELEASE_ALLOW_BRANCH node scripts/verify-release.mjs assert-production-allowed`。
- 缺少通过报告、报告 commit 与当前待发 commit 不一致、工作区不干净，或分支不满足放行条件时，生产部署必须阻断。
- `VERIFY_RELEASE_ALLOW_BRANCH` 仅用于非生产分支演练 release gate，不能替代正式生产放行。

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
# 首次 Meta 上线：只额外要求 production 的 meta_capi_enabled=false，不约束 dev。
META_INITIAL_ROLLOUT=1 corepack pnpm verify:release
./scripts/deploy.sh production
```

后续常规发布使用 `corepack pnpm verify:release`，不设置 `META_INITIAL_ROLLOUT`。首次 Meta 上线完成后，该变量也不得作为常规发布的替代参数。

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

Meta 正式事件仅为 `Contact`、`CompleteRegistration`；`Lead`、`StartTrial` 只保留历史读取。站内 `analytics_conversion_actions` 是唯一事实源，Pixel / CAPI 只是同步渠道，关闭或失败都不得阻断站内转化记账。

Dataset Quality 使用唯一 production Dataset。Owner 已批准九章节 production contract，collector 仅在 production 每日 Cron 读取聚合质量指标。dev 不配置 CAPI token、不采集或伪造 production Dataset 快照。首次 production bootstrap 时允许快照尚未产生，但必须保持 CAPI 关闭且 rollout 为 `0`；部署后必须先运行 collector，并由 full gate 校验当前 contract version/digest、两项活动事件和 24 小时新鲜度，之后才能进入正式放量。

后台与证据的状态口径必须严格区分：Pixel `attempted` 只表示浏览器已按服务端指令尝试调用，**不代表 Meta 已接收**；只有 CAPI delivery 为 `sent` 且 Graph API 返回 `events_received=1`，才可表述为 Meta 已接收。两项正式事件的 Browser/Server 同 ID 与 Meta 去重结果，必须由 Owner 在 Events Manager 中确认并生成脱敏 live evidence。

普通 test mode 的 `Contact`、`CompleteRegistration` 不自动携带 `test_event_code`。只有 Owner 显式触发的 Test Event/bootstrap 路径使用 `META_CAPI_TEST_EVENT_CODE`，且只读取当前环境 Worker secret，不接受调用参数覆盖。`meta_tracking_mode=production` 时，即使环境中仍配置 Test Event Code，CAPI payload 也绝不携带 `test_event_code`。

环境资源固定如下，dev 和生产不得交叉使用 token、Test Event Code、D1、R2 或 Queue：

| 环境 | 主 Queue | DLQ |
|------|----------|-----|
| dev | `meigallery-meta-capi-dev` | `meigallery-meta-capi-dev-dlq` |
| production | `meigallery-meta-capi` | `meigallery-meta-capi-dlq` |

首次由已授权操作人创建资源时，Queue 与 secret 命令只在交互式终端执行；secret 值绝不进入 shell history、文档、报告或日志：

```bash
# production；dev 使用对应的 -dev / -dev-dlq 名称和 --env dev。
corepack pnpm --filter @meigallery/api exec wrangler queues create meigallery-meta-capi
corepack pnpm --filter @meigallery/api exec wrangler queues create meigallery-meta-capi-dlq
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_ACCESS_TOKEN --env=""
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_TEST_EVENT_CODE --env=""
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_DATA_KEY_CURRENT --env=""
```

`META_CAPI_DATA_KEY_PREVIOUS` 只在轮换窗口配置。Cloudflare Worker secret 不可回读，旧 current 必须从受控 secret manager 取得，不能从 Wrangler、日志或报告恢复。轮换顺序固定为：

1. 将受控 secret manager 中的旧 current 通过交互式命令写入 previous：`corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_DATA_KEY_PREVIOUS --env=""`。
2. 在交互式终端执行 `openssl rand -base64 32`，把生成结果通过 `corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_DATA_KEY_CURRENT --env=""` 写入新 current。
3. 部署后在 `/admin/attribution/meta` 等待 previous outbox 与活动 delivery 计数都归零；本阶段不开放 production bootstrap 或 rollout。
4. 执行 `corepack pnpm --filter @meigallery/api exec wrangler secret delete META_CAPI_DATA_KEY_PREVIOUS --env=""`，再次部署。

dev 操作将上述 `--env=""` 替换为 `--env dev`。后台只展示有效性布尔值、引用计数和可移除状态，不展示 key ID 或派生值。

正式发布必须按下列顺序完成，不能以旧 commit 的 evidence 或 release 报告放行新 HEAD：

1. 保持代码关闭态：`meta_tracking_mode=disabled`、`meta_capi_enabled=false`，并完成本地 migration、测试、类型检查和 Worker dry-run。
2. 在独立 dev 资源部署当前待发布代码，完成严格 dev live evidence：`Contact`、`CompleteRegistration` 均有 Browser/Server、同一 event ID、去重成功，且没有 `Lead`、`StartTrial`。
3. 先执行 `corepack pnpm verify:meta-secrets`，再用只读资源检查排障：dev 为 `corepack pnpm verify:meta-resources --env dev --report-only`，production 为 `corepack pnpm verify:meta-resources --env production --report-only`。资源检查从 Wrangler/Cloudflare 响应核对 migrations `0036..0044`、D1、R2、Queue、DLQ 与 secret 名称，不接受本地 JSON 自证；dev Dataset Quality 快照还必须携带与 Git tracked approved contract 精确一致的 SHA-256 digest。
4. 对生产 D1 依次应用 `0001` 到 `0044`，每次 remote apply 前必须先执行 duplicate preflight。保持 production target/effective rollout 为 `0`；`--initial-meta-rollout` 还要求无过期 secure outbox，previous key 活动引用可由 secret 状态解释，并为当前 commit 写入未过期的 production D1 bootstrap permit。
5. PR 合入 `main` 后，以最终 `main` HEAD 重新部署 dev，并重新生成该 commit 的 dev live evidence；此前任何 commit 的 evidence 都失效。
6. 在最终 `main` HEAD、干净工作区运行同 commit release 作预检：首次 Meta 上线使用 `META_INITIAL_ROLLOUT=1 corepack pnpm verify:release`，该约束只要求 production `meta_capi_enabled=false`，不约束 dev；后续常规发布使用 `corepack pnpm verify:release`。执行 `./scripts/deploy.sh production` 时脚本仍会强制重跑完整 release，不能复用这份旧报告跳过验证。
7. 部署生产 API，再部署生产 Web；部署不等同于开启营销投放。
8. production Worker 部署后，将 `meta_tracking_mode` 设为 `test`。CLI 只向固定的 dev `https://meigallery-api-dev.wajie.workers.dev` 与 production `https://api.616618.xyz` origin 携带 Owner Cookie 换取 60 秒一次性 ticket；最终 attestation 请求不携带 Cookie，且禁止 redirect。执行 `corepack pnpm verify:meta-resources --env production --post-deploy-isolation`，要求两个 Worker 绑定当前 commit、nonce 与严格 TTL，并确认 Pixel/token/Test Event Code/data key 全部隔离。bootstrap 阶段不要求该 endpoint，避免首次部署死锁。
9. post-deploy isolation 摘要通过后，Owner 才能触发 production synthetic Test Event。API 会在 fetch 前检查当前 commit、target/effective rollout `0`、无 open critical incident和完整 isolation；`disabled` 或 `production` mode 均拒绝。Meta 返回 `events_received=1` 后写入当前 production connection verification。
10. 执行 `corepack pnpm verify:meta-resources --env production` 写入当前 commit 的 full isolation + connection 摘要，再把 `meta_tracking_mode` 切为 `production`。此后 Owner 才能手动按 `0 -> 10 -> 50 -> 100` 晋级；0→10 会重新读取 production connection、full isolation、incident 和 rollout，部署脚本始终不得修改 setting、incident 或 rollout。普通 production CAPI payload 始终不携带 `test_event_code`。

dev live evidence 必须由后台 Owner 按钮创建 Worker challenge：浏览器通过真实 `fbq` 发送 `Contact` 与 `CompleteRegistration`，随后 Worker 使用同组 opaque event ID 发送 CAPI。`corepack pnpm verify:meta-live` 只读取 D1 中已销毁原始 ID 的摘要并记录 Events Manager 人工确认，不在本地生成 session 或 event ID；成功或失败都会清理短期 challenge 摘要。

任何一步失败都回到 `meta_tracking_mode=disabled` 并保持 `meta_capi_enabled=false`，不得伪造 live evidence 或跳过同 commit 重验。

### Meta 回滚顺序

优先回滚运行开关，不删除 Queue、DLQ、secret、D1 表或已应用 migration：

1. Owner 先关闭 `meta_capi_enabled`，停止创建和入队新的 CAPI delivery；站内转化账本应继续写入，关闭后不得新增 CAPI delivery。
2. 将 `meta_tracking_mode` 切回 `disabled`，使营销授权即使为 granted 也不再允许 Pixel 或新的 Meta delivery。
3. 如需进一步停止浏览器侧调用，再关闭 `facebook_pixel_enabled`；不要把 Pixel `attempted` 误读为接收量。
4. Queue 或外部失败异常时记录 backlog、DLQ、failed 原因并暂停投递；修复后先在 `test` mode 重做 Owner Test Event，再依序恢复 production mode 与 CAPI 开关。
5. 如必须回退 Worker，先完成前述关闭态，再部署旧版本；保留 schema 和 delivery 账本用于核对损失窗口与恢复验证。

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
| `META_CAPI_ACCESS_TOKEN` | API Worker secret | Meta Conversions API 访问令牌，只存 Worker secret，不进入 D1 或前端 |
| `META_CAPI_TEST_EVENT_CODE` | API Worker secret | 当前环境 Meta Events Manager Test Events 调试码；仅供 Owner 显式 Test Event/bootstrap 使用，普通 test mode 正式事件不自动携带，production payload 永不携带 |
| `META_CAPI_DATA_KEY_CURRENT` | API Worker secret | AES-256-GCM 当前数据密钥；所有 mode 的 CAPI readiness 必需 |
| `META_CAPI_DATA_KEY_PREVIOUS` | API Worker secret | 仅轮换窗口使用的上一把数据密钥 |
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
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_ACCESS_TOKEN
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_TEST_EVENT_CODE
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_DATA_KEY_CURRENT
# 仅轮换窗口执行：
corepack pnpm --filter @meigallery/api exec wrangler secret put META_CAPI_DATA_KEY_PREVIOUS
```

## 7. Cloudflare 产品绑定

### Zone/Account 信息

- Account ID: `32b73e607476d0224c7ca40d28be1120`
- Zone ID: `2f7f49183fa463345e09432719af2c7d`（616618.xyz，Free 计划）
- D1 Database ID: `714929cb-003b-4cb1-bd9f-545fa1895e8c`
- R2 Bucket: `meigallery-media`
- Queue: `meigallery-meta-capi`（生产 Meta CAPI 投递）
- D1 Database（dev）: `meigallery-db-dev`
- R2 Bucket（dev）: `meigallery-media-dev`
- Queue: `meigallery-meta-capi-dev`（dev Meta CAPI 投递）

### Dev 环境

- `meigallery-api-dev` / `meigallery-web-dev`：用于正式上线后的开发测试环境。
- Dev Worker 使用 Workers dev 子域访问，不接入 `616618.xyz` 主域，不进入 sitemap、导航或公开链接。
- 当前真实 dev 地址：`https://meigallery-api-dev.wajie.workers.dev`、`https://meigallery-web-dev.wajie.workers.dev`。
- Dev 环境使用独立 Cloudflare 资源，不再连接生产 D1/R2/Queue。
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
| Queue（主 / DLQ） | `meigallery-meta-capi` / `meigallery-meta-capi-dlq` | `meigallery-meta-capi-dev` / `meigallery-meta-capi-dev-dlq` |

要求：

- dev 的 D1、R2、Queue 必须与 production 完全隔离。
- `verify:quick` 的 `dev-resource-isolation` 必须持续通过，确保 `env.dev` 绑定不会回退到生产资源。
- 任何“dev 可连接生产 D1/R2”口径均视为历史策略，当前不再适用。

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
- [ ] D1 数据库 `meigallery-db` 已创建，`0001` 到 `0038` migrations 已依次执行
- [ ] R2 bucket `meigallery-media` 已创建并设置私有访问策略
- [ ] Stream 上传和播放流程验证通过（当前未接入）
- [ ] 所有 Worker secrets 已配置（SESSION_SECRET、TURNSTILE_SECRET_KEY、STREAM_ACCOUNT_ID、STREAM_API_TOKEN）
- [ ] CORS_ORIGIN 和 NUXT_PUBLIC_API_BASE_URL 已设置
- [ ] Turnstile site key 已在前端配置
- [ ] 后台管理员账号已创建
- [ ] 外部导入所需 Import Token 已在后台创建，权限、过期时间和 `allowedSourceBotKeys` 已确认
- [ ] 每个 `sourceBotKey` 对应的 `TELEGRAM_BOT_TOKEN_<SOURCE_BOT_KEY>` secret 已配置
- [ ] 生产 `meigallery-meta-capi` 和 `meigallery-meta-capi-dlq` 已创建，API Worker producer / consumer dry-run 通过
- [ ] `META_CAPI_ACCESS_TOKEN`、`META_CAPI_TEST_EVENT_CODE` 和 `META_CAPI_DATA_KEY_CURRENT` 已作为独立 production secret 配置；dev 使用不同值
- [ ] `0036_meta_capi_v2_secure_delivery.sql`、`0037_meta_connection_revision.sql` 与 `0038_conversion_dedupe_claims.sql` 已应用；`meta_tracking_mode=disabled`、`meta_capi_enabled=false`
- [ ] 当前 `main` HEAD 已重做 dev live evidence；`Contact` / `CompleteRegistration` 均完成 Browser/Server 同 ID 去重，且无 `Lead` / `StartTrial`
- [ ] `/admin/attribution/meta` 将 Pixel `attempted` 与 CAPI `sent` 分开显示；Owner Test Event 返回 `events_received=1` 后才允许 production mode 和 `meta_capi_enabled`
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

# 1.1 在任何 remote migration 前绑定当前 commit 并执行 production gate。
GIT_COMMIT="$(git rev-parse HEAD)"
env -u VERIFY_RELEASE_ALLOW_BRANCH node scripts/verify-release.mjs assert-production-allowed

# 2. 查看将复制和将删除的映射，不修改 R2 或 D1
node scripts/migrate-cases-r2.mjs --dry-run --remote

# 3. 复制 testimonials/ 对象到 cases/，并通过 sha256 验证新旧对象内容一致
node scripts/migrate-cases-r2.mjs --remote

# 4. 再执行 D1 远程迁移；脚本不会自动执行 migration
corepack pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --env="" --remote

# 如需改用一键部署脚本在生产环境执行包含 0017 的迁移，必须先完成 R2 dry-run、复制和验证，
# 再显式设置以下环境变量解除 production-only 保护。
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
