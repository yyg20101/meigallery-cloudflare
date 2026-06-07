# MeiGallery 数据分析需求方案

## 0. 文档状态

- 状态：可落地需求方案草案。
- 日期：2026-06-07。
- 范围：邀请注册、访问来源、访问链路、点击次数、点击频率、浏览时长和配套埋点统计数据。
- 实施方式：先建设站内一方数据分析能力，再按需把关键转化事件同步给 Facebook Pixel 等第三方投放工具。

本文使用以下状态标签：

- `[当前实现]`：仓库已有代码、迁移或配置支持。
- `[新增需求]`：本方案建议新增并纳入后续实现计划。
- `[后续增强]`：MVP 后再做，避免首期复杂度过高。

## 1. Executive Summary

### Problem Statement

当前站点只有图库 `view_count`、`like_count`、后台基础概览和 Facebook Pixel 线索类事件，无法回答运营最关心的“用户从哪里来、如何浏览、在哪一步联系或注册、邀请注册链接是否有效、哪些内容真正带来会员转化”等问题。

### Proposed Solution

建设一套基于 Cloudflare Workers + D1 的站内一方数据分析系统：前端以轻量 SDK 采集匿名访客、会话、页面、点击、停留和转化事件；API 负责清洗、校验、批量归并和低成本入库；D1 默认只保存稳定事实、页面/session 汇总和日报聚合，高频原始事件按采样或后续 Workers Analytics Engine 处理；后台提供来源、链路、邀请、内容、点击、时长和转化看板。

### Success Criteria

- 首期能在后台按天查看访问来源、访问链路、页面停留、点击、搜索、筛选、联系站长、注册和邀请注册数据。
- 对同一匿名访客的同一会话能形成完整链路：入口来源 -> 落地页 -> 浏览页序列 -> 关键点击 -> 注册或联系。
- 邀请注册链接注册转化率、注册后会员发放转化率、邀请人或邀请码贡献可以按日、按邀请码、按渠道统计。
- 图库详情、广告位、联系入口和搜索筛选等核心事件的采集成功率在前端可执行环境中达到 95% 以上；离线、关闭页面和浏览器限制导致的失败单独计入丢失估算。
- 后台聚合报表在 100,000 条事件规模内 P95 响应时间 <= 1 秒；摘要查询默认限制在最近 90 天，采样原始明细默认限制在最近 30 天。
- 成本保护模式下，10,000 sessions / 天的浏览规模应控制在 80,000 D1 rows written / 天以内；普通浏览批次不得逐条写入曝光、点击心跳和滚动事件。
- 后台默认报表只查询聚合表和摘要表，30 天范围内单接口 D1 rows read 目标 <= 10,000，90 天范围内单接口 D1 rows read 目标 <= 30,000，禁止在首页看板直接扫描 `analytics_events`。

## 2. User Experience & Functionality

### User Personas

- Owner：查看全站转化、来源质量、邀请效果和内容价值，决定投放、内容和会员运营方向。
- Admin：查看具体内容、活动、邀请码和用户链路，辅助日常运营与客服跟进。
- 运营人员：不直接接触底层数据表，通过后台看板判断哪些来源、广告、标签和图库值得继续投入。
- 注册用户：正常使用站点，不需要感知埋点系统；其隐私、会员信息和受保护媒体访问不因分析功能而泄露。
- 访客：可以浏览公开内容；系统用匿名访客 ID 统计访问行为，不采集敏感个人信息。

### User Stories

**故事 1：查看访问来源 `[新增需求]`**  
作为 Owner，我希望知道用户来自直接访问、搜索、社交、外部链接、站内广告、邀请链接还是 UTM 活动，以便判断获客渠道质量。

验收标准：

- 后台支持按日期、渠道、来源域名、UTM、落地页查看访问量、访客数、注册数、联系点击数和会员发放数。
- 来源归因优先级为：邀请码 -> UTM 参数 -> 站内广告参数 -> referrer 域名 -> 直接访问。
- referrer 默认只保留来源域名和安全归一化路径，不保存 query 和 hash。
- 含 `token`、`api_key`、`signature`、`access_token` 等凭证类参数的 URL 不进入分析事件。

**故事 2：查看访问链路 `[新增需求]`**  
作为 Owner，我希望看到用户从入口页到图库详情、搜索、联系站长、注册的路径，以便优化页面结构。

验收标准：

- 后台展示 TOP 入口页、TOP 退出页、页面路径流转和关键漏斗。
- 支持查看典型链路：落地页 -> 搜索或发现页 -> 图库详情 -> 联系面板 -> 注册页。
- 统计链路时使用归一化 route，例如 `/gallery/:slug` 另带 `gallery_id`，避免高基数 URL 直接压垮报表。
- 后台默认展示聚合链路，不开放普通管理员查看单个访客的完整明细；Owner 可在排障场景按 session ID 查看脱敏事件。

**故事 3：统计点击次数和点击频率 `[新增需求]`**  
作为运营人员，我希望知道广告、图库卡片、联系入口、规则入口、登录注册入口、筛选标签等元素被点击多少次、哪些用户或访客点击频率最高，以便优化入口位置和文案。

验收标准：

- 关键点击事件必须包含 `element_id`、`element_type`、`location`、`target_type` 和 `target_id`。
- 报表同时展示点击次数、独立访客数、独立 session 数、登录用户数、点击率和人均点击次数。
- 同一访客 1 秒内对同一元素重复点击只计入原始事件，可在聚合指标中标记为重复点击并从有效点击中剔除。
- 外链点击只记录安全清洗后的目标域名和链接类型，不保存完整外部 URL query。

**故事 4：统计浏览时长 `[新增需求]`**  
作为 Owner，我希望知道每个页面、图库、标签结果和会话的有效浏览时长，以便判断内容吸引力。

验收标准：

- 页面停留时长按“页面可见且窗口处于前台”的有效时长统计。
- 前端在 `visibilitychange`、`pagehide`、路由切换和定时心跳时上报 active seconds。
- 后台展示平均停留时长、中位数停留时长、跳出率、滚动深度和有效浏览率。
- 单页面停留超过 30 分钟的异常值按 30 分钟截断，用于聚合；原始事件保留实际上报值和截断标识。

**故事 5：统计邀请注册 `[新增需求]`**  
作为 Owner，我希望创建邀请链接或邀请码，并知道它带来多少访问、注册、联系站长和会员发放，以便评估邀请和推广效果。

验收标准：

- Owner/Admin 可创建邀请码，设置名称、渠道、可用次数、有效期、备注和是否启用。
- 邀请链接格式建议为 `/register?invite=CODE` 或 `/?invite=CODE`，落地页自动保存邀请码上下文。
- 注册成功后记录邀请码、匿名访客、session、用户 ID、注册时间和归因来源。
- 管理员后续发放会员时，报表能将会员发放转化关联回邀请注册用户。
- 用户输入无效或过期邀请码时，注册流程不应崩溃，提示邀请码不可用并继续允许普通注册。

**故事 6：维护隐私与安全边界 `[新增需求]`**  
作为站点负责人，我希望数据分析不破坏当前媒体权限、来源页保护和隐私安全策略。

验收标准：

- 不保存原始 IP，不保存完整 user agent，不保存表单密码、验证码、邮箱明文、联系值、session token 或媒体私有 URL。
- 登录后只把事件关联到内部 `user_id`，后台展示默认以汇总为主，不把用户个人浏览链路作为普通运营报表。
- 受保护媒体访问仍必须由服务端权限校验，分析事件不能被前端伪造为授权依据。
- 后台分析接口必须要求 admin+，导出和单 session 明细建议仅 owner 可用。
- 所有后台分析配置写操作必须写入审计日志。

### Non-Goals

- 不建设第三方广告投放平台，不让第三方脚本成为站内分析的唯一数据源。
- 不实现普通用户上传、评论、私信或社交关系分析。
- 不采集受保护图片或视频的真实私有地址。
- 不保存明文 IP、完整外部 URL query、密码、验证码、session token 或敏感联系信息。
- 不把分析结果用于绕过会员权限、媒体访问控制或内容合规审核。
- 首期不做实时大屏、复杂用户画像、AI 推荐模型和跨设备强身份匹配。

## 3. AI System Requirements

本功能首期不需要 AI 系统。

后续如做智能洞察，只能基于聚合数据生成趋势摘要，不允许把单个用户的浏览链路、受保护媒体访问明细或敏感联系信息发送给外部模型。

## 4. Technical Specifications

### 当前实现基线

- `[当前实现]` `galleries.view_count`：图库详情接口按 cookie + IP 短期去重后异步递增。
- `[当前实现]` `galleries.like_count` 和 `gallery_likes`：登录用户可以点赞图库。
- `[当前实现]` `/api/admin/dashboard`：后台只返回图库、发布图库、用户、活跃会员、处理中导入任务数量。
- `[当前实现]` Facebook Pixel：前端可上报 `PageView`、`ViewContent`、`Search`、`Lead`、`CompleteRegistration`、`login_completed`、`filter_selected`，并已规避后台路径和敏感 URL。
- `[当前缺口]` 没有站内一方 `visitor`、`session`、`event`、`source attribution`、`duration`、`invite` 和 `daily aggregate` 数据模型。

### Architecture Overview

```text
浏览器
  -> 站内分析 SDK：生成 visitor_id/session_id，采集页面、点击、停留和转化事件
  -> POST /api/analytics/events：批量上报，服务端清洗、校验、限流、归并
  -> D1 事实与汇总层：稳定事实、页面摘要、session 摘要、日报聚合
  -> D1 sampled raw：仅保存调试采样和关键转化明细，默认不存高频原始事件
  -> Cron 聚合任务：生成日报、页面、来源、路径、邀请和点击聚合表
  -> 后台分析 API：读取聚合表，必要时读取脱敏明细
  -> Nuxt 后台看板：展示来源、链路、邀请、内容、点击、时长和转化
```

首期直接写入 D1，但按成本保护模式执行：浏览类数据先写页面/session 摘要和日聚合，邀请、注册、登录、会员发放等转化事实保留明细。后续若事件量增长，可把事件接收拆为 Cloudflare Queues 缓冲；若确实需要高频、高基数原始分析，再评估 Workers Analytics Engine；历史导出和归档文件放入 R2。Cloudflare 官方文档依据和成本预算见本文第 8 节。

### Integration Points

- Web 前端：新增 `useAnalytics` composable 和客户端插件，接入路由切换、点击代理、可见性、pagehide、注册、登录、联系、搜索、筛选、图库详情和广告组件。
- API Worker：新增公开采集接口、管理员报表接口、邀请管理接口和 Cron 聚合任务。
- D1：存储 visitor、session、邀请、转化事实、页面/session 摘要、采样原始事件和聚合表。
- R2：后续用于导出 CSV、归档采样原始事件和保存大查询报告文件。
- Turnstile：注册、登录仍走当前 Turnstile；事件采集接口不要求每次 Turnstile，但必须限流、校验事件 schema 和限制 payload。
- 审计日志：邀请码创建、禁用、导出分析数据、查看单 session 明细等后台行为写入 `admin_audit_logs`。
- Facebook Pixel：继续作为第三方营销辅助，只同步清洗后的标准转化事件，不替代站内一方分析。

### Data Model

#### analytics_visitors `[新增需求]`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 匿名访客 ID，使用高熵随机值 |
| first_seen_at | TEXT | 首次访问时间 |
| last_seen_at | TEXT | 最近访问时间 |
| first_source_channel | TEXT | 首次来源渠道 |
| first_landing_path | TEXT | 首次落地页归一化路径 |
| first_invite_code_id | TEXT | 首次邀请码，可为空 |
| user_id | INTEGER | 登录或注册后绑定的用户 ID，可为空 |
| consent_state | TEXT | granted / limited / denied |

说明：`visitor_id` 存在一方 cookie 或 localStorage。用户清理浏览器数据后视为新访客，不做跨设备强绑定。

#### analytics_sessions `[新增需求]`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | session ID |
| visitor_id | TEXT | 匿名访客 ID |
| user_id | INTEGER | 登录用户 ID，可为空 |
| started_at | TEXT | 开始时间 |
| ended_at | TEXT | 结束时间，可为空 |
| entry_path | TEXT | 入口路径 |
| exit_path | TEXT | 退出路径 |
| source_channel | TEXT | direct / search / social / referral / invite / ad / internal / unknown |
| source_name | TEXT | 来源名称，例如 google、telegram、invite_code_name |
| referrer_host | TEXT | 来源域名，可为空 |
| utm_source | TEXT | UTM source，可为空 |
| utm_medium | TEXT | UTM medium，可为空 |
| utm_campaign | TEXT | UTM campaign，可为空 |
| invite_code_id | TEXT | 邀请码 ID，可为空 |
| device_type | TEXT | desktop / tablet / mobile / unknown |
| country | TEXT | Cloudflare country，可为空 |
| active_seconds | INTEGER | 有效浏览秒数 |
| page_view_count | INTEGER | 页面浏览数 |
| event_count | INTEGER | 事件数 |

#### analytics_events `[新增需求]`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 事件 ID，前端生成并由服务端去重 |
| event_name | TEXT | 事件名称 |
| occurred_at | TEXT | 浏览器发生时间 |
| received_at | TEXT | 服务端接收时间 |
| visitor_id | TEXT | 匿名访客 ID |
| session_id | TEXT | session ID |
| user_id | INTEGER | 登录用户 ID，可为空 |
| route_name | TEXT | 归一化 route |
| path | TEXT | 清洗后的路径，不含敏感 query |
| page_title | TEXT | 页面标题，截断保存 |
| entity_type | TEXT | gallery / tag / ad / contact / invite / auth / media / system |
| entity_id | TEXT | 业务对象 ID，可为空 |
| event_props | TEXT | JSON，按事件字典白名单保存 |
| value | INTEGER | 数值型指标，例如时长、滚动深度、次数 |
| dedupe_key | TEXT | 聚合去重键，可为空 |

说明：`analytics_events` 在 MVP 中不作为完整原始事件仓库。默认只保存关键转化事件、错误排障事件和 1%-5% 采样浏览事件；后台报表必须优先读取摘要表和聚合表，避免 D1 rows read/write 随曝光和心跳线性增长。

#### invite_codes `[新增需求]`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 邀请码 ID |
| code_hash | TEXT | 邀请码 hash，避免明文批量泄露 |
| display_code | TEXT | 后台显示的短码，创建后可见 |
| name | TEXT | 活动或邀请名称 |
| channel | TEXT | 渠道，例如 telegram、wechat、partner、manual |
| inviter_user_id | INTEGER | 邀请人用户 ID，可为空 |
| status | TEXT | active / disabled / expired |
| max_uses | INTEGER | 最大使用次数，可为空 |
| used_count | INTEGER | 已注册使用次数 |
| expires_at | TEXT | 过期时间，可为空 |
| created_by | INTEGER | 创建管理员 |
| created_at | TEXT | 创建时间 |
| note | TEXT | 内部备注 |

首期默认只有 admin+ 在后台创建邀请码；普通用户自助邀请属于后续增强。

#### invite_registrations `[新增需求]`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 记录 ID |
| invite_code_id | TEXT | 邀请码 ID |
| visitor_id | TEXT | 匿名访客 ID |
| session_id | TEXT | 注册所在 session |
| invited_user_id | INTEGER | 注册成功后的用户 ID |
| source_channel | TEXT | 注册来源渠道 |
| landing_path | TEXT | 首次落地页 |
| registered_at | TEXT | 注册成功时间 |
| first_membership_granted_at | TEXT | 首次会员发放时间，可为空 |
| first_membership_rank | INTEGER | 首次发放会员 rank，可为空 |

#### 聚合表 `[新增需求]`

- `analytics_daily_sources`：按日期、渠道、来源、邀请码统计访客、session、页面、注册、联系、会员发放。
- `analytics_daily_pages`：按日期、route、path、entity 统计 PV、UV、入口、退出、跳出、平均时长、滚动深度。
- `analytics_daily_events`：按日期、event_name、entity 统计事件次数、独立访客、独立 session、登录用户。
- `analytics_path_edges`：按日期统计 from_route -> to_route 的转移次数和独立访客。
- `analytics_invite_daily`：按日期和邀请码统计落地、注册、联系、会员发放和转化率。
- `analytics_click_daily`：按日期、element_id、location、target 统计点击次数、有效点击、重复点击和点击率。

### API 设计

#### 公开采集接口 `[新增需求]`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/analytics/events` | 批量接收前端事件 |
| POST | `/api/analytics/session/end` | 兜底结束 session，可由 `sendBeacon` 调用 |
| GET | `/api/invites/:code/status` | 注册页校验邀请码状态 |

采集接口要求：

- 单次最多 20 个事件，payload <= 16KB。
- 只接受白名单事件名和白名单属性。
- 服务端覆盖 `received_at`、登录 `user_id`、Cloudflare 国家和环境信息。
- 对 visitor/session/event ID 做格式校验，event ID 唯一去重。
- 对 IP、user agent 和 referrer 做清洗派生，不保存原始值。
- 对采集接口按 IP、visitor 和 session 限流。

#### 管理员接口 `[新增需求]`

| 方法 | 路径 | 说明 | 角色 |
|------|------|------|------|
| GET | `/api/admin/analytics/overview` | 总览 KPI | admin+ |
| GET | `/api/admin/analytics/sources` | 来源分析 | admin+ |
| GET | `/api/admin/analytics/paths` | 访问链路 | admin+ |
| GET | `/api/admin/analytics/pages` | 页面与图库表现 | admin+ |
| GET | `/api/admin/analytics/clicks` | 点击与频率 | admin+ |
| GET | `/api/admin/analytics/durations` | 浏览时长 | admin+ |
| GET | `/api/admin/analytics/invites` | 邀请分析 | admin+ |
| GET | `/api/admin/analytics/sessions/:id` | 脱敏 session 明细 | owner |
| POST | `/api/admin/invite-codes` | 创建邀请码 | admin+ |
| PATCH | `/api/admin/invite-codes/:id` | 修改或禁用邀请码 | admin+ |
| GET | `/api/admin/invite-codes` | 邀请码列表 | admin+ |
| POST | `/api/admin/analytics/exports` | 创建导出任务 | owner |

### Event Dictionary

#### 全局公共字段

所有事件都必须包含：

| 字段 | 说明 |
|------|------|
| event_id | 前端生成 UUID，用于去重 |
| event_name | 事件名称 |
| occurred_at | 浏览器事件时间 |
| visitor_id | 匿名访客 ID |
| session_id | 会话 ID |
| route_name | 归一化 route |
| path | 当前路径，不含敏感 query |
| page_title | 当前页面标题 |
| referrer_host | 来源域名，可为空 |
| source_channel | 来源渠道 |
| device_type | desktop / tablet / mobile / unknown |
| viewport_width | 视口宽度分桶，例如 360、768、1024、1440 |
| consent_state | granted / limited / denied |

服务端补充：

| 字段 | 说明 |
|------|------|
| user_id | 从 session 解析，前端传入值不可信 |
| country | Cloudflare `CF-IPCountry` |
| app_env | production / dev / local |
| received_at | 服务端接收时间 |

#### 会话与页面事件

| 事件名 | 触发时机 | 关键属性 | 主要指标 |
|------|------|------|------|
| `session_start` | 新 session 创建 | entry_path、source_channel、utm、invite_code | session 数、入口来源 |
| `session_end` | pagehide、超时或后端聚合兜底 | exit_path、active_seconds、page_view_count | session 时长、退出页 |
| `page_view` | 首次进入和路由切换 | route_name、entity_type、entity_id、is_landing | PV、UV、入口页 |
| `page_leave` | 离开页面或路由切换 | active_seconds、max_scroll_depth、is_bounce | 停留时长、跳出率 |
| `engagement_ping` | 页面可见时每 15 秒在前端本地累计，默认不单独发网络请求 | active_seconds_delta | 有效浏览时长 |
| `scroll_depth` | 达到 25/50/75/90/100% | depth_percent | 阅读深度 |

#### 来源与广告事件

| 事件名 | 触发时机 | 关键属性 | 主要指标 |
|------|------|------|------|
| `source_detected` | session 归因完成 | source_channel、source_name、utm、referrer_host | 来源分布 |
| `home_ad_impression` | 首页广告进入视口 50% 且 >= 1 秒 | ad_id、position、creative_type | 广告曝光 |
| `home_ad_click` | 点击广告 CTA | ad_id、target_type、target_path_or_host | 广告点击率 |
| `outbound_link_click` | 点击安全外链 | target_host、location、link_type | 外链转化 |

#### 邀请注册事件

| 事件名 | 触发时机 | 关键属性 | 主要指标 |
|------|------|------|------|
| `invite_landed` | URL 带有效或待校验 invite | invite_code、landing_path | 邀请落地量 |
| `invite_code_checked` | 注册页校验邀请码 | invite_valid、failure_reason | 邀请码有效率 |
| `register_start` | 打开注册页或开始填写 | invite_code_id、source_channel | 注册意向 |
| `register_submit` | 提交注册表单前 | invite_code_id、email_verification_enabled | 注册提交 |
| `register_success` | 注册成功 | invite_code_id、new_user_id | 注册转化 |
| `register_failed` | 注册失败 | failure_code、invite_code_id | 注册失败原因 |
| `membership_granted_conversion` | 管理员首次给邀请注册用户发放会员 | invite_code_id、rank、days_to_grant | 会员转化 |

说明：`new_user_id` 由服务端写入，前端不得传入。失败原因只保存错误码，例如 `TURNSTILE_FAILED`、`EMAIL_EXISTS`、`INVITE_EXPIRED`。

#### 内容浏览事件

| 事件名 | 触发时机 | 关键属性 | 主要指标 |
|------|------|------|------|
| `gallery_card_impression` | 图库卡片进入视口 | gallery_id、list_type、position | 内容曝光 |
| `gallery_card_click` | 点击图库卡片 | gallery_id、list_type、position | 卡片点击率 |
| `gallery_detail_view` | 图库详情加载成功 | gallery_id、required_rank、tag_slugs | 详情访问 |
| `media_thumbnail_impression` | 图片缩略图进入视口 | gallery_id、asset_id、required_rank | 媒体曝光 |
| `media_viewer_open` | 打开图片查看器 | gallery_id、asset_id、index | 图片查看 |
| `media_access_request` | 请求受保护媒体 | asset_id、gallery_id、required_rank | 媒体访问需求 |
| `media_access_granted` | 服务端授权通过 | asset_id、gallery_id、required_rank | 授权访问 |
| `media_access_denied` | 服务端拒绝 | asset_id、gallery_id、required_rank、reason | 权限缺口 |
| `gallery_like_add` | 点赞成功 | gallery_id | 点赞数 |
| `gallery_like_remove` | 取消点赞成功 | gallery_id | 取消点赞数 |

#### 搜索与筛选事件

| 事件名 | 触发时机 | 关键属性 | 主要指标 |
|------|------|------|------|
| `search_submit` | 提交搜索 | has_query、query_length、tag_count、sort | 搜索次数 |
| `search_results_view` | 搜索结果返回 | result_count、page、sort | 搜索成功率 |
| `search_no_results` | 搜索无结果 | query_length、tag_count | 无结果率 |
| `filter_selected` | 选择标签 | tag_slug、tag_type、location | 筛选偏好 |
| `filter_removed` | 移除标签 | tag_slug、tag_type、location | 筛选调整 |
| `sort_changed` | 切换排序 | old_sort、new_sort、location | 排序偏好 |
| `load_more` | 加载更多 | route_name、page、result_count | 深度浏览 |

#### 联系和规则事件

| 事件名 | 触发时机 | 关键属性 | 主要指标 |
|------|------|------|------|
| `contact_panel_open` | 打开联系面板 | location | 联系意向 |
| `contact_method_click` | 点击或复制联系方式 | method_type、action_type、location | 联系方式偏好 |
| `rules_panel_open` | 打开服务流程浮层 | location | 规则关注 |
| `rules_page_click` | 点击完整规则页 | location | 规则深入 |
| `membership_cta_click` | 点击会员权益 CTA | location、required_rank | 会员意向 |

#### 认证事件

| 事件名 | 触发时机 | 关键属性 | 主要指标 |
|------|------|------|------|
| `login_start` | 打开登录页或开始填写 | redirect_type | 登录意向 |
| `login_submit` | 提交登录 | identifier_type | 登录提交 |
| `login_success` | 登录成功 | user_id、redirect_path_type | 登录成功率 |
| `login_failed` | 登录失败 | failure_code | 登录失败原因 |
| `logout_success` | 登出成功 | user_id | 登出数 |

### 指标定义

#### 邀请注册

- 邀请落地量：`invite_landed` 独立 session 数。
- 邀请注册提交量：`register_submit` 中包含 `invite_code_id` 的次数。
- 邀请注册成功量：`register_success` 中包含 `invite_code_id` 的用户数。
- 邀请注册转化率：邀请注册成功用户数 / 邀请落地独立 session 数。
- 邀请会员发放转化率：邀请注册后首次获得 rank > 0 的用户数 / 邀请注册成功用户数。
- 发放周期：`first_membership_granted_at - registered_at`，按中位数和 P75 展示。

#### 访问来源

- 访客数：按 `visitor_id` 去重。
- session 数：按 `session_id` 去重。
- 注册数：`register_success` 去重用户数。
- 联系数：`contact_method_click` 或 `contact_panel_open` 的独立 session 数。
- 来源质量：注册率、联系率、平均有效时长、详情页访问率和会员发放率。

#### 访问链路

- 入口页：session 第一条 `page_view`。
- 退出页：session 最后一条 `page_leave` 或聚合兜底。
- 路径边：同一 session 内相邻 `page_view` 的 from_route -> to_route。
- 关键漏斗：落地 -> 内容详情 -> 联系或注册 -> 会员发放。
- 跳出：session 仅 1 个 page_view 且 active_seconds < 15 秒。

#### 点击次数与点击频率

- 点击次数：`click` 类事件总数。
- 有效点击：去除 1 秒内同 visitor + element_id 重复点击后的数量。
- 独立点击访客：点击事件 visitor 去重数。
- 点击率：有效点击 session 数 / 曝光 session 数。
- 点击频率：有效点击次数 / 独立点击访客数，另提供每 session 点击次数。

#### 浏览时长

- 页面有效时长：页面可见期间累计 active seconds。
- session 有效时长：同一 session 内页面有效时长求和。
- 平均时长：总 active seconds / page_view 或 session 数。
- 中位数时长：按页面或 session 分布计算 P50。
- 深度浏览：active_seconds >= 60 秒或 scroll_depth >= 75%。

### 后台报表页面

#### `/admin/analytics` 总览 `[新增需求]`

- KPI：访客数、session 数、PV、注册数、邀请注册数、联系点击数、会员发放数、平均有效时长。
- 趋势：按日折线，支持 7 天、30 天、90 天。
- Top 列表：来源渠道、落地页、图库详情、点击元素、邀请码。

#### `/admin/analytics/sources` 来源分析 `[新增需求]`

- 渠道漏斗：访问 -> 详情 -> 联系 -> 注册 -> 会员发放。
- UTM 和 referrer 表格。
- 来源质量排序，默认按会员发放数和注册率综合排序。

#### `/admin/analytics/paths` 访问链路 `[新增需求]`

- TOP 入口页、退出页和跳出页。
- 路径边表格：from_route、to_route、次数、独立访客、转化率。
- 典型漏斗：入口页到联系或注册的路径。

#### `/admin/analytics/clicks` 点击分析 `[新增需求]`

- 元素点击排行：广告 CTA、图库卡片、联系入口、规则入口、会员 CTA、筛选标签。
- 点击频率异常提示：短时间重复点击、疑似刷新或误触。
- 支持按页面、元素类型、目标对象、设备筛选。

#### `/admin/analytics/durations` 时长分析 `[新增需求]`

- 页面平均/中位停留时长、有效浏览率、滚动深度分布。
- 图库详情按标题、标签、所需会员 rank 展示时长。
- 对跳出率高且停留短的页面给出运营排查入口。

#### `/admin/analytics/invites` 邀请分析 `[新增需求]`

- 邀请码列表：状态、落地量、注册数、会员发放数、转化率。
- 邀请码详情：来源、落地页、注册用户、首次会员发放情况。
- 支持禁用邀请码、复制链接和查看审计记录。

### Security & Privacy

- 不保存原始 IP；如需反刷，只用服务端临时内存或短期 hash，并设置保留期。
- 不保存完整 user agent；只解析并保存 device_type 和浏览器大类。
- referrer、当前 URL 和外链目标必须移除 query/hash，仅保留白名单 UTM 和安全域名。
- 事件 payload 使用白名单 schema，拒绝任意嵌套对象和超长字符串。
- 前端传入的 `user_id`、会员 rank、权限状态不可信，服务端必须从 session 和数据库派生。
- 分析接口不能返回私有 R2 key、Stream token、session token、邮箱明文、验证码或联系值。
- 管理员报表 admin+ 可访问；导出、单 session 明细和长期历史查询仅 owner。
- 数据保留建议：采样原始明细 30 天，页面/session 摘要 90 天，聚合日报 13 个月，导出文件 7 天自动删除。
- 若浏览器发送 Do Not Track 或站点后续提供隐私开关，`consent_state=limited` 时只保留必要聚合事件，不采集点击明细和时长心跳。

### Phased Rollout

#### MVP：一方事件采集与基础看板

- 新增 visitor、session、page/session summary、sampled events、invite、daily aggregate 数据模型。
- 新增前端 `useAnalytics` 和批量上报。
- 接入页面浏览、停留、滚动、搜索、筛选、图库详情、点赞、联系、注册、登录、广告点击和邀请注册事件。
- 后台提供总览、来源、邀请、页面、点击和时长基础报表。

#### v1.1：链路和转化增强

- 增加路径边聚合、关键漏斗、入口/退出分析。
- 将会员发放与邀请注册、来源和内容访问关联。
- 增加分析导出、Owner 单 session 脱敏明细和异常点击识别。

#### v2.0：规模和运营洞察

- 引入 Cloudflare Queues 缓冲事件写入。
- 采样明细和 owner 导出文件按需归档到 R2。
- 增加投放活动对比、内容价值评分、留存分析和聚合趋势摘要。

### Technical Risks

- D1 写入压力：首期通过批量上报、字段白名单、聚合表和保留期控制；高峰后再引入 Queues。
- 浏览器关闭导致丢事件：使用 `sendBeacon`、`pagehide` 和本地队列重试；仍需在报表中接受少量丢失。
- 隐私风险：严格清洗 URL、referrer、外链和 payload，不保存原始 IP、完整 UA 和敏感字段。
- 前端伪造事件：事件只用于分析，不能作为权限依据；服务端补齐可信身份字段并限流。
- 报表高基数：route 归一化，图库、广告、标签等业务对象使用 ID，不用任意 URL 直接分组。

## 5. 验收与测试

### 功能验收

- 邀请链接访问后，注册成功能生成 `invite_registrations`，后台邀请码详情能看到落地、注册和转化。
- 访问首页、发现页、搜索页、图库详情页后，后台页面报表能按日期展示 PV、UV、入口、退出和时长。
- 点击首页广告、图库卡片、联系入口、规则入口、会员 CTA 和筛选标签后，后台点击报表能按元素展示次数和频率。
- 搜索关键词、组合标签筛选和无结果搜索均有独立事件。
- 登录、注册失败和成功均记录错误码或成功事件，但不保存密码、验证码和邮箱明文。
- 受保护媒体访问成功或失败只记录资产 ID、图库 ID、required rank 和拒绝原因，不记录私有 URL。

### 安全验收

- 构造包含 `token`、`api_key`、`signature`、`access_token` 的 URL 时，分析 SDK 不上报敏感 URL，API 二次清洗仍拒绝。
- 未登录访客不能伪造 `user_id`；登录用户事件的 `user_id` 以服务端 session 为准。
- 普通 admin 不能访问 owner-only 的 session 明细和导出接口。
- 分析配置和邀请码写操作均写入审计日志。

### 测试建议

- API 单元测试：事件 schema 校验、URL 清洗、来源归因、邀请码状态、限流、去重、聚合 SQL。
- Web 单元测试：`useAnalytics` 队列、敏感 URL 跳过、visibility active seconds、sendBeacon payload、route 归一化。
- Playwright smoke：访问首页 -> 搜索 -> 图库详情 -> 打开联系 -> 注册页带 invite 参数，断言 mock API 收到预期事件。
- 数据回归测试：使用固定事件 fixtures 生成日报聚合，断言来源、路径、点击、时长和邀请转化指标。

## 6. 默认产品决策

- 首期邀请码由 admin+ 创建，普通用户自助邀请放到后续增强。
- 首期站内一方分析为主，Facebook Pixel 只保留第三方投放辅助，不作为后台报表数据源。
- 采样原始明细保留 30 天，页面/session 摘要保留 90 天，聚合数据保留 13 个月。
- 后台默认看聚合数据，Owner 才能查看脱敏 session 明细和导出。
- 不建设实时秒级大屏，日报聚合和近实时基础查询足够支撑当前运营。

## 7. 可落地实施规格

本节把需求拆成后续开发可直接领取的工程规格。实现时仍应先建功能分支或在 `dev` 上小步提交，每个阶段按项目要求运行 API 类型检查和 Web 构建。

### 7.1 推荐迁移拆分

当前 D1 migrations 已维护到 `0022_home_ads.sql`。数据分析建议从 `0023` 开始拆成四个迁移，降低单次变更和回滚风险。

| 迁移 | 内容 | 验收点 |
|------|------|------|
| `0023_analytics_core.sql` | `analytics_visitors`、`analytics_sessions`、`analytics_page_summaries`、`analytics_session_summaries`、`analytics_events` 采样表、核心索引 | 能插入匿名访客、session、页面摘要、session 摘要和采样事件；事件 ID 唯一去重 |
| `0024_invite_codes.sql` | `invite_codes`、`invite_registrations`、邀请码索引 | 能创建、禁用、校验邀请码，并关联注册用户 |
| `0025_analytics_aggregates.sql` | `analytics_daily_sources`、`analytics_daily_pages`、`analytics_daily_events`、`analytics_path_edges`、`analytics_invite_daily`、`analytics_click_daily` | Cron 或手动服务函数能写入日报聚合 |
| `0026_analytics_exports.sql` | `analytics_export_jobs`，用于 owner 导出任务 | 导出任务可记录状态、R2 key、过期时间和创建人 |

核心索引要求：

- `analytics_events(event_name, occurred_at)`：按事件和时间查询。
- `analytics_events(session_id, occurred_at)`：重建会话链路。
- `analytics_events(entity_type, entity_id, occurred_at)`：按图库、广告、标签等业务对象查询。
- `analytics_sessions(started_at, source_channel)`：来源趋势。
- `analytics_sessions(visitor_id, started_at)`：匿名访客 session。
- `invite_codes(status, expires_at)`：邀请码校验。
- `invite_registrations(invite_code_id, registered_at)`：邀请转化统计。
- 所有日报聚合表以 `date` 加主要维度建立唯一索引，便于重复聚合时 upsert。

### 7.2 D1 字段落地约束

- 时间统一存 ISO 字符串，服务端写入使用 `new Date().toISOString()`；聚合日期使用站点运营时区 `Asia/Shanghai` 的自然日。
- `visitor_id`、`session_id` 和 `event_id` 由前端生成 UUID，服务端校验格式；无效 ID 拒绝入库。
- `event_props` 必须是服务端重建后的白名单 JSON，不能原样保存前端传入对象。
- `path` 只保存 pathname 和允许的公开筛选参数；`token`、`code`、`signature`、`access_token` 等参数必须移除。
- `invite_codes.code_hash` 用服务端 secret 加 salt 后 hash；后台复制链接时只使用创建时返回的明文 code，列表页展示 `display_code`。
- `analytics_events.user_id` 只允许服务端从 `mei_session` 解析得到；前端 payload 中出现 `user_id` 时忽略。
- 普通浏览事件必须优先落到 `analytics_page_summaries`、`analytics_session_summaries` 和日报聚合；`gallery_card_impression`、`media_thumbnail_impression`、`engagement_ping` 不默认逐条写 `analytics_events`。
- 采样明细保留最近 30 天，页面/session 摘要保留最近 90 天；删除任务应放进现有 scheduled handler，和验证码清理、会员提醒并列执行。

### 7.3 API 请求和响应契约

#### `POST /api/analytics/events`

请求体：

```json
{
  "visitorId": "6f6f3f33-4f61-4f8b-bcf7-466f4e12b03a",
  "sessionId": "8eec8d08-4ed4-42f5-9f7e-f59e005f1288",
  "events": [
    {
      "eventId": "c0fc0486-f21e-4b35-8401-13de74c8df09",
      "eventName": "page_view",
      "occurredAt": "2026-06-07T10:30:00.000Z",
      "routeName": "/gallery/:slug",
      "path": "/gallery/summer-portrait-001",
      "pageTitle": "夏日写真",
      "entityType": "gallery",
      "entityId": "gal_123",
      "props": {
        "required_rank": 10,
        "tag_slugs": ["guangdong", "fresh"]
      }
    }
  ]
}
```

成功响应：

```json
{
  "accepted": 1,
  "rejected": 0,
  "duplicate": 0
}
```

部分失败响应仍返回 202，避免单个坏事件阻断整批：

```json
{
  "accepted": 2,
  "rejected": 1,
  "duplicate": 0,
  "errors": [
    {
      "eventId": "bad-id",
      "code": "INVALID_EVENT_ID",
      "message": "事件 ID 格式无效"
    }
  ]
}
```

整体非法请求使用现有统一错误体 `{ statusCode, message, code?, detail? }`。

服务端处理顺序：

1. 执行采集接口限流。
2. 校验 body 大小、事件数量和 ID 格式。
3. 解析 session cookie，派生可信 `user_id`。
4. 清洗 URL、referrer、page_title 和 props。
5. upsert visitor 和 session。
6. `INSERT OR IGNORE` 写入事件。
7. 返回 accepted、rejected、duplicate 计数。

#### `GET /api/invites/:code/status`

成功响应：

```json
{
  "valid": true,
  "inviteCodeId": "inv_123",
  "name": "六月 Telegram 活动",
  "channel": "telegram",
  "expiresAt": "2026-07-01T00:00:00.000Z"
}
```

失败响应：

```json
{
  "valid": false,
  "reason": "EXPIRED"
}
```

失败原因只允许：`NOT_FOUND`、`DISABLED`、`EXPIRED`、`USAGE_LIMIT_REACHED`。

#### `GET /api/admin/analytics/overview`

查询参数：

| 参数 | 说明 | 默认 |
|------|------|------|
| from | 起始日期，`YYYY-MM-DD` | 最近 30 天 |
| to | 结束日期，`YYYY-MM-DD` | 今天 |
| sourceChannel | 来源渠道筛选 | 全部 |
| inviteCodeId | 邀请码筛选 | 全部 |

响应字段：

| 字段 | 说明 |
|------|------|
| totals.visitors | 独立访客数 |
| totals.sessions | session 数 |
| totals.pageViews | PV |
| totals.registrations | 注册数 |
| totals.inviteRegistrations | 邀请注册数 |
| totals.contactClicks | 联系点击数 |
| totals.membershipGrants | 会员发放数 |
| totals.avgActiveSeconds | 平均有效浏览秒数 |
| trends | 按日趋势数组 |
| topSources | 来源排行 |
| topPages | 页面排行 |
| topClicks | 点击排行 |

### 7.4 后端模块拆分

建议新增以下文件，保持当前“路由薄、service/util 可测试”的持续收敛方向：

| 文件 | 职责 |
|------|------|
| `packages/api/src/routes/analytics.ts` | 公开事件采集和 session end |
| `packages/api/src/routes/invites.ts` | 公开邀请码状态查询 |
| `packages/api/src/routes/admin/analytics.ts` | 后台分析报表 |
| `packages/api/src/routes/admin/invite-codes.ts` | 后台邀请码管理 |
| `packages/api/src/services/analytics-ingest.ts` | 事件校验、清洗、入库 |
| `packages/api/src/services/analytics-aggregate.ts` | 日报聚合、路径边、清理过期原始事件 |
| `packages/api/src/services/invite-codes.ts` | 邀请码生成、hash、校验、使用次数 |
| `packages/api/src/utils/analytics-events.ts` | 事件名、字段白名单、props schema |
| `packages/api/src/utils/analytics-url.ts` | URL、referrer、UTM 和来源归因清洗 |
| `packages/api/src/utils/analytics-time.ts` | 运营时区日期、时长截断、聚合窗口 |

路由挂载建议：

- 在 `packages/api/src/index.ts` 中把 `/api/analytics` 放在 auth middleware 之后，让服务端能读取当前用户 session；同时单独给 `/api/analytics/*` 加采集限流。
- `/api/invites` 为公开 API，需放进公开 API 限流或独立邀请码限流。
- `/api/admin/analytics` 和 `/api/admin/invite-codes` 挂到 `adminRoutes`，复用 `requireAdmin`，导出和单 session 明细额外校验 owner。

采集限流建议：

| 维度 | 限制 |
|------|------|
| IP | 120 次 / 分钟 |
| visitor | 120 次 / 分钟 |
| session | 60 次 / 分钟 |
| 单次事件数 | 20 |
| 单次 body | 16KB |

### 7.5 前端 SDK 落地规格

建议新增：

| 文件 | 职责 |
|------|------|
| `packages/web/app/composables/useAnalytics.ts` | 暴露 `track`、`trackPageView`、`trackClick`、`flush`、`identifyUser` |
| `packages/web/app/plugins/analytics.client.ts` | 初始化 visitor/session，监听 route、visibility、pagehide |
| `packages/web/app/utils/analyticsSanitizer.ts` | URL、标题、props 本地预清洗 |
| `packages/web/app/utils/analyticsRoute.ts` | route 归一化和 entity 识别 |

SDK 行为要求：

- 首次进入生成 `visitor_id`，保存在一方 cookie 或 localStorage；失效期 180 天，用户清理后重新生成。
- session 默认 30 分钟无活动过期；路由切换不新建 session。
- 队列最多保留 50 条事件；达到 20 条、每 10 秒、路由切换、`visibilitychange=hidden`、`pagehide` 时触发 flush。
- 15 秒心跳只更新前端内存中的 active seconds，不单独入队；页面离开时发送 `page_leave` 或 `page_summary`。
- `pagehide` 优先使用 `navigator.sendBeacon`；不支持时退化为 `$fetch`，失败事件保留到 localStorage 下次重试。
- 当前 URL 或 referrer 含敏感凭证参数时，跳过该事件并记录本地 debug 日志，不把敏感值发给 API。
- `consent_state=limited` 时只上报 `session_start`、`page_view` 和聚合必要字段，不上报点击明细、滚动深度和心跳。
- SDK 不读取密码框、验证码、邮箱明文、联系值和任何表单正文。

首期必须接入的页面和组件：

| 位置 | 事件 |
|------|------|
| `app.vue` / 路由插件 | `session_start`、`page_view`、`page_leave`、`engagement_ping` |
| `pages/index.vue` 和 `HomeAdBand.vue` | `home_ad_impression`、`home_ad_click` |
| `GalleryCard.vue` / `GalleryGrid.vue` | `gallery_card_impression`、`gallery_card_click` |
| `pages/gallery/[slug].vue` | `gallery_detail_view`、`media_viewer_open`、`membership_cta_click` |
| `GalleryLikeButton.vue` 或详情页点赞逻辑 | `gallery_like_add`、`gallery_like_remove` |
| `pages/search.vue` | `search_submit`、`search_results_view`、`search_no_results`、`filter_selected` |
| `pages/discover.vue` | `filter_selected`、`filter_removed`、`sort_changed`、`load_more` |
| `ContactPanel.vue` | `contact_panel_open`、`contact_method_click`、`rules_panel_open`、`rules_page_click` |
| `pages/register.vue` | `invite_code_checked`、`register_start`、`register_submit`、`register_success`、`register_failed` |
| `pages/login.vue` | `login_start`、`login_submit`、`login_success`、`login_failed` |

### 7.6 后台页面落地规格

后台页面建议新增到 `packages/web/app/pages/admin/analytics/`：

| 页面 | 路径 | 数据源 |
|------|------|------|
| 总览 | `/admin/analytics` | `/api/admin/analytics/overview` |
| 来源 | `/admin/analytics/sources` | `/api/admin/analytics/sources` |
| 链路 | `/admin/analytics/paths` | `/api/admin/analytics/paths` |
| 点击 | `/admin/analytics/clicks` | `/api/admin/analytics/clicks` |
| 时长 | `/admin/analytics/durations` | `/api/admin/analytics/durations` |
| 邀请 | `/admin/analytics/invites` | `/api/admin/analytics/invites`、`/api/admin/invite-codes` |

后台 UI 要求：

- 复用现有 admin layout，不做营销式 hero。
- 默认时间范围为最近 30 天，提供 7 天、30 天、90 天快捷筛选。
- 数据为空时显示“暂无数据，部署埋点后会在这里展示”，不显示技术异常。
- 所有表格支持按核心指标排序；首期不要求复杂图表库，简单趋势卡片和表格即可。
- Owner-only 操作在非 owner 角色下不渲染入口，API 仍需二次校验。

### 7.7 分阶段交付清单

#### 阶段 A：核心数据闭环

产出物：

- 迁移 `0023_analytics_core.sql`。
- `POST /api/analytics/events`。
- `useAnalytics`、`analytics.client.ts`。
- 页面浏览、停留、路由切换和基础点击事件。

完成标准：

- 本地访问首页、发现页、图库详情页后，D1 中出现 visitor、session、page summary、session summary 和点击聚合；采样开关打开时才出现 sampled raw 事件。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit` 通过。
- `corepack pnpm --filter @meigallery/web exec nuxt build` 通过。

#### 阶段 B：邀请注册闭环

产出物：

- 迁移 `0024_invite_codes.sql`。
- 邀请码创建、禁用、状态查询。
- 注册页读取 invite 参数并绑定注册成功事件。
- 管理员会员发放后回填 `invite_registrations` 首次会员转化。

完成标准：

- 有效 invite 链接注册成功后能在后台邀请码详情看到注册数。
- 无效、禁用、过期和超过次数的邀请码均有明确提示。
- 会员发放后邀请转化指标更新。

#### 阶段 C：日报聚合和后台基础看板

产出物：

- 迁移 `0025_analytics_aggregates.sql`。
- `analytics-aggregate` service 和 scheduled handler 接入。
- `/admin/analytics`、`/admin/analytics/sources`、`/admin/analytics/invites`。

完成标准：

- 固定 fixtures 聚合后，来源、页面、邀请、点击和时长指标与预期一致。
- 后台 30 天默认报表能在 100,000 条事件 fixtures 下 P95 <= 1 秒。

#### 阶段 D：链路、点击频率和导出

产出物：

- 路径边聚合、点击去重聚合。
- `/admin/analytics/paths`、`/admin/analytics/clicks`、`/admin/analytics/durations`。
- owner-only 导出任务和 R2 导出文件。

完成标准：

- 能展示 from_route -> to_route 的 TOP 路径边。
- 点击报表能区分原始点击、有效点击和重复点击。
- owner 导出生成 CSV，7 天后过期清理。

### 7.8 测试矩阵

| 层级 | 必测内容 | 建议文件 |
|------|------|------|
| API unit | 事件 schema、URL 清洗、来源归因、props 白名单、重复事件、限流 | `analytics-ingest.test.ts`、`analytics-url.test.ts` |
| API unit | 邀请码 hash、状态校验、使用次数、过期、注册绑定 | `invite-codes.test.ts` |
| API unit | 日报聚合、路径边、点击去重、时长截断 | `analytics-aggregate.test.ts` |
| Web unit | visitor/session 生成、队列 flush、sendBeacon、敏感 URL 跳过、consent limited | `useAnalytics.test.ts` |
| Web unit | route 归一化、entity 识别、props 本地清洗 | `analyticsRoute.test.ts`、`analyticsSanitizer.test.ts` |
| Component unit | HomeAdBand、ContactPanel、GalleryCard 触发对应事件 | 现有组件测试扩展 |
| Playwright smoke | 首页 -> 搜索 -> 图库详情 -> 联系 -> 注册 invite 链路 | `packages/web/tests/smoke` 扩展 |

### 7.9 上线和回滚要求

- 上线顺序必须是 D1 migrations -> API 采集接口 -> Web SDK 默认关闭 -> 后台报表 -> 打开采集开关。
- 新增公开设置 `analytics_enabled`，默认 `false`；生产验证通过后由 Owner 在后台开启。
- Web SDK 必须读取 `analytics_enabled`，关闭时不初始化 visitor/session，不发事件。
- API 即使收到事件也要根据服务端开关决定是否入库；关闭时返回 `{ accepted: 0, rejected: 0, duplicate: 0, disabled: true }`。
- 回滚 Web 代码时，API 采集接口保留兼容空响应，避免旧页面缓存继续发送事件导致 404 噪音。
- 聚合任务失败不能影响现有验证码清理和会员到期提醒；scheduled handler 中每个任务独立 try/catch。

### 7.10 开发完成定义

数据分析 MVP 可认定为“可上线”必须同时满足：

- 迁移、API、Web SDK、后台三类实现均完成并有测试覆盖。
- 后台能看到最近 7/30/90 天的来源、页面、点击、时长和邀请核心指标。
- 邀请注册到会员发放的链路可被统计。
- 敏感 URL、原始 IP、完整 user agent、密码、验证码、session token 和私有媒体 URL 均无法进入分析表。
- `corepack pnpm --filter @meigallery/api exec tsc --noEmit` 通过。
- `corepack pnpm --filter @meigallery/web exec nuxt build` 通过。
- Playwright smoke 覆盖至少一条完整访问链路。

## 8. Cloudflare 性能与成本优化

### 8.1 官方文档依据

本节基于 2026-06-07 查阅的 Cloudflare 官方文档形成，后续真正实现或变更 Cloudflare 配置前必须再次核对最新文档。

| 主题 | 官方文档 | 对本项目的约束 |
|------|------|------|
| D1 价格 | [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) | D1 成本与 rows read、rows written 和 storage 直接相关；实现必须减少逐事件写入和后台扫描 |
| D1 限制 | [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) | 单库容量、查询和 API 限制会影响原始事件保留策略；原始高频事件不应无限写 D1 |
| D1 索引 | [Use indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) | 索引能减少查询扫描，但会增加写入成本；只给报表查询路径建必要索引 |
| Workers 限制 | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) | 采集接口必须控制 CPU、subrequest、body 和批量大小；清洗逻辑不能复杂到拖慢请求 |
| Queues 批处理 | [Batching, Retries and Delays](https://developers.cloudflare.com/queues/configuration/batching-retries/) | 当直接写 D1 影响延迟或 rows written 时，用 Queue 批处理降低同步压力 |
| Workers Analytics Engine 价格 | [Analytics Engine Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | 高频、高基数原始分析可评估 WAE，但不能替代 D1 中的业务转化事实 |
| Workers Analytics Engine 限制 | [Analytics Engine Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) | 单次 Worker invocation 可写 data point 数量有限，blob 大小和保留期也有限，不能当长期明细库 |

### 8.2 成本优化后的数据分层

| 层级 | 存储 | 保存内容 | 默认保留期 | 用途 |
|------|------|------|------|------|
| 事实层 | D1 | 邀请码、注册成功、登录成功、会员发放转化、媒体授权结果 | 13 个月 | 业务口径和转化核算 |
| 摘要层 | D1 | page summary、session summary、点击按批次归并结果 | 90 天 | 后台近 90 天报表和链路分析 |
| 聚合层 | D1 | 日报来源、页面、事件、路径、邀请、点击聚合 | 13 个月 | 默认后台看板 |
| 采样明细层 | D1 sampled raw | 1%-5% 浏览事件和错误排障事件 | 30 天 | 排障和指标校验 |
| 高频分析层 | Workers Analytics Engine `[后续增强]` | 曝光、点击、滚动、心跳等高基数数据点 | 按 WAE 文档保留 | 大规模行为探索 |
| 归档层 | R2 | owner 导出 CSV、月度归档文件 | 导出 7 天，归档按需 | 离线审计和备份 |

默认实现只启用事实层、摘要层、聚合层和采样明细层。WAE 和 Queues 都不是 MVP 必选项，只有达到阈值后再引入。

### 8.3 D1 rows read/write 预算

#### Dev / Free 安全模式

- 目标流量：<= 5,000 sessions / 天。
- D1 rows written 目标：<= 40,000 / 天。
- D1 rows read 目标：<= 80,000 / 天。
- 采样明细比例：1%。
- 后台报表默认范围：7 天，最多 30 天。

#### Production Paid 基线模式

- 目标流量：10,000 sessions / 天。
- D1 rows written 目标：<= 80,000 / 天。
- D1 rows read 目标：30 天默认看板 <= 10,000 / 接口；90 天报表 <= 30,000 / 接口。
- 采样明细比例：1%-5%，由后台开关控制。
- 原始采样明细保留：30 天。

#### 写入预算估算

| 数据 | 估算规则 | 10,000 sessions / 天写入预算 |
|------|------|------|
| visitor/session upsert | 每 session 1-2 行 | <= 20,000 rows |
| page summary | 平均 3 页 / session | <= 30,000 rows |
| session summary | 每 session 1 行 | <= 10,000 rows |
| 点击批次归并 | 只记录有效点击和聚合增量 | <= 10,000 rows |
| 转化事实 | 注册、邀请、登录、会员、媒体授权 | <= 5,000 rows |
| 日报聚合 | 按维度 upsert | <= 5,000 rows |

成本护栏：

- 不允许每 15 秒心跳直接写 D1。
- 不允许曝光事件默认逐条写 D1。
- 不允许后台默认报表扫描采样明细表。
- 不允许给 `event_props` 任意 JSON 字段建索引。
- 每个采集请求普通浏览路径最多执行 3 类 D1 写入：visitor/session upsert、summary upsert、aggregate increment。

### 8.4 查询性能要求

- 后台总览、来源、页面、点击、时长和邀请报表必须优先查聚合表。
- 明细查询必须显式选择 session ID、user ID、invite code 或 gallery ID，不提供无条件全量明细列表。
- 30 天默认看板 P95 <= 1 秒；90 天报表 P95 <= 2 秒。
- 聚合 SQL 必须有固定 fixtures 测试，验证 rows read 不随原始事件表线性增长。
- 实现时需要读取 D1 `result.meta` 中的 rows read/write，单元测试或集成测试记录预算断言。
- 对 `date`、`source_channel`、`route_name`、`entity_type/entity_id`、`invite_code_id`、`element_id` 建组合索引；不为高基数字符串全文字段建索引。

### 8.5 何时引入 Queues

首期可直接在采集 Worker 中同步写 D1，因为项目需要简单可部署。但出现任一条件时，必须把 `/api/analytics/events` 改成快速校验后入队，由 Queue consumer 批量写 D1：

- 采集接口 P95 > 300ms 且主要耗时来自 D1 写入。
- D1 rows written 超过 Production Paid 基线预算 80% 连续 3 天。
- 单个请求中需要归并的事件维度超过 20 个。
- 采集请求与管理员 API 争抢 D1 导致后台 P95 > 2 秒。

Queue consumer 要求：

- batch size 从 50 开始，最高不超过 Cloudflare 当前文档允许值。
- batch timeout 从 5 秒开始，根据写入延迟调优。
- consumer 内部按 date、route、element、invite 等维度归并后再写 D1。
- 重试失败必须可观测，不能重复增加业务转化事实；所有聚合 upsert 要幂等。

### 8.6 何时评估 Workers Analytics Engine

Workers Analytics Engine 适合高频、高基数、探索性行为分析，但它不是事务数据库，也不应作为邀请注册、会员发放或权限相关事实的唯一来源。

满足任一条件时进入 WAE 评估：

- 需要保留 100% 曝光、滚动、点击高频明细，但 D1 rows written 成本不可接受。
- 需要按大量高基数维度探索行为，例如 `gallery_id + tag + viewport + source + element`。
- 报表只需要近 3 个月探索分析，不需要长期精确审计。
- Owner 接受 WAE 的计费、保留期和查询方式约束。

WAE 接入边界：

- D1 继续保存业务事实和聚合口径。
- WAE 只保存脱敏行为数据点，不保存 user email、联系值、session token、私有媒体 URL 或完整 referrer query。
- 单次 Worker invocation 写入 WAE data point 数量必须低于 Cloudflare 当前限制；超出时采样或丢弃非关键事件。

### 8.7 运营成本看板

后台分析功能上线后，Owner 需要一个“数据采集健康”区域：

- 最近 24 小时采集请求数、accepted、rejected、duplicate。
- D1 rows read/write 估算和预算使用率。
- 采样率、丢弃事件数、敏感 URL 拦截数。
- Queue backlog 和失败数 `[后续增强]`。
- WAE data points 写入量 `[后续增强]`。
- 最近一次聚合任务耗时、成功状态和错误摘要。

### 8.8 性能和成本验收补充

- 使用 fixtures 模拟 10,000 sessions / 天、平均 3 page views / session、平均 2 clicks / session，验证 D1 rows written <= 80,000 / 天。
- 总览、来源、页面、点击、时长、邀请 6 个后台接口在 30 天 fixtures 下 P95 <= 1 秒。
- 关闭 `analytics_enabled` 后，Web 不初始化 SDK，API 返回 disabled 响应且不写 D1。
- 打开采样 5% 后，采样明细表行数在误差范围内接近总浏览事件的 5%，且后台默认看板不读取采样明细表。
- 构造 1,000 次重复点击，聚合结果必须区分 raw clicks、effective clicks 和 duplicate clicks，D1 写入不得达到 1,000 行。
