# Meta CAPI 统一转化归因层设计

## 1. 背景

站点已经完成浏览器端 Meta Pixel MVP，并在后台数据分析中建立了一方 analytics 体系。当前 Pixel 能覆盖 `PageView`、`ViewContent`、`Search`、`Contact`、`Lead`、`CompleteRegistration`、`StartTrial` 等事件；后台数据分析则以站内事件、UTM、推广链接和 referrer 为数据源，不读取 Meta Pixel 回传。

随着 Facebook / Instagram 广告准备启动，仅靠浏览器 Pixel 会遇到广告拦截、浏览器隐私限制、iOS 信号损失和事件去重不可观测等问题。Meta 后台也已经提示接入 Conversions API。本设计把前一份“Facebook 广告投放启动设计”推进为可实施的架构方案：保留站内一方数据为事实来源，自管轻量 Meta CAPI，并建立统一转化事件层。

本阶段仍不进入实现，本文档用于明确后续 implementation plan 的范围和验收口径。

## 2. 目标

- 建立统一转化事件层，让站内 analytics、Meta Pixel 和 Meta CAPI 从同一个业务动作派生事件。
- 支持高价值事件的浏览器 + 服务端双通道上报，并通过同一 Meta `event_id` 去重。
- 让后台数据分析能展示 Meta CAPI 发送状态、失败原因、广告 UTM 效果和有效联系趋势。
- 保持 Cloudflare-only 架构，继续使用 Workers、D1、Worker Secrets 和现有部署流程。
- 明确合规边界：不上传邮箱、手机号、联系方式值、会员备注、私有媒体 URL、R2 key、Stream token 或后台路径。
- 降低发布风险：不一次性重写全站 analytics，不引入新的外部云平台或第三方网关。

## 3. 非目标

- 不在本阶段接入 Meta Marketing API，不自动创建广告系列、广告组、素材或预算。
- 不引入 Meta Conversions API Gateway、GTM Server-Side、Stape、TAGGRS、Addingwell 等外部托管链路。
- 不把 Cloudflare Zaraz 作为站内后台数据分析的唯一来源。
- 不对 `PageView`、普通筛选、普通浏览、后台管理行为做服务端 CAPI 上报。
- 不接入高级匹配，不上传 hash 后的邮箱或手机号。
- 不承诺站内后台展示 Meta 后台最终归因数；站内后台只展示站内触发数和 CAPI 发送结果。

## 4. 成熟工具评估结论

| 方案 | 结论 | 原因 |
|------|------|------|
| Meta Conversions API Gateway | 不作为本项目首选 | 官方、成熟、低代码，但通常需要 AWS/GCP 等外部云资源，不符合当前 Cloudflare-only 边界；对站内有效联系口径和后台看板控制力弱。 |
| Cloudflare Zaraz | 可作为后续辅助能力 | 与 Cloudflare 栈一致，支持 Facebook Pixel、HTTP Events API、Consent Management 和 Monitoring API；但配置主要在 Cloudflare Dashboard，不完全进入 Git/PR 流程，且不能替代站内一方数据口径。 |
| Meta Business SDK | 不作为 Worker 首期依赖 | 官方 SDK 成熟，但包体和 Node 运行时兼容风险高于本项目需要；Cloudflare Workers 虽支持 `nodejs_compat`，但 CAPI 首期只需少量 Graph API `fetch`。 |
| 自管轻量 CAPI | 本阶段推荐 | 控制力最高，能和现有 D1 analytics、后台看板、UTM 测试链接、合规过滤和部署流程保持一致。 |

## 5. 核心设计决策

### 5.1 一方数据是事实来源

站内 `analytics_events`、聚合表和 UTM 来源识别继续作为后台数据分析的事实来源。Meta Pixel 和 Meta CAPI 是广告平台同步通道，不反向成为后台大盘的数据源。

后台展示时必须区分：

- 站内转化：用户实际触发的站内事件，例如 `contact_method_click`。
- Pixel 触发：浏览器端已尝试发送的 Meta 事件，站内不承诺能知道 Meta 是否最终接收。
- CAPI 发送：API Worker 调用 Meta CAPI 的结果和错误分类。

### 5.2 统一转化事件层

新增逻辑层命名为“转化事件层”，实现时可落在前端 composable 和 API service 中。它负责把一个业务动作拆成三类输出：

```text
用户动作
  -> 站内 analytics 事件
  -> 浏览器 Meta Pixel 事件
  -> 服务端 Meta CAPI 事件
```

业务组件不再分别调用 `useAnalytics()`、`useFacebookPixel()` 和 CAPI 接口，而是调用统一转化入口。这样可以避免事件名、UTM、`event_id` 和脱敏逻辑分散。

### 5.3 Contact / Lead 口径调整

当前 Pixel 方案中，`Lead` 可能由联系面板展开触发。为了匹配“有效点击”的广告优化目标，本阶段调整为：

- `contact_panel_open` 只进入站内 analytics，不再触发 Meta `Lead`。
- 用户点击具体联系方式、复制联系方式、查看二维码或打开聊天链接时，才算有效联系动作。
- 有效联系动作派生 Meta `Contact`。
- 同一次会话首次有效联系动作派生 Meta `Lead`，用于广告优化目标。

这能减少“只是展开面板但没有真正联系”的无效转化进入 Meta 学习。

### 5.4 Meta 事件去重规则

一次业务动作生成一个 `conversion_action_id`，例如：

```text
conv_20260708_8f3k2p9x_contact
```

同一个业务动作可以派生多个 Meta 事件。每个 Meta 事件单独生成 `meta_event_id`：

```text
conv_20260708_8f3k2p9x_contact:Contact
conv_20260708_8f3k2p9x_contact:Lead
```

规则：

- 同一个 `meta_event_name` 的 Pixel 和 CAPI 必须使用完全相同的 `meta_event_id`。
- 不同 Meta 事件名不共用同一个 `meta_event_id`，避免 `Contact` 和 `Lead` 在排查时混淆。
- CAPI 侧以 `meta_event_id` 做幂等键；同一个 ID 已成功发送后，不重复调用 Meta。

## 6. 事件范围

| 业务动作 | 站内事件 | Meta 事件 | 触发条件 |
|----------|----------|-----------|----------|
| 具体联系方式点击 | `contact_method_click` | `Contact` | 用户点击 Telegram / WeChat / email / link / copy / QR 等具体联系方法。 |
| 首次有效联系 | `contact_method_click` | `Lead` | 同一会话第一次有效联系方式动作。 |
| 注册成功 | `register_success` | `CompleteRegistration` | 注册 API 成功后触发。 |
| 开始试用 | 后续显式试用事件 | `StartTrial` | 只有产品逻辑明确进入试用或免费会员体验时触发；如果当前没有独立试用动作，首期不发送 `StartTrial`。 |

不进入 CAPI 的事件：

- `PageView`
- `ViewContent`
- `Search`
- `filter_selected`
- `login_completed`
- 后台 `/admin/**` 行为
- 受保护媒体访问行为

## 7. 前端数据流

### 7.1 转化入口

新增统一转化入口，实施时建议命名为 `useConversionTracking()` 或 `useMarketingConversion()`。入口职责：

- 生成 `conversion_action_id`。
- 读取当前路由、UTM、推广链接来源、visitor/session、consent state 和设备上下文。
- 调用站内 analytics，高价值站内事件的 `eventId` 复用 `conversion_action_id`；如果现有组件已先生成普通 analytics ID，则由转化入口统一替换为本次动作 ID。
- 调用 `useFacebookPixel()` 发送 Meta Pixel，并传入 `eventID`。
- 调用 API Worker CAPI 接口，发送同一批 Meta 事件和上下文。

### 7.2 点击聊天跳转

联系方式跳转必须优先保证用户体验，不因为广告上报失败阻断打开聊天。

推荐行为：

1. 用户点击具体联系方式。
2. 前端同步生成转化 ID 和 Meta 事件 ID。
3. 立即触发站内 analytics、Pixel 和 CAPI 接口。
4. 对外链 / 深链跳转使用 `navigator.sendBeacon` 或 `fetch(..., { keepalive: true })` 发送 CAPI 请求，减少页面离开导致的丢失。
5. 按原交互打开聊天、复制内容或展示二维码。

如果后续发现外链跳转丢数明显，再单独设计内部 redirect 路由；本阶段不强制引入中间跳转页。

### 7.3 Pixel 调整

`useFacebookPixel()` 需要从“单独上报工具”变成“可接收事件 ID 的发送器”：

- `trackContactClick()` 接受 `eventId`。
- `trackCompleteRegistration()` 接受 `eventId`。
- `trackStartTrialOnce()` 接受 `eventId`。
- 调用 `fbq('track', eventName, payload, { eventID })`。
- 继续保留后台路由、敏感 URL 和调试脱敏保护。

## 8. API Worker 设计

### 8.1 接口

新增接口：

```text
POST /api/analytics/meta-capi-event
```

接口职责：

- 只接收公开页面触发的高价值 Meta 事件。
- 校验事件白名单、`meta_event_id`、URL、UTM、`fbp`、`fbc` 和业务字段长度。
- 读取请求 IP、User-Agent 和站点 Pixel ID。
- 根据配置和 Secret 判断是否发送 CAPI。
- 记录 CAPI 发送状态，用于后台数据分析。
- 非阻塞返回，不影响用户联系流程。

### 8.2 配置

继续使用现有 Pixel 设置：

- `facebook_pixel_enabled`
- `facebook_pixel_id`
- `facebook_pixel_debug_enabled`

新增站点设置：

- `meta_capi_enabled`：Owner 可开关，默认 `false`。
- `meta_capi_debug_enabled`：只记录脱敏调试状态，默认 `false`。

新增 Worker Secret：

- `META_CAPI_ACCESS_TOKEN`：生产和 dev 分别配置。
- `META_CAPI_TEST_EVENT_CODE`：可选，仅用于 Meta Test Events 验证。

Token 不进入 D1、前端 runtime config、后台表单或日志。Cloudflare 官方建议敏感 API key / token 使用 Worker Secret，本项目继续沿用该方式。

### 8.3 发送方式

首期不引入 Cloudflare Queues。API 接收请求后：

1. 写入 `queued` 或跳过状态。
2. 使用 Worker `waitUntil` 异步调用 Meta CAPI。
3. Meta 返回后更新发送状态。
4. 对网络错误和 Meta 5xx 做一次短重试。
5. 不做持久化重试队列；如果失败，后台可见，后续根据量级评估是否升级到 Queues。

这样可以避免用户点击聊天时等待 Meta API，同时保持实现范围可控。

## 9. CAPI Payload 口径

标准字段：

| 字段 | 口径 |
|------|------|
| `event_name` | `Contact`、`Lead`、`CompleteRegistration`、`StartTrial` |
| `event_time` | API Worker 接收时间，秒级 Unix timestamp |
| `event_id` | Pixel 和 CAPI 共用的 `meta_event_id` |
| `event_source_url` | 当前公开页面 URL，过滤敏感 query/hash |
| `action_source` | 固定为 `website` |

`user_data`：

| 字段 | 口径 |
|------|------|
| `client_ip_address` | Worker 请求上下文中的访客 IP |
| `client_user_agent` | 请求头 `User-Agent` |
| `fbp` | 浏览器 `_fbp`，格式校验通过才发送 |
| `fbc` | 浏览器 `_fbc` 或 `fbclid` 衍生值，格式校验通过才发送 |

`custom_data`：

| 字段 | 口径 |
|------|------|
| `location` | 固定枚举，如 `floating_contact_panel` |
| `method_type` | 联系方式类型，如 `telegram`、`wechat`、`email` |
| `action_type` | `open_link`、`copy`、`qr_view` |
| `utm_source` | 当前来源 |
| `utm_medium` | 当前媒介 |
| `utm_campaign` | 当前广告系列 |
| `utm_content` | 当前素材、受众或版位 |
| `tracking_source_slug` | 站内推广链接 slug，非必填 |

禁止字段：

- email、phone、nickname、username
- 具体联系方式值
- 会员备注、会员等级明细
- session token、cookie 原文
- R2 key、Stream token、私有媒体 URL
- 后台路径和后台操作详情

## 10. D1 数据模型

新增 CAPI 发送日志表，记录一条 Meta 事件的发送生命周期：

```text
meta_conversion_events
  id                     text primary key -- meta_event_id
  conversion_action_id   text not null
  analytics_event_id     text
  meta_event_name        text not null
  status                 text not null -- queued/sent/failed/skipped/invalid/duplicate_suppressed
  status_reason          text
  event_source_path      text not null
  utm_source             text
  utm_medium             text
  utm_campaign           text
  utm_content            text
  source_channel         text
  method_type            text
  action_type            text
  events_received        integer
  fbtrace_id             text
  error_code             text
  error_message          text -- 截断后的脱敏错误
  occurred_at            text not null
  sent_at                text
  created_at             text not null
  updated_at             text not null
```

新增日聚合表，用于后台趋势和来源筛选：

```text
analytics_meta_conversion_daily
  date                   text not null
  meta_event_name        text not null
  status                 text not null
  utm_source             text not null default ''
  utm_medium             text not null default ''
  utm_campaign           text not null default ''
  utm_content            text not null default ''
  source_channel         text not null default 'unknown'
  count                  integer not null default 0
  primary key(date, meta_event_name, status, utm_source, utm_medium, utm_campaign, utm_content, source_channel)
```

保留策略：

- `meta_conversion_events` 保留 90 天，用于排查。
- `analytics_meta_conversion_daily` 长期保留，用于趋势。
- 每日 Cron 可清理 90 天前的发送日志。

## 11. 后台数据分析设计

后台不把 Pixel 当作数据源，而是新增“Meta 同步状态”视角。

总览页新增：

- Meta CAPI 状态条：已启用 / 未启用 / Secret 缺失 / 最近成功发送时间。
- 近 7 / 30 / 90 天 CAPI 成功数、失败数、跳过数。
- 失败率超过阈值时进入风险队列。

来源页新增：

- 按 `utm_campaign` 和 `utm_content` 展示站内有效联系数。
- 同表展示 CAPI `Contact` / `Lead` 成功数和失败数。
- 明确提示：FB / Facebook / Meta 来源来自 UTM、推广链接或 referrer；不是 Pixel 回传。

点击页新增：

- 联系点击的站内有效数。
- 对应 Meta `Contact` 发送状态。
- 重复点击不作为有效联系，不重复触发 `Lead`。

健康页新增：

- CAPI 配置状态。
- 最近 Meta API 错误分类。
- Secret 缺失、Pixel ID 缺失、CAPI disabled、参数 invalid 的计数。

## 12. 合规与同意状态

本项目第一阶段不上传 PII，也不做高级匹配。广告网络发送仍属于营销追踪，需要保留同意状态接入点。

规则：

- 用户明确拒绝追踪时，不加载 Pixel，不调用 CAPI。
- 后台和受保护媒体页面不触发 Pixel / CAPI。
- 当前未上线完整 CMP 前，不扩大到强隐私合规地区的大预算投放。
- 后续如果面向 EU / UK / CA 等地区投放，应优先评估 Cloudflare Zaraz CMP 或自建同意管理，再默认启用广告追踪。

## 13. 失败处理

| 场景 | 行为 |
|------|------|
| `meta_capi_enabled=false` | 记录 `skipped`，原因 `disabled`，不调用 Meta。 |
| `META_CAPI_ACCESS_TOKEN` 缺失 | 记录 `skipped`，原因 `missing_secret`，后台健康页提示。 |
| Pixel ID 缺失 | 记录 `skipped`，原因 `missing_pixel_id`。 |
| `meta_event_id` 非法 | 返回 400，记录 `invalid`；不调用 Meta。 |
| Meta API 4xx | 记录 `failed` 和脱敏错误码；不重试。 |
| Meta API 5xx / 网络错误 | 一次短重试，仍失败则记录 `failed`。 |
| 同一 `meta_event_id` 重复请求 | 如果已 sent，记录或返回 `duplicate_suppressed`，不重复调用 Meta。 |

任何 CAPI 失败都不阻断聊天跳转、复制联系方式、二维码展示、注册完成或试用开始。

## 14. 测试策略

单元测试：

- 转化事件 ID 和 Meta 事件 ID 生成。
- Contact / Lead / CompleteRegistration / StartTrial 映射。
- Pixel `eventID` 参数传递。
- CAPI payload 构造和字段白名单。
- `fbp`、`fbc`、URL、UTM、method/action 字段校验。
- PII、敏感 URL、Token、R2 key 过滤。
- Secret 缺失、Pixel ID 缺失、CAPI disabled 降级。
- 幂等和重复发送抑制。

集成测试：

- 点击具体联系方式后，站内 analytics、Pixel 和 CAPI 请求共享同一转化动作 ID。
- 同一会话首次有效联系方式点击触发 `Lead`，后续有效点击只触发 `Contact`。
- 注册成功触发 `CompleteRegistration`。
- 试用入口触发 `StartTrial`。
- `/admin/**` 不触发 Pixel 或 CAPI。
- CAPI 失败不影响用户操作。

人工验收：

- 使用 Meta Test Events 验证 `Contact`、`Lead`、`CompleteRegistration`、`StartTrial`。
- 使用 Meta Pixel Helper 验证浏览器事件和 `eventID`。
- 后台数据分析按日期、`utm_campaign`、`utm_content` 查看有效联系和 CAPI 状态。
- 浏览器 Network 和 Worker 日志中不出现邮箱、手机号、联系方式值、token、R2 key 或私有 URL。

## 15. 发布步骤

1. 在 `dev` 分支完成实现并部署 dev。
2. dev 使用测试 Pixel 或 Meta Test Events，不污染生产 Pixel。
3. 生产前在 Cloudflare API Worker 配置 `META_CAPI_ACCESS_TOKEN`。
4. Owner 在后台启用 `meta_capi_enabled`。
5. 小流量验证 Contact / Lead 去重。
6. 观察后台 CAPI 失败率和 Meta 重复事件提示。
7. 验证稳定后再扩大广告预算。

## 16. 后续增强

- 如果 CAPI 失败率高或发送量上升，升级为 Cloudflare Queues 持久化重试。
- 如果需要区域化同意管理，评估 Cloudflare Zaraz CMP 或自建 CMP。
- 如果需要导入 Meta 广告花费、campaign/ad set/ad 数据，再单独设计 Meta Marketing API 接入。
- 如果需要更多平台投放，复用统一转化事件层接入 Google Ads、TikTok 或 Reddit。
- 如果需要更强匹配质量，再在明确合规依据后评估高级匹配。

## 17. 参考

- `docs/UI_DATA_ANALYTICS_DASHBOARD.md`
- `packages/web/app/composables/useFacebookPixel.ts`
- `packages/web/app/composables/useAnalytics.ts`
- `packages/api/src/services/analytics-ingest.ts`
- Meta Conversions API：`https://developers.facebook.com/documentation/ads-commerce/conversions-api`
- Meta Conversions API Gateway：`https://developers.facebook.com/documentation/ads-commerce/gateway-products/conversions-api-gateway`
- Cloudflare Zaraz：`https://developers.cloudflare.com/zaraz/`
- Cloudflare Workers Secrets：`https://developers.cloudflare.com/workers/configuration/secrets/`
