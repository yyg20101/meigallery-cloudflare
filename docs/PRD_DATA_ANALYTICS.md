# MeiGallery 数据分析需求方案

## 0. 文档状态

- 状态：需求方案草案。
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

建设一套基于 Cloudflare Workers + D1 的站内一方数据分析系统：前端以轻量 SDK 采集匿名访客、会话、页面、点击、停留和转化事件；API 负责清洗、校验、入库和聚合；后台提供来源、链路、邀请、内容、点击、时长和转化看板。

### Success Criteria

- 首期能在后台按天查看访问来源、访问链路、页面停留、点击、搜索、筛选、联系站长、注册和邀请注册数据。
- 对同一匿名访客的同一会话能形成完整链路：入口来源 -> 落地页 -> 浏览页序列 -> 关键点击 -> 注册或联系。
- 邀请注册链接注册转化率、注册后会员发放转化率、邀请人或邀请码贡献可以按日、按邀请码、按渠道统计。
- 图库详情、广告位、联系入口和搜索筛选等核心事件的采集成功率在前端可执行环境中达到 95% 以上；离线、关闭页面和浏览器限制导致的失败单独计入丢失估算。
- 后台聚合报表在 100,000 条事件规模内 P95 响应时间 <= 1 秒；原始事件查询默认限制在最近 90 天。

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
  -> POST /api/analytics/events：批量上报，服务端清洗、校验、限流、写入 D1
  -> D1 原始事件表：保存最近 90 天可排障事件
  -> Cron 聚合任务：生成日报、页面、来源、路径、邀请和点击聚合表
  -> 后台分析 API：读取聚合表，必要时读取脱敏明细
  -> Nuxt 后台看板：展示来源、链路、邀请、内容、点击、时长和转化
```

首期直接写入 D1，控制事件字段和采样，避免引入新的非 Cloudflare 基础设施。后续若事件量增长，可把事件接收拆为 Cloudflare Queues 缓冲，并把历史原始事件归档到 R2。

### Integration Points

- Web 前端：新增 `useAnalytics` composable 和客户端插件，接入路由切换、点击代理、可见性、pagehide、注册、登录、联系、搜索、筛选、图库详情和广告组件。
- API Worker：新增公开采集接口、管理员报表接口、邀请管理接口和 Cron 聚合任务。
- D1：存储 visitor、session、event、invite 和聚合表。
- R2：后续用于导出 CSV、归档过期原始事件和保存大查询报告文件。
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

- 单次最多 20 个事件，payload <= 32KB。
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
| `engagement_ping` | 页面可见时每 15 秒 | active_seconds_delta | 有效浏览时长 |
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
- 数据保留建议：原始事件 90 天，聚合日报 13 个月，导出文件 7 天自动删除。
- 若浏览器发送 Do Not Track 或站点后续提供隐私开关，`consent_state=limited` 时只保留必要聚合事件，不采集点击明细和时长心跳。

### Phased Rollout

#### MVP：一方事件采集与基础看板

- 新增 visitor、session、events、invite、daily aggregate 数据模型。
- 新增前端 `useAnalytics` 和批量上报。
- 接入页面浏览、停留、滚动、搜索、筛选、图库详情、点赞、联系、注册、登录、广告点击和邀请注册事件。
- 后台提供总览、来源、邀请、页面、点击和时长基础报表。

#### v1.1：链路和转化增强

- 增加路径边聚合、关键漏斗、入口/退出分析。
- 将会员发放与邀请注册、来源和内容访问关联。
- 增加分析导出、Owner 单 session 脱敏明细和异常点击识别。

#### v2.0：规模和运营洞察

- 引入 Cloudflare Queues 缓冲事件写入。
- 原始事件按月归档到 R2。
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
- 原始事件保留 90 天，聚合数据保留 13 个月。
- 后台默认看聚合数据，Owner 才能查看脱敏 session 明细和导出。
- 不建设实时秒级大屏，日报聚合和近实时基础查询足够支撑当前运营。
