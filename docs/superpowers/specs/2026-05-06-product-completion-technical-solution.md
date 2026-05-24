# MeiGallery 功能整体完善技术方案

## 1. 方案摘要

本方案是 `2026-05-06-product-completion-prd.md` 的上层集成技术方案，用来统一下一阶段首页转化、真实案例、Telegram `file_id` 导入、Facebook Pixel、后台效率和 dev 验收的技术边界。单项功能仍以各自技术方案和实施计划为准，本方案负责定义模块依赖、实施顺序、共享约束、上线门槛和跨模块一致性。

核心原则：
- 不重构已稳定上线的基础架构，继续使用 Nuxt Web Worker、Hono API Worker、D1、R2 和 Cloudflare Workers dev 子域。
- 首页真实案例与规则入口已经完成基础落地，下一阶段以补齐追踪、后台效率和导入链路为主。
- Telegram 导入、Facebook Pixel 和后台配置必须共享同一套权限、审计、dev 隔离和测试门槛。
- 所有受保护媒体、Import Token、Telegram Bot Token、Pixel 事件和 dev 部署都按“最小暴露、服务端校验、可审计”处理。
- 每个阶段单独提交、验证和推送，不把多个风险不同的模块混在一个大提交里。

## 2. 当前状态与模块边界

### 2.1 已完成或已启动

| 模块 | 当前状态 | 后续处理 |
|------|----------|----------|
| 首页真实案例与规则入口 | 已实现、测试、dev 部署验收 | 仅补充统计、文案微调和后续体验优化 |
| 真实案例 D1/R2/API/后台 | 已实现基础 CRUD、图片上传、发布校验 | 后续只新增曝光点击统计和后台筛选增强 |
| dev Worker 隔离 | 已处理 `workers_dev=true`、`routes=[]` 和 noindex | 每次 wrangler env 变更必须复查 |
| Telegram 导入 PRD/技术方案/对接文档 | 已完成 | 按实施计划继续 Task 2+ |
| Telegram 导入基础模型 | 已完成 `0015_telegram_import_api.sql`、token 工具和错误工具 | 下一步实现 payload 校验、fetcher、状态机和路由 |
| Facebook Pixel PRD/技术方案 | 已完成文档 | 后续实现 site settings、前端 plugin、事件触发和验证 |

### 2.2 本阶段新增技术范围

本阶段不再重复实现首页真实案例基础功能，重点放在以下 4 条主线：

- Telegram 导入后端闭环：校验、拉取、R2 入库、草稿创建、状态查询、retry、后台 token 和记录管理。
- Facebook Pixel 前端归因：配置开关、公开页面 PageView、业务事件、PII 过滤、dev 隔离。
- 后台效率和审计：Owner 管理 Import Token、Admin 查看外部导入记录、失败诊断、设置变更审计。
- 质量与上线控制：统一验证命令、dev smoke test、生产部署前检查清单。

## 3. 总体架构

```text
公开访问流量
  -> packages/web Nuxt Worker
  -> 首页 / discover / gallery detail / testimonials / rules / login / register
  -> useApi 或 SSR service binding 调 packages/api
  -> useFacebookPixel 只在公开页面发送脱敏事件

后台运营流量
  -> packages/web /admin/** SPA
  -> session cookie + requireAdmin / requireOwner
  -> 管理图库、真实案例、设置、Import Token、外部导入记录、审计日志

Telegram Bot / Ops Hub
  -> POST /api/imports/telegram-file-id
  -> Import Token 鉴权，不接受管理员 session 替代
  -> D1 external_import_records / external_import_files
  -> waitUntil MVP 或 Queue message
  -> Telegram getFile + download
  -> R2 put
  -> galleries/media_assets 或 testimonial_cases/testimonial_case_images 草稿
```

### 3.1 包职责

| 包 | 职责 |
|----|------|
| `packages/api` | 导入 API、后台 API、D1/R2 写入、审计日志、Telegram 拉取、权限校验、站点设置 |
| `packages/web` | 首页与后台 UI、Pixel client plugin、事件触发、dev 环境标识、后台 token/导入记录页面 |
| `packages/shared` | 仅放跨包稳定常量和类型；本阶段不强制新增，除非 API/Web 都依赖同一事件名或权限常量 |

### 3.2 跨模块依赖顺序

1. Telegram 基础工具和 D1 schema。
2. Telegram payload 校验和 Telegram fetcher。
3. Telegram 导入状态机 service。
4. Bot 导入公开 API 和后台 token/记录 API。
5. Facebook Pixel 设置 schema 和 API key 白名单。
6. Facebook Pixel 前端 plugin/composable 和业务事件接入。
7. 后台页面和 dev 验收文档补齐。

这个顺序避免 Pixel 和后台页面阻塞 Telegram 后端闭环，也避免在 Import Token API 未完成前实现后台 UI。

## 4. 数据模型设计

### 4.1 已新增 Telegram 导入表

`packages/api/migrations/0015_telegram_import_api.sql` 已新增：

- `import_api_tokens`
- `external_import_records`
- `external_import_files`

实现后续任务时不得更改已提交 migration 的历史内容。若需要补字段，新增 `0016_*` migration。

### 4.2 Facebook Pixel 配置 migration

由于 `0015` 已被 Telegram 导入占用，Facebook Pixel 配置使用下一条 migration：

`packages/api/migrations/0016_facebook_pixel_settings.sql`

```sql
-- Facebook Pixel 广告归因配置
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('facebook_pixel_enabled', 'false', datetime('now')),
  ('facebook_pixel_id', '""', datetime('now')),
  ('facebook_pixel_debug_enabled', 'false', datetime('now'));
```

同步修改：

- `packages/api/src/utils/site-settings.ts`：`ADMIN_SETTING_KEYS` 和 `PUBLIC_SETTING_KEYS` 增加 3 个 key。
- `packages/api/src/routes/admin/settings.ts`：保存 `facebook_pixel_id` 前校验数字字符串，长度 5-30；布尔配置保存为 JSON boolean。
- `packages/api/src/utils/site-settings.test.ts`：断言 Pixel key 在 admin 和 public settings 中存在。

### 4.3 后续可选统计表

真实案例曝光/点击统计不进入 MVP。v1.1 如需落地，新增轻量表：

```sql
CREATE TABLE IF NOT EXISTS testimonial_case_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES testimonial_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  location TEXT NOT NULL,
  request_ip_hash TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (event_type IN ('impression', 'click'))
);
```

MVP 不实现该表，避免在广告 Pixel 尚未上线前引入重复统计口径。

## 5. API 设计

### 5.1 Telegram Bot 导入 API

沿用 `2026-05-06-telegram-import-api-technical-solution.md`：

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `POST` | `/api/imports/telegram-file-id` | Import Token | 接收 JSON payload，创建外部导入记录，返回 `pending_media_fetch` 或 `duplicate` |
| `GET` | `/api/imports/:importId` | Import Token | 查询同一 token 创建的导入状态 |
| `POST` | `/api/imports/:importId/retry` | Import Token | 仅允许重试同一 token 的 `failed` 记录 |

鉴权规则：

- Header 必须是 `Authorization: Bearer <import_token>`。
- 不接受管理员 session cookie 作为替代凭证。
- token hash 命中、状态 active、未过期、权限匹配、`sourceBotKey` allowlist 命中后才允许创建或查询。

### 5.2 后台 Import Token API

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| `GET` | `/api/admin/import-api-tokens` | Owner | 列表，不返回 `token_hash` 和明文 token |
| `POST` | `/api/admin/import-api-tokens` | Owner | 创建 token，一次性返回明文 |
| `PATCH` | `/api/admin/import-api-tokens/:id` | Owner | 更新名称、权限、sourceBotKey allowlist、过期时间、状态 |
| `DELETE` | `/api/admin/import-api-tokens/:id` | Owner | 软删除，设置 `status='disabled'` |

审计动作：

- `import_token.create`
- `import_token.update`
- `import_token.disable`

审计内容不得包含 token 明文、token hash 或 Telegram Bot Token。

### 5.3 后台外部导入记录 API

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| `GET` | `/api/admin/external-import-records` | Admin+ | 支持 source、targetType、status、sourceBotKey、page、pageSize |
| `GET` | `/api/admin/external-import-records/:id` | Admin+ | 查看 metadata 快照、文件状态、错误摘要、目标资源链接 |

MVP 不做后台 retry 按钮，避免后台和 Bot retry 权限混用。v1.1 可新增后台 retry，内部复用同一状态机，但必须写 `telegram_import.retry_by_admin` 审计日志。

### 5.4 Facebook Pixel 设置 API

复用现有站点设置：

- `GET /api/settings/public` 返回 `facebook_pixel_enabled`、`facebook_pixel_id`、`facebook_pixel_debug_enabled`。
- `PATCH /api/admin/settings` 仅 Owner 可改，保存后写现有 settings 审计日志。

校验响应：

```json
{
  "statusCode": 400,
  "message": "Facebook Pixel ID 只能填写 5-30 位数字"
}
```

## 6. 后端模块设计

### 6.1 Telegram 导入模块

文件边界：

| 文件 | 职责 |
|------|------|
| `packages/api/src/utils/import-token.ts` | token 生成、hash、权限、过期、sourceBotKey allowlist |
| `packages/api/src/utils/import-errors.ts` | 统一错误码和响应结构 |
| `packages/api/src/utils/import-validation.ts` | payload 纯校验，不访问 D1/R2 |
| `packages/api/src/services/telegram-file-fetcher.ts` | Telegram getFile/download，只依赖 fetch 和 env secret |
| `packages/api/src/services/telegram-file-id-import.ts` | 状态机、D1/R2 编排、草稿创建、失败清理、retry reset |
| `packages/api/src/routes/imports.ts` | Bot API 路由，负责鉴权、调用 service、返回 JSON |

状态流：

```text
pending_media_fetch
  -> fetching_media
  -> draft_created
  -> failed
```

`partial_failed` 保留在 schema 中，但 MVP 不产生该状态。任一文件失败时整体失败，并清理目标草稿、目标媒体和已上传 R2 对象。

### 6.2 审计日志策略

写入审计日志的关键动作：

- `telegram_import.accepted`
- `telegram_import.create_gallery`
- `telegram_import.create_testimonial_case`
- `telegram_import.failed`
- `telegram_import.retry`
- `import_token.create`
- `import_token.update`
- `import_token.disable`
- `settings.update_facebook_pixel`

审计日志安全过滤：

- 不写 Import Token 明文。
- 不写 token hash。
- 不写 Telegram Bot Token。
- 不写 Telegram file download URL。
- 不写图片二进制、R2 私有直链或 Stream token。

### 6.3 速率限制

MVP 使用现有 IP 速率限制中间件扩展：

- `/api/imports/*`：每 IP 每分钟 120 次。
- `/api/imports/telegram-file-id`：每 token 每分钟 60 次的精细限制可在 v1.1 增加，MVP 先用 IP 限制和 token allowlist 控制风险。
- 登录/注册、图库互动继续沿用现有限制。

如果实现 token 级限制，需要新增 D1 计数或 Cloudflare Rate Limiting binding，需单独评估成本和绑定配置。

## 7. 前端模块设计

### 7.1 Facebook Pixel 模块

沿用 `2026-05-06-facebook-pixel-attribution-technical-solution.md`，新增文件：

| 文件 | 职责 |
|------|------|
| `packages/web/app/utils/facebookPixel.ts` | Pixel ID 规范化、PII 过滤、admin path 判断、配置解析 |
| `packages/web/app/composables/useFacebookPixel.ts` | 初始化和发送 PageView/ViewContent/Search/Lead/Registration/Login/Filter |
| `packages/web/app/plugins/facebook-pixel.client.ts` | client-only 初始化、路由监听、公开页面 PageView 去重 |

事件计划：

| 事件 | 类型 | 触发点 | 关键参数 |
|------|------|--------|----------|
| `PageView` | Meta 标准事件 | 公开页面首屏和路由切换 | 无自定义参数 |
| `ViewContent` | Meta 标准事件 | 图库详情加载成功 | `content_type`、`content_ids`、`content_name`、`required_rank`、`tags` |
| `Search` | Meta 标准事件 | 搜索结果返回后 | `search_string`、`result_count` |
| `Lead` | Meta 标准事件 | 联系站长入口首次展开或点击 | `location`、`method_type` |
| `CompleteRegistration` | Meta 标准事件 | 注册成功 | `method='email'` |
| `login_completed` | 自定义事件 | 登录成功 | `method='email'` |
| `filter_selected` | 自定义事件 | 标签/筛选点击 | `tag_slug`、`tag_type`、`location` |

环境解析规则：

| 环境 | Pixel 加载规则 |
|------|----------------|
| production | 站点设置启用且 Pixel ID 非空时加载 |
| dev/local 默认 | 不加载正式 Pixel |
| dev 显式测试 | 仅使用 `NUXT_PUBLIC_FACEBOOK_PIXEL_DEV_ID` 加载测试 Pixel |

### 7.2 后台 UI 模块

MVP 后台 UI 优先级：

1. Import Token 列表和创建页。
2. 外部导入记录列表和详情页。
3. Facebook Pixel 设置项接入现有 settings 页面。

页面建议：

- `packages/web/app/pages/admin/import-api-tokens/index.vue`
- `packages/web/app/pages/admin/external-import-records/index.vue`
- `packages/web/app/pages/admin/external-import-records/[id].vue`
- 修改 `packages/web/app/pages/admin/settings.vue`
- 修改 `packages/web/app/layouts/admin.vue` 增加导航入口。

Token 创建交互：

- 创建成功后弹窗显示明文 token。
- 明确提示“只显示一次，请立即保存”。
- 关闭弹窗后不再显示明文。
- 列表只显示名称、权限、allowed sourceBotKey、状态、过期时间、最近使用时间。

导入记录详情交互：

- 展示状态、类型、sourceBotKey、externalMessageId、文件数、成功/失败数、错误摘要。
- 不展示 Telegram `file_id` 全文，建议只展示 `file_unique_id` 或文件名；若排查必须显示 `file_id`，需只在 Owner 模式下显示并脱敏。
- 不展示 Telegram 下载 URL、Bot Token、Import Token、R2 私有 key。

## 8. 环境与部署方案

### 8.1 dev 环境固定规则

API 和 Web 的 `wrangler.toml` dev 环境必须保留：

```toml
workers_dev = true
routes = []
```

dev API 和 dev Web 应继续使用：

- `https://meigallery-api-dev.250770503.workers.dev`
- `https://meigallery-web-dev.250770503.workers.dev`

dev API 响应保留：

```http
X-Robots-Tag: noindex, nofollow
```

dev Web 保留页面标识：

```text
DEV 测试环境
```

### 8.2 secrets

Telegram Bot Token：

```bash
pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT --env dev
```

生产 secret 仅在 dev 验收通过后配置：

```bash
pnpm --filter @meigallery/api exec wrangler secret put TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT
```

不得在文档、Issue、PR、commit message、聊天记录、日志中粘贴真实 token。

### 8.3 migrations

dev 验收：

```bash
pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --remote --env dev
```

生产发布前：

```bash
pnpm --filter @meigallery/api exec wrangler d1 migrations apply meigallery-db --remote
```

应用生产 migration 前必须先确认当前分支包含已验证 commit，并备份关键 D1 数据或确认可恢复路径。

## 9. 测试与验收

### 9.1 自动化测试

API 必须补充以下测试：

- `packages/api/src/utils/import-token.test.ts`：已完成。
- `packages/api/src/utils/import-validation.test.ts`：payload、MIME、数量、sortOrder、sourceBotKey。
- `packages/api/src/services/telegram-file-fetcher.test.ts`：mock Telegram getFile/download、secret 缺失、MIME 不匹配。
- `packages/api/src/services/telegram-file-id-import.test.ts`：创建记录、duplicate、状态查询、retry reset、失败清理。
- `packages/api/src/routes/imports.test.ts`：token 鉴权、权限、sourceBotKey、duplicate、查询隔离、retry 错误。
- `packages/api/src/routes/admin/import-api-tokens.test.ts`：Owner 权限、创建只返回一次、禁用、不泄露 hash。
- `packages/api/src/routes/admin/external-import-records.test.ts`：列表筛选、详情不泄露 token/download URL。
- `packages/api/src/utils/site-settings.test.ts`：Pixel settings key。

Web 如当前没有单测，MVP 使用构建验证和手动验收。后续如增加 Web 测试，应优先覆盖 Pixel PII 过滤纯工具。

### 9.2 必跑命令

每个阶段提交前运行：

```bash
pnpm --filter @meigallery/api test
pnpm --filter @meigallery/api exec tsc --noEmit
pnpm --filter @meigallery/web exec nuxt build
```

允许 Nuxt/Tailwind sourcemap warning，不允许测试、类型检查或构建失败。

### 9.3 dev smoke test

Telegram 导入：

- 缺少 Import Token 返回 `401 IMPORT_TOKEN_MISSING`。
- 无权限 token 返回 `403 IMPORT_PERMISSION_DENIED`。
- sourceBotKey 不允许返回 `403 IMPORT_SOURCE_BOT_NOT_ALLOWED`。
- 有效图库 payload 返回 `202 pending_media_fetch`。
- 重复 externalMessageId 返回原 `importId` 和 `duplicate`。
- 查询状态最终进入 `draft_created` 或 `failed`。
- `failed` 状态 `targetId=null`，且无目标草稿和可访问 R2 对象残留。

Facebook Pixel：

- dev 默认不加载生产 Pixel。
- Pixel ID 为空或关闭时不请求 `fbevents.js`。
- 生产测试 Pixel 启用后公开页面只触发 1 次 PageView。
- `/admin/**` 不触发 Pixel。
- Lead、Search、ViewContent、CompleteRegistration、login_completed 在 Meta Events Manager 5 分钟内可见。
- Network payload 不包含邮箱、联系方式、R2 key、Stream token、Telegram URL。

## 10. 实施阶段

### Phase 1: Telegram 后端核心

- 完成 payload 校验。
- 完成 Telegram file fetcher。
- 完成导入状态机 service。
- 完成 Bot API 路由。
- 完成 retry 和 duplicate 语义。

### Phase 2: Telegram 后台管理

- 完成 Import Token 后台 API。
- 完成外部导入记录后台 API。
- 完成后台列表与详情页面。
- 完成 Owner/Admin 权限和审计日志。

### Phase 3: Facebook Pixel MVP

- 新增 Pixel site settings migration。
- 接入 settings key 和后台设置校验。
- 实现前端 Pixel 工具、composable、client plugin。
- 接入 ViewContent、Search、Lead、CompleteRegistration、login_completed、filter_selected。
- 完成 dev 和生产测试 Pixel 验收。

### Phase 4: 质量门槛和生产准备

- 补齐 dev smoke test 文档。
- 运行 API 全量测试、API 类型检查、Web 构建。
- 应用 dev migration 并部署 dev Worker。
- 完成 curl/Bot/Meta Pixel Helper 验收。
- 经确认后应用生产 migration 并手动 Wrangler 部署生产。

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Telegram 下载耗时超过 Worker 可靠处理窗口 | 导入停留 fetching 或 failed | MVP 保持 service 独立，后续切 Queue；状态可查询和 retry |
| D1/R2 部分成功产生脏数据 | retry 不安全、后台误发布 | 失败清理优先删除 R2 和目标草稿，retry 前检查 target_id/r2_key/target_file_id |
| dev Worker 误绑定生产域名 | 生产事故 | 每次部署前检查 `workers_dev=true`、`routes=[]`，dev 页面 noindex |
| Pixel 误采集 PII | 隐私风险和广告账户风险 | 统一 PII 过滤，业务组件不直接调用 `fbq`，Network 手动审查 |
| 后台 token 泄露 | 导入 API 被滥用 | 明文只显示一次，hash 存储，支持禁用，速率限制和 allowlist |
| 首页入口过多 | 转化反而下降 | 已上线首页不做大改，只增量补追踪，后续用点击数据判断调整 |

## 12. 与既有文档关系

- `docs/superpowers/specs/2026-05-06-product-completion-prd.md`：本方案的需求来源。
- `docs/superpowers/specs/2026-05-06-telegram-import-api-technical-solution.md`：Telegram 导入的详细后端方案。
- `docs/superpowers/plans/2026-05-06-telegram-import-api.md`：Telegram 导入的逐任务实施计划。
- `docs/superpowers/specs/2026-05-06-facebook-pixel-attribution-technical-solution.md`：Facebook Pixel 的详细前端方案。
- `docs/superpowers/specs/2026-05-06-homepage-trust-navigation-ui-implementation-notes.md`：首页真实案例和规则入口的 UI 裁定依据。
- `docs/TECHNICAL_SPEC.md`：Cloudflare 架构、权限和媒体访问控制基线。
