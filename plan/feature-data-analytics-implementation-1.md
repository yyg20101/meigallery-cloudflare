---
goal: 数据分析能力实施计划
version: 1.0
date_created: 2026-06-07
last_updated: 2026-06-07
owner: MeiGallery
status: 'MVP 已实现，Phase 9 按阈值延后'
tags: [feature, analytics, cloudflare, d1, prd, cost]
---

# Introduction

![Status: MVP 已实现](https://img.shields.io/badge/status-MVP%20implemented-green)

本计划把 `docs/PRD_DATA_ANALYTICS.md` 拆成可执行工程阶段，用于实现站内一方数据分析能力。当前 Phase 0-8 已完成并验证，已在 Cloudflare Workers + D1 + R2 现有架构内覆盖邀请注册、访问来源、访问链路、点击次数、点击频率和浏览时长统计，同时把 D1 rows read/write、Worker 请求耗时和后续 Queues / Workers Analytics Engine 引入条件纳入验收。Phase 9 只在生产指标达到明确阈值后启动，不是当前默认上线依赖。

## 1. Requirements & Constraints

- **REQ-001**: 新增能力必须覆盖 `docs/PRD_DATA_ANALYTICS.md` 定义的 visitor、session、page summary、session summary、sampled events、invite code、invite registration、daily aggregate、export job 和采集健康指标。
- **REQ-002**: 首期必须实现 `/api/analytics/events`、`/api/analytics/session/end`、`/api/invites/:code/status`、`/api/admin/analytics/*`、`/api/admin/invite-codes/*` 和 owner-only 导出任务入口。
- **REQ-003**: Web 必须新增 `useAnalytics`、`analytics.client.ts`、URL 清洗、route 归一化、事件队列、`sendBeacon` 兜底和 `analytics_enabled` 开关读取。
- **REQ-004**: 后台必须能查看最近 7 天、30 天和 90 天的来源、页面、点击、时长、邀请和总览指标。
- **REQ-005**: 邀请注册链路必须把 invite landing、注册成功和首次会员发放转化关联到同一个 invite code。
- **SEC-001**: 分析事件不得保存原始 IP、完整 user agent、密码、验证码、session token、邮箱明文、联系值、私有 R2 key、Stream token 或完整外部 URL query/hash。
- **SEC-002**: 分析事件只用于统计，不能作为媒体授权、会员权限或后台权限依据；服务端必须从 session 和数据库派生 `user_id`、角色和会员 rank。
- **SEC-003**: 后台分析页面必须要求 admin+；导出任务和单 session 脱敏明细必须要求 owner。
- **SEC-004**: 邀请码创建、修改、禁用、导出任务创建和单 session 明细查看必须写入 `admin_audit_logs`。
- **PER-001**: 采集请求单次最多接收 20 个事件，payload 目标上限为 16KB；服务端必须在入库前执行 schema、长度、事件名和 props 白名单校验。
- **PER-002**: 10,000 sessions / 天、平均 3 page views / session、平均 2 clicks / session 的基线 fixtures 下，D1 rows written 目标必须 <= 80,000 / 天。
- **PER-003**: 后台默认报表必须优先读取日报聚合表和摘要表；30 天范围单接口 D1 rows read 目标 <= 10,000，90 天范围单接口 D1 rows read 目标 <= 30,000。
- **PER-004**: 30 天默认看板 P95 响应时间目标 <= 1 秒；90 天报表 P95 响应时间目标 <= 2 秒。
- **COS-001**: 默认不把 `gallery_card_impression`、`media_thumbnail_impression`、`engagement_ping`、滚动和曝光逐条写入 D1 原始表。
- **COS-002**: D1 只保存事实层、摘要层、聚合层和 1%-5% 采样明细；采样明细默认保留 30 天，页面/session 摘要默认保留 90 天，聚合日报默认保留 13 个月。
- **COS-003**: 不给 `event_props` 任意 JSON 字段建索引；只为报表查询路径建立必要组合索引，并在测试中记录 rows read/write。
- **COS-004**: 首期不默认引入 Cloudflare Queues 和 Workers Analytics Engine；只有达到 Phase 9 触发阈值后再实施。
- **CON-001**: 项目继续只使用 Cloudflare Workers、Workers Assets、D1、R2、Turnstile、WAF / Rate Limiting Rules、Queues 和 Workers Analytics Engine，不引入非 Cloudflare 运行时或外部数据库。
- **CON-002**: 当前代码事实已包含站内一方数据分析 MVP；生产启用仍必须保持 `analytics_enabled=false` 默认关闭，并按部署文档完成 migrations、API、Web、后台和 Owner 开关顺序。
- **CON-003**: 数据库变更必须使用 `packages/api/migrations/` 下的顺序 migration，当前下一批建议从 `0023` 开始。
- **CON-004**: 每个阶段完成后必须运行 `corepack pnpm --filter @meigallery/api exec tsc --noEmit` 和 `corepack pnpm --filter @meigallery/web exec nuxt build`。
- **GUD-001**: API 路由保持薄层实现，事件清洗、归因、聚合和邀请码业务放入 `packages/api/src/services/**` 和 `packages/api/src/utils/**`，并补单元测试。
- **PAT-001**: 前端后台复用现有 Nuxt admin layout，不做营销式 hero；表格、筛选、状态和空数据文案沿用现有后台风格。

## 2. Implementation Steps

### Implementation Phase 0

- GOAL-001: 建立功能开关、共享类型、事件字典和成本预算基线，确保后续阶段从关闭态安全接入。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 `packages/shared/src/types/index.ts` 新增 `AnalyticsEventName`、`AnalyticsEntityType`、`AnalyticsSourceChannel`、`AnalyticsEventPayload`、`AnalyticsBatchResponse`、`InviteCodeStatus` 和 `AnalyticsRangeQuery` 类型，并保持 Web 可消费类型不依赖 Worker binding。 | ✅ | 2026-06-07 |
| TASK-002 | 在 `packages/shared/src/constants/index.ts` 新增分析常量：`ANALYTICS_BATCH_EVENT_LIMIT = 20`、`ANALYTICS_BATCH_BODY_LIMIT_BYTES = 16384`、`ANALYTICS_DEFAULT_SAMPLE_RATE = 0.01`、`ANALYTICS_MAX_SAMPLE_RATE = 0.05`、`ANALYTICS_SESSION_IDLE_MINUTES = 30`、`ANALYTICS_VISITOR_TTL_DAYS = 180`。 | ✅ | 2026-06-07 |
| TASK-003 | 在 `packages/api/src/utils/analytics-events.ts` 定义事件名白名单、公共字段白名单、每类事件的 props schema、字段最大长度和允许的 `entity_type`。 | ✅ | 2026-06-07 |
| TASK-004 | 在 `packages/api/src/utils/analytics-url.ts` 实现 `sanitizeAnalyticsPath`、`sanitizeReferrer`、`deriveSourceAttribution`、`stripSensitiveParams` 和 `isSensitiveAnalyticsUrl`，复用现有 URL 安全工具的凭证参数、私网地址和反斜杠歧义拦截策略。 | ✅ | 2026-06-07 |
| TASK-005 | 在 `packages/api/src/utils/analytics-time.ts` 实现 `toOperationDateShanghai`、`clampActiveSeconds`、`parseAnalyticsRange` 和 7/30/90 天范围校验。 | ✅ | 2026-06-07 |
| TASK-006 | 在 `packages/api/src/utils/analytics-cost.ts` 实现 `readD1UsageMeta` 和 `assertD1Budget`，从 D1 `result.meta.rows_read`、`result.meta.rows_written` 和 `duration` 读取预算数据供测试和健康看板使用。 | ✅ | 2026-06-07 |
| TASK-007 | 在 `packages/api/src/utils/public-site-settings.ts` 和 `packages/web/app/composables/useSiteSettings.ts` 增加只读公开字段 `analytics_enabled`、`analytics_sample_rate` 和 `analytics_consent_mode`，默认关闭采集。 | ✅ | 2026-06-07 |
| TASK-008 | 为 `analytics-events.ts`、`analytics-url.ts`、`analytics-time.ts` 和公开设置解析新增单元测试，覆盖敏感 URL、凭证参数、route 清洗、时长截断和采样率上限。 | ✅ | 2026-06-07 |

### Implementation Phase 1

- GOAL-002: 以 D1 migrations 建立低成本数据模型，先落事实层、摘要层、聚合层和采样明细层。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | 新增 `packages/api/migrations/0023_analytics_core.sql`，创建 `analytics_visitors`、`analytics_sessions`、`analytics_page_summaries`、`analytics_session_summaries`、`analytics_events` 和 `analytics_ingest_health_daily`。 | ✅ | 2026-06-07 |
| TASK-010 | 在 `0023_analytics_core.sql` 增加 `site_settings` 默认键：`analytics_enabled=false`、`analytics_sample_rate=0.01`、`analytics_consent_mode=limited`，使用现有设置表 upsert 口径。 | ✅ | 2026-06-07 |
| TASK-011 | 在 `0023_analytics_core.sql` 为 `analytics_events(event_name, occurred_at)`、`analytics_events(session_id, occurred_at)`、`analytics_events(entity_type, entity_id, occurred_at)`、`analytics_sessions(started_at, source_channel)`、`analytics_sessions(visitor_id, started_at)` 建索引。 | ✅ | 2026-06-07 |
| TASK-012 | 新增 `packages/api/migrations/0024_invite_codes.sql`，创建 `invite_codes`、`invite_registrations`，并为 `invite_codes(status, expires_at)`、`invite_registrations(invite_code_id, registered_at)` 建索引。 | ✅ | 2026-06-07 |
| TASK-013 | 新增 `packages/api/migrations/0025_analytics_aggregates.sql`，创建 `analytics_daily_sources`、`analytics_daily_pages`、`analytics_daily_events`、`analytics_path_edges`、`analytics_invite_daily`、`analytics_click_daily`，所有日报表以 `date` 加主要维度建立唯一索引用于幂等 upsert。 | ✅ | 2026-06-07 |
| TASK-014 | 新增 `packages/api/migrations/0026_analytics_exports.sql`，创建 `analytics_export_jobs`，字段包含 `id`、`status`、`kind`、`range_from`、`range_to`、`r2_key`、`expires_at`、`created_by`、`created_at`、`error_message`。 | ✅ | 2026-06-07 |
| TASK-015 | 更新 `docs/TECHNICAL_SPEC.md` 的数据表摘要，新增数据分析表状态为 `[部分实现]`，并明确当前生产能力在接口、SDK 和后台页面接入前仍未完整可用。 | ✅ | 2026-06-07 |
| TASK-016 | 为四个迁移新增 schema 回归测试或 migration smoke，验证表、唯一索引、必需索引和默认设置键存在。 | ✅ | 2026-06-07 |

### Implementation Phase 2

- GOAL-003: 实现公开采集 API、session 结束 API 和服务端低成本归并写入。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-017 | 新增 `packages/api/src/services/analytics-ingest.ts`，实现 `ingestAnalyticsBatch(env, request, body)`，处理限流后校验、清洗、session 解析、visitor/session upsert、summary upsert、采样事件写入和计数响应。 | ✅ | 2026-06-07 |
| TASK-018 | 在 `analytics-ingest.ts` 中实现事件去重：使用 `analytics_events.id` 的 `INSERT OR IGNORE` 处理采样明细和关键转化事件，返回 `duplicate` 计数。 | ✅ | 2026-06-07 |
| TASK-019 | 在 `analytics-ingest.ts` 中实现浏览事件归并：`page_view`、`page_leave`、点击和时长更新 `analytics_page_summaries`、`analytics_session_summaries` 和当天聚合增量，不把心跳逐条写入原始表。 | ✅ | 2026-06-07 |
| TASK-020 | 新增 `packages/api/src/routes/analytics.ts`，实现 `POST /api/analytics/events` 和 `POST /api/analytics/session/end`；关闭 `analytics_enabled` 时返回 `{ accepted: 0, rejected: 0, duplicate: 0, disabled: true }` 且不写 D1。 | ✅ | 2026-06-07 |
| TASK-021 | 在 `packages/api/src/index.ts` 挂载 `/api/analytics` 路由，并为采集接口增加 IP、visitor、session 维度限流：IP 120 次/分钟、visitor 120 次/分钟、session 60 次/分钟。 | ✅ | 2026-06-07 |
| TASK-022 | 在 `analytics-ingest.ts` 中写入 `analytics_ingest_health_daily`，记录 accepted、rejected、duplicate、sensitive_blocked、sampled、dropped、estimated_rows_read、estimated_rows_written 和最大处理耗时。 | ✅ | 2026-06-07 |
| TASK-023 | 新增 `packages/api/src/services/analytics-ingest.test.ts`，覆盖非法 body、超过 20 事件、超过 16KB、敏感 URL、伪造 `user_id`、重复 event ID、采样关闭、采样 5%、关闭开关和部分失败 202 响应。 | ✅ | 2026-06-07 |
| TASK-024 | 新增 `packages/api/src/routes/analytics.test.ts`，覆盖公开路由挂载、统一错误体、限流和 session end 的 `sendBeacon` 兼容请求。 | ✅ | 2026-06-07 |

### Implementation Phase 3

- GOAL-004: 实现邀请码业务闭环，并把会员发放转化回填到邀请注册记录。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-025 | 新增 `packages/api/src/services/invite-codes.ts`，实现 `createInviteCode`、`hashInviteCode`、`verifyInviteCodeStatus`、`consumeInviteCodeForRegistration`、`disableInviteCode` 和 `recordFirstMembershipGrantConversion`。 | ✅ | 2026-06-07 |
| TASK-026 | 新增 `packages/api/src/routes/invites.ts`，实现 `GET /api/invites/:code/status`，只返回 `valid`、`inviteCodeId`、`name`、`channel`、`expiresAt` 或 `reason`，不返回 `code_hash`。 | ✅ | 2026-06-07 |
| TASK-027 | 新增 `packages/api/src/routes/admin/invite-codes.ts`，实现 `GET /api/admin/invite-codes`、`POST /api/admin/invite-codes`、`PATCH /api/admin/invite-codes/:id`，复用 `requireAdmin` 并写入审计日志。 | ✅ | 2026-06-07 |
| TASK-028 | 修改 `packages/api/src/routes/auth.ts` 注册成功流程：当请求包含有效 invite context 时，调用 `consumeInviteCodeForRegistration` 写入 `invite_registrations`，并保存 visitor/session/source/landing_path。 | ✅ | 2026-06-07 |
| TASK-029 | 修改 `packages/api/src/services/admin-users.ts` 的会员发放流程：首次给邀请注册用户发放 rank > 0 时，调用 `recordFirstMembershipGrantConversion` 回填 `first_membership_granted_at` 和 `first_membership_rank`。 | ✅ | 2026-06-07 |
| TASK-030 | 新增 `packages/api/src/services/invite-codes.test.ts` 和扩展 `packages/api/src/routes/auth-security.test.ts`、`packages/api/src/services/admin-users.test.ts`，覆盖有效、禁用、过期、次数耗尽、注册绑定和首次会员发放回填。 | ✅ | 2026-06-07 |

### Implementation Phase 4

- GOAL-005: 在 Web 端实现轻量 SDK 和核心页面埋点，默认关闭时不初始化、不写入本地 visitor/session。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-031 | 新增 `packages/web/app/utils/analyticsSanitizer.ts`，实现前端 URL、referrer、page title 和 props 预清洗，拒绝凭证参数、后台路径、API 路径、资源路径和私有媒体路径。 | ✅ | 2026-06-07 |
| TASK-032 | 新增 `packages/web/app/utils/analyticsRoute.ts`，实现 route 归一化：`/gallery/:slug`、`/cases/:slug`、`/admin/**` 跳过、搜索和发现页保留安全公开筛选参数。 | ✅ | 2026-06-07 |
| TASK-033 | 新增 `packages/web/app/composables/useAnalytics.ts`，暴露 `track`、`trackPageView`、`trackClick`、`trackPageLeave`、`flush`、`identifyUser` 和 `setConsentState`。 | ✅ | 2026-06-07 |
| TASK-034 | 在 `useAnalytics.ts` 中实现队列策略：队列最多 50 条，达到 20 条、每 10 秒、路由切换、`visibilitychange=hidden`、`pagehide` 时 flush；15 秒心跳只累计 active seconds。 | ✅ | 2026-06-07 |
| TASK-035 | 新增 `packages/web/app/plugins/analytics.client.ts`，读取公开设置中的 `analytics_enabled`；关闭时直接退出；开启时初始化 visitor cookie/localStorage、session、route watcher、visibility 和 pagehide。 | ✅ | 2026-06-07 |
| TASK-036 | 在 `analytics.client.ts` 中优先使用 `navigator.sendBeacon` 发送 `page_leave` 和 `session_end`，失败事件保存到 localStorage 并在下次启动重试。 | ✅ | 2026-06-07 |
| TASK-037 | 为 `analyticsSanitizer.ts`、`analyticsRoute.ts` 和 `useAnalytics.ts` 增加 Vitest 测试，覆盖 visitor/session 生成、过期、队列 flush、sendBeacon、敏感 URL 跳过、consent limited 和关闭开关。 | ✅ | 2026-06-07 |
| TASK-038 | 修改 `packages/web/app/pages/register.vue`，读取 `invite` 参数，调用 `/api/invites/:code/status`，在注册成功和失败时触发对应事件；无效 invite 只提示不可用并允许普通注册。 | ✅ | 2026-06-07 |
| TASK-039 | 修改 `packages/web/app/pages/login.vue`，接入 `login_start`、`login_submit`、`login_success`、`login_failed`，失败事件只保存错误码和 redirect 类型。 | ✅ | 2026-06-07 |

### Implementation Phase 5

- GOAL-006: 接入核心业务事件，覆盖页面、内容、广告、搜索、筛选、联系、规则、点赞和媒体授权。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-040 | 修改 `packages/web/app/pages/index.vue` 和 `packages/web/app/components/HomeAdBand.vue`，接入 `home_ad_impression`、`home_ad_click`，曝光必须使用 IntersectionObserver 且满足 50% 可见、持续 >= 1 秒。 | ✅ | 2026-06-07 |
| TASK-041 | 修改 `packages/web/app/components/GalleryCard.vue` 和图库网格相关组件，接入 `gallery_card_impression`、`gallery_card_click`，props 只包含 `gallery_id`、`list_type`、`position`。 | ✅ | 2026-06-07 |
| TASK-042 | 修改 `packages/web/app/pages/gallery/[slug].vue`，接入 `gallery_detail_view`、`media_viewer_open`、`membership_cta_click`、媒体访问成功和拒绝事件，不记录私有媒体 URL。 | ✅ | 2026-06-07 |
| TASK-043 | 修改 `packages/web/app/components/GalleryLikeButton.vue` 或详情页点赞逻辑，接入 `gallery_like_add` 和 `gallery_like_remove`，只在 API 成功后上报。 | ✅ | 2026-06-07 |
| TASK-044 | 修改 `packages/web/app/pages/search.vue`，接入 `search_submit`、`search_results_view`、`search_no_results`、`filter_selected`，不保存搜索关键词明文，只保存 `has_query`、`query_length`、`tag_count` 和 `sort`。 | ✅ | 2026-06-07 |
| TASK-045 | 修改 `packages/web/app/pages/discover.vue`，接入 `filter_selected`、`filter_removed`、`sort_changed`、`load_more`。 | ✅ | 2026-06-07 |
| TASK-046 | 修改 `packages/web/app/components/ContactPanel.vue` 和规则入口，接入 `contact_panel_open`、`contact_method_click`、`rules_panel_open`、`rules_page_click`、`membership_cta_click`，不保存联系值。 | ✅ | 2026-06-07 |
| TASK-047 | 修改 `packages/api/src/routes/media.ts`，在媒体访问授权成功或拒绝时写入服务端可信 `media_access_granted` / `media_access_denied` 聚合事实，拒绝前端伪造授权结果。 | ✅ | 2026-06-07 |
| TASK-048 | 扩展相关组件单元测试，验证核心点击事件只在用户动作或 API 成功后触发，且 payload 不包含敏感值、完整外链 query 或媒体私有地址。 | ✅ | 2026-06-07 |

### Implementation Phase 6

- GOAL-007: 实现日报聚合、保留期清理、后台分析 API 和数据采集健康看板。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-049 | 新增 `packages/api/src/services/analytics-aggregate.ts`，实现 `aggregateAnalyticsDaily(date)`、`aggregatePathEdges(date)`、`aggregateClickDaily(date)`、`cleanupAnalyticsRetention(now)` 和幂等 upsert。 | ✅ | 2026-06-07 |
| TASK-050 | 修改 `packages/api/src/index.ts` scheduled handler，把分析聚合和保留期清理作为独立 try/catch 任务接入，不能影响验证码清理和会员到期提醒。 | ✅ | 2026-06-07 |
| TASK-051 | 新增 `packages/api/src/routes/admin/analytics.ts`，实现 `overview`、`sources`、`paths`、`pages`、`clicks`、`durations`、`invites`、`health` 和 owner-only `sessions/:id`。 | ✅ | 2026-06-07 |
| TASK-052 | 所有 `packages/api/src/routes/admin/analytics.ts` 默认查询聚合表；session 明细必须要求显式 session ID，并只返回脱敏事件字段。 | ✅ | 2026-06-07 |
| TASK-053 | 新增 `packages/api/src/services/analytics-export.ts`，实现 owner-only 导出任务创建、CSV 生成到 R2、7 天过期清理和状态查询。 | ✅ | 2026-06-07 |
| TASK-054 | 新增 `packages/api/src/services/analytics-aggregate.test.ts`，使用固定 fixtures 验证来源、页面、路径边、点击去重、时长截断、邀请转化和保留期删除。 | ✅ | 2026-06-07 |
| TASK-055 | 新增 `packages/api/src/routes/admin/analytics.test.ts`，覆盖 admin+ 访问、owner-only 限制、时间范围、空数据、rows read/write 预算记录和统一错误体。 | ✅ | 2026-06-07 |

### Implementation Phase 7

- GOAL-008: 实现后台页面和导航，让运营能在关闭态、空数据态和有数据态下稳定查看指标。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-055A | 细化后台数据大盘设计文档，明确 MVP 决策闭环、首屏优先级、指标定义、统一 API 响应外壳、响应式规则和 Cloudflare 成本护栏。 | ✅ | 2026-06-07 |
| TASK-056 | 修改 `packages/web/app/layouts/admin.vue`，新增“数据分析”和“邀请码”导航入口，非 owner 不显示导出和 session 明细入口。 | ✅ | 2026-06-07 |
| TASK-057 | 新增 `packages/web/app/pages/admin/analytics/index.vue`，实现总览 KPI、7/30/90 天筛选、趋势表格、Top 来源、Top 页面、Top 点击和采集健康摘要。 | ✅ | 2026-06-07 |
| TASK-058 | 新增 `packages/web/app/pages/admin/analytics/sources.vue`，展示来源渠道漏斗、UTM/referrer 表格和来源质量排序。 | ✅ | 2026-06-07 |
| TASK-059 | 新增 `packages/web/app/pages/admin/analytics/paths.vue`，展示入口页、退出页、跳出页和 from_route -> to_route 路径边表格。 | ✅ | 2026-06-07 |
| TASK-060 | 新增 `packages/web/app/pages/admin/analytics/clicks.vue`，展示元素点击排行、raw clicks、effective clicks、duplicate clicks 和点击频率异常提示。 | ✅ | 2026-06-07 |
| TASK-061 | 新增 `packages/web/app/pages/admin/analytics/durations.vue`，展示页面平均/中位停留、有效浏览率、滚动深度和高跳出页面。 | ✅ | 2026-06-07 |
| TASK-062 | 新增 `packages/web/app/pages/admin/analytics/invites.vue`，展示邀请码列表、落地量、注册数、会员发放数、转化率，并提供创建、禁用和复制链接操作。 | ✅ | 2026-06-07 |
| TASK-063 | 新增 `packages/web/app/pages/admin/invite-codes.vue` 或把邀请码管理集成到 `analytics/invites.vue`，确保创建和禁用表单复用 `resolveApiErrorMessage` 并显示审计友好的操作结果。 | ✅ | 2026-06-07 |
| TASK-064 | 为后台分析页面增加组件或页面测试，覆盖空数据文案“暂无数据，部署埋点后会在这里展示”、日期筛选、排序、owner-only 操作隐藏和错误提示。 | ✅ | 2026-06-07 |

### Implementation Phase 8

- GOAL-009: 完成端到端验证、性能成本 fixtures、上线开关和回滚路径。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-065 | 扩展 `packages/web/tests/e2e/mock-api.mjs`，支持接收 `/api/analytics/events`、`/api/analytics/session/end`、`/api/invites/:code/status` 和后台分析 mock 响应。 | ✅ | 2026-06-07 |
| TASK-066 | 新增 Playwright smoke：`首页 -> 搜索 -> 图库详情 -> 打开联系 -> 点击联系方式 -> 带 invite 注册页`，断言 mock API 收到 page、click/contact、invite 和 register 事件，且无敏感 URL 或联系值。 | ✅ | 2026-06-07 |
| TASK-067 | 新增 API 性能成本 fixtures，模拟 10,000 sessions / 天、平均 3 page views / session、平均 2 clicks / session，断言 D1 rows written <= 80,000 / 天。 | ✅ | 2026-06-07 |
| TASK-068 | 新增后台报表性能测试 fixtures，构造 100,000 条事件规模并断言总览、来源、页面、点击、时长、邀请 6 个接口在 30 天范围内 P95 <= 1 秒。 | ✅ | 2026-06-07 |
| TASK-069 | 更新 `docs/PROJECT_STATUS.md`、`docs/TECHNICAL_SPEC.md` 和 `docs/DEPLOYMENT.md`，记录数据分析当前实现状态、开关默认关闭、迁移顺序、上线顺序和回滚策略。 | ✅ | 2026-06-07 |
| TASK-070 | 完成上线顺序验证：D1 migrations -> API 采集接口 -> Web SDK 默认关闭 -> 后台报表 -> Owner 打开 `analytics_enabled`。 | ✅ | 2026-06-07 |
| TASK-071 | 完成回滚验证：关闭 `analytics_enabled` 后 Web 不初始化 SDK，API 返回 disabled 响应且不写 D1；回滚 Web 后 API 仍兼容旧页面缓存发送的事件。 | ✅ | 2026-06-07 |
| TASK-072 | 运行 `corepack pnpm --filter @meigallery/api exec tsc --noEmit`、`corepack pnpm --filter @meigallery/web exec nuxt build`、相关 Vitest、Playwright smoke 和 `git diff --check`。 | ✅ | 2026-06-07 |

### Implementation Phase 9

- GOAL-010: 在达到明确阈值后实施 Cloudflare Queues 和 Workers Analytics Engine 后续增强，不把它们作为 MVP 默认依赖。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-073 | 当采集接口 P95 > 300ms 且主要耗时来自 D1 写入，或 D1 rows written 超过 80,000 / 天的 80% 连续 3 天时，在 `packages/api/wrangler.toml` 增加 Queue producer/consumer 配置。 | | |
| TASK-074 | 新增 `packages/api/src/services/analytics-queue-consumer.ts`，Queue consumer 以 `max_batch_size = 50`、`max_batch_timeout = 5` 为起点，按 date、route、element、invite 归并后再写 D1。 | | |
| TASK-075 | Queue consumer 必须逐条 `ack()` 已成功处理消息，失败消息 `retry()`，所有聚合 upsert 保持幂等，转化事实不能重复增加。 | | |
| TASK-076 | 当需要保留 100% 曝光、滚动、点击高频明细且 D1 rows written 成本不可接受时，新增 Workers Analytics Engine 评估文档和小流量实验，D1 继续保存业务事实和聚合口径。 | | |
| TASK-077 | WAE 接入时只写脱敏行为 data point，不写 user email、联系值、session token、私有媒体 URL 或完整 referrer query，并在单次 Worker invocation 内限制 data point 数量低于 Cloudflare 当前限制。 | | |
| TASK-078 | 更新后台采集健康区域，展示 Queue backlog、Queue failures、WAE data points 写入量和最近一次聚合任务耗时。 | | |

## 3. Alternatives

- **ALT-001**: 把所有浏览、曝光、点击和心跳事件逐条写入 D1。未采用，因为 D1 计费和性能直接受 rows read/write、索引写放大和查询扫描影响，高频事件逐条写入会快速提高成本并拖慢后台报表。
- **ALT-002**: 首期直接使用 Workers Analytics Engine 承接所有分析数据。未采用，因为邀请注册、会员发放和权限相关事实需要事务型业务口径、长期审计和与现有 D1 用户数据关联；WAE 更适合后续高频、高基数探索。
- **ALT-003**: 首期直接引入 Cloudflare Queues。未采用，因为当前项目需要先保持部署和调试简单；只有直接写 D1 的延迟或 rows written 接近阈值时再切换到队列批处理。
- **ALT-004**: 只保留 Facebook Pixel 作为分析数据源。未采用，因为第三方脚本不能覆盖邀请、会员发放、受保护媒体授权和后台一方数据闭环，也不应保存站内敏感链路。
- **ALT-005**: 后台直接查询 `analytics_events` 明细生成所有报表。未采用，因为默认报表必须受 rows read 预算保护，且普通 admin 不应浏览单访客完整链路。

## 4. Dependencies

- **DEP-001**: Cloudflare Workers、Workers Assets、D1、R2、Turnstile、WAF / Rate Limiting Rules 和 Workers Logs 继续作为现有运行基础。
- **DEP-002**: Cloudflare D1 的 rows read、rows written、storage、索引写入和 `result.meta` 计量能力用于成本验收。
- **DEP-003**: Cloudflare Workers 的请求体、CPU、内存、subrequest、Cron Trigger 和连接限制约束采集接口与 scheduled handler。
- **DEP-004**: Cloudflare Queues 的批处理、重试、延迟和计费模型只在 Phase 9 阈值触发后引入。
- **DEP-005**: Workers Analytics Engine 的 data point、blob、retention 和读查询计费模型只在 Phase 9 阈值触发后评估。
- **DEP-006**: 现有认证、会话、Turnstile、管理员权限、审计日志和会员发放服务必须保持兼容。
- **DEP-007**: 现有前端 `useSiteSettings`、`useAuth`、`useApiFetch`、后台 layout、统一错误解析和 Playwright smoke 基础设施。

## 5. Files

- **FILE-001**: `packages/shared/src/types/index.ts`：新增分析和邀请码共享类型。
- **FILE-002**: `packages/shared/src/constants/index.ts`：新增批量大小、采样率、session、visitor 和成本预算常量。
- **FILE-003**: `packages/api/migrations/0023_analytics_core.sql`：核心分析表、摘要表、采样事件表、健康日报和默认设置。
- **FILE-004**: `packages/api/migrations/0024_invite_codes.sql`：邀请码和邀请注册表。
- **FILE-005**: `packages/api/migrations/0025_analytics_aggregates.sql`：日报聚合、路径边、邀请和点击聚合表。
- **FILE-006**: `packages/api/migrations/0026_analytics_exports.sql`：owner 导出任务表。
- **FILE-007**: `packages/api/src/routes/analytics.ts`、`packages/api/src/routes/invites.ts`、`packages/api/src/routes/admin/analytics.ts`、`packages/api/src/routes/admin/invite-codes.ts`：新增 API 路由。
- **FILE-008**: `packages/api/src/services/analytics-ingest.ts`、`analytics-aggregate.ts`、`analytics-export.ts`、`invite-codes.ts`：新增业务服务。
- **FILE-009**: `packages/api/src/utils/analytics-events.ts`、`analytics-url.ts`、`analytics-time.ts`、`analytics-cost.ts`：新增分析工具。
- **FILE-010**: `packages/api/src/index.ts`：挂载路由、scheduled handler 和后续 Queue consumer。
- **FILE-011**: `packages/api/src/routes/auth.ts`、`packages/api/src/services/admin-users.ts`、`packages/api/src/routes/media.ts`：接入邀请注册、会员发放回填和服务端媒体授权事件。
- **FILE-012**: `packages/web/app/composables/useAnalytics.ts`、`packages/web/app/plugins/analytics.client.ts`、`packages/web/app/utils/analyticsSanitizer.ts`、`packages/web/app/utils/analyticsRoute.ts`：新增前端 SDK。
- **FILE-013**: `packages/web/app/pages/index.vue`、`search.vue`、`discover.vue`、`gallery/[slug].vue`、`register.vue`、`login.vue` 和相关组件：接入业务事件。
- **FILE-014**: `packages/web/app/pages/admin/analytics/**`、`packages/web/app/pages/admin/invite-codes.vue`、`packages/web/app/layouts/admin.vue`：新增后台页面和导航。
- **FILE-015**: `packages/web/tests/e2e/mock-api.mjs` 和 `packages/web/tests/e2e/**`：扩展端到端 mock 和 smoke。
- **FILE-016**: `docs/PRD_DATA_ANALYTICS.md`、`docs/TECHNICAL_SPEC.md`、`docs/DEPLOYMENT.md`、`docs/PROJECT_STATUS.md`：同步需求、技术状态、上线和回滚说明。

## 6. Testing

- **TEST-001**: API 类型检查：每个阶段运行 `corepack pnpm --filter @meigallery/api exec tsc --noEmit`。
- **TEST-002**: Web 构建检查：每个阶段运行 `corepack pnpm --filter @meigallery/web exec nuxt build`。
- **TEST-003**: API 单元测试：`analytics-events.test.ts`、`analytics-url.test.ts`、`analytics-time.test.ts`、`analytics-ingest.test.ts`、`analytics-aggregate.test.ts`、`invite-codes.test.ts`、`routes/analytics.test.ts`、`routes/admin/analytics.test.ts`。
- **TEST-004**: Web 单元测试：`analyticsSanitizer.test.ts`、`analyticsRoute.test.ts`、`useAnalytics.test.ts`，覆盖关闭开关、队列、`sendBeacon`、敏感 URL 和 consent limited。
- **TEST-005**: 组件测试：HomeAdBand、GalleryCard、ContactPanel、GalleryLikeButton 和注册/登录页面触发事件时 payload 不含敏感字段。
- **TEST-006**: Playwright smoke：覆盖首页、搜索、图库详情、联系面板、带 invite 注册页的完整路径，并断言 mock API 收到预期事件。
- **TEST-007**: 性能成本 fixtures：模拟 10,000 sessions / 天、平均 3 page views / session、平均 2 clicks / session，断言 D1 rows written <= 80,000 / 天。
- **TEST-008**: 后台报表 fixtures：100,000 条事件规模下总览、来源、页面、点击、时长和邀请 6 个接口 30 天范围 P95 <= 1 秒，且默认查询不扫描 `analytics_events`。
- **TEST-009**: 安全回归：构造含 `token`、`api_key`、`signature`、`access_token`、私有媒体 URL、后台路径和外部 URL query/hash 的事件，确认 SDK 跳过或 API 拒绝。
- **TEST-010**: 权限回归：普通 admin 不能访问 owner-only 导出和 session 明细；未登录用户不能访问后台分析；前端伪造 `user_id` 被服务端忽略。

## 7. Risks & Assumptions

- **RISK-001**: D1 索引能降低 rows read，但会增加写入和存储成本；必须用 fixtures 验证索引收益，不为高基数字符串和任意 JSON 字段建索引。
- **RISK-002**: 浏览器 `pagehide`、`sendBeacon`、隐私限制和网络关闭会造成少量事件丢失；后台需要展示采集健康和丢失估算，而不是承诺 100% 浏览事件。
- **RISK-003**: 采集接口如果与管理员 API 争抢同一个 D1 数据库，可能影响后台 P95；达到 Phase 9 阈值时必须引入 Queues 或进一步降低采样。
- **RISK-004**: 邀请码明文创建后可复制，但列表页只展示 `display_code`；如果管理员丢失完整邀请码，只能重新创建，不能从 hash 反推。
- **RISK-005**: 后台报表维度过多会带来高基数查询和 UI 复杂度；MVP 只开放来源、页面、点击、时长、邀请和路径边基础维度。
- **ASSUMPTION-001**: 当前项目继续以 `dev` 为开发主线，阶段性提交推送到 `origin/dev`。
- **ASSUMPTION-002**: 运营自然日使用 `Asia/Shanghai`，存储时间仍使用 ISO UTC 字符串。
- **ASSUMPTION-003**: 10,000 sessions / 天是 Production Paid 基线容量目标；真实流量超过该目标时按 Phase 9 阈值进入规模增强。
- **ASSUMPTION-004**: 采样明细用于排障和指标校验，不能作为后台默认报表数据源。

## 8. Related Specifications / Further Reading

- `docs/PRD_DATA_ANALYTICS.md`
- `docs/PROJECT_STATUS.md`
- `docs/TECHNICAL_SPEC.md`
- `docs/DEPLOYMENT.md`
- `docs/GIT_WORKFLOW.md`
- [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 Use indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Queues Batching, Retries and Delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Workers Analytics Engine Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Workers Analytics Engine Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
