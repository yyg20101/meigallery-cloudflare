# 后台数据大盘设计方案

## 0. 文档状态

- 状态：后台数据分析大盘 UI / UX 设计基线，已用于当前 `/admin/analytics` 首版实现。
- 日期：2026-06-07。
- 范围：`/admin/analytics` 及其子页面的数据结构、布局、组件、交互状态、权限边界、验收标准和后续增强路线。
- 关联文档：`docs/PROJECT_STATUS.md`、`docs/TECHNICAL_SPEC.md`、`docs/UI_DESIGN.md`。
- 当前说明：本文记录当前首版大盘的设计口径和后续增强方向；标注为后续增强的内容不代表当前生产能力。
- 2026-06-08 更新：总览页已重做为工作台式大盘，补齐采集健康条、趋势面板、转化漏斗、Top 列表、风险队列和空数据状态；健康详情页不再在无日报时显示空白。

本文使用以下状态标签：

- `[当前实现]`：仓库已有代码、页面、API、迁移或测试支撑。
- `[新增设计]`：建议纳入后续实现的 UI / UX 方案。
- `[实现约束]`：实现时必须遵守的工程、安全、性能或成本边界。
- `[后续增强]`：MVP 后再做，避免首期大盘复杂度过高。

## 1. Executive Summary

### Problem Statement

当前后台只有基础数量概览，无法让 Owner / Admin 快速判断“今天哪里来的用户更有价值、哪些内容带来联系或注册、邀请码是否有效、浏览链路在哪一步断掉、采集成本是否健康”。

### Proposed Solution

设计一个工作台式后台数据大盘：以“运营决策”为主线，把来源、内容、链路、点击、时长、邀请和采集健康组织成可扫描的多页看板。MVP 默认读取 D1 聚合表和摘要表，不做炫技实时大屏，不扫描高频原始事件，确保成本和响应时间可控。

### Success Criteria

- Owner / Admin 在 `/admin/analytics` 30 秒内能回答：今日访客、注册、联系、邀请注册、会员发放、来源 TOP、页面 TOP、点击 TOP 和采集健康是否异常。
- 默认 30 天范围下，总览、来源、页面、点击、时长、邀请 6 类页面首屏 P95 响应时间 <= 1 秒。
- 所有大盘页面在 360px、768px、1024px、1440px 视口下无横向溢出、文字遮挡和按钮挤压。
- 普通 admin 看不到 owner-only 的导出、单 session 明细和采集成本深度操作；API 仍必须二次校验。
- 空数据、采集关闭、聚合延迟、查询失败、权限不足和成本告警均有明确 UI 状态，不展示原始异常堆栈。

## 2. User Experience & Functionality

### 2.1 User Personas

- Owner：关注获客质量、邀请转化、会员发放、内容价值和采集成本，拥有导出和脱敏 session 明细权限。
- Admin：关注日常运营动作，查看来源、内容、点击、邀请效果，辅助客服、内容发布和会员发放。
- 运营人员：通过排序表和漏斗判断下一步优化方向，不需要理解底层 D1 表或事件明细。

### 2.2 Design Direction

**审美方向：精密运营舱。**

后台数据大盘不是营销页，也不是电视墙式炫酷大屏。它应像一张干净、压缩得当的运营地图：黑白灰提供秩序，青绿色表示健康和增长，金色只标记会员/转化价值，蓝色标记来源流量，红色只用于风险和成本告警。视觉记忆点是“从入口到会员发放的一条细金色转化线”，让用户一眼知道这里不是泛泛流量报表，而是 MeiGallery 的会员运营看板。

设计原则：

- `[新增设计]` 信息密度高但不拥挤，首屏优先展示决策指标，不放大 hero。
- `[新增设计]` 卡片圆角保持 8px 或以下，表格和筛选区域比装饰更重要。
- `[新增设计]` 页面以表格、紧凑趋势、漏斗和路径边为主；MVP 不引入复杂图表库。
- `[新增设计]` 使用 Nuxt UI / Tailwind CSS v4 与现有后台布局风格，图标优先使用 Nuxt Icon / lucide 图标名。
- `[实现约束]` 所有默认查询使用聚合表和摘要表；单 session 明细必须显式输入 session ID 且 owner-only。

### 2.2.1 设计假设与待确认问题

为了让当前首版实现先形成可用运营闭环，本文采用以下默认假设；后续如果运营侧反馈不同，可在增强阶段调整：

- `[当前实现]` 默认时间范围采用最近 30 天；Owner / Admin 可以切换 7 天、90 天。
- 首期把“联系站长”和“注册成功”视为核心转化；在线支付未接入前，“会员发放”代表最终会员转化。
- `[当前实现]` 后台大盘优先服务 Owner 和 Admin，不做公开运营展示页，也不做实时电视墙。
- `[当前实现]` 图表保持轻量，首版使用 Nuxt UI 风格表格、KPI 卡片、漏斗条和状态条；只有数据复杂度真实增加时再评估图表库。

待确认问题：

- Owner 是否需要按自然周/月查看汇总，还是当前 7/30/90 天滚动窗口已足够？
- 邀请码是否存在“归属到某个普通用户”的业务场景，还是首期都归属到活动/渠道？
- 健康页的预算阈值是否按 Dev / Production 两套配置展示，还是只展示当前环境阈值？

### 2.3 Information Architecture

后台导航建议新增一个一级入口“数据分析”，其下使用页面内 tabs 或子路由：

| 页面 | 路由 | 当前状态 | 目标问题 | 默认数据源 |
|------|------|------|------|------|
| 总览 | `/admin/analytics` | `[当前实现]` | 今天发生了什么，哪里需要处理 | `/api/admin/analytics/overview` |
| 来源 | `/admin/analytics/sources` | `[当前实现]` | 用户从哪里来，哪个来源质量最高 | `/api/admin/analytics/sources` |
| 内容 | `/admin/analytics/pages` | `[当前实现]` | 哪些页面、图库和标签最有价值 | `/api/admin/analytics/pages` |
| 链路 | `/admin/analytics/paths` | `[当前实现]` | 用户从入口到联系/注册在哪一步流失 | `/api/admin/analytics/paths` |
| 点击 | `/admin/analytics/clicks` | `[当前实现]` | 哪些 CTA、广告、标签和联系入口被点击 | `/api/admin/analytics/clicks` |
| 时长 | `/admin/analytics/durations` | `[当前实现]` | 哪些内容停留久，哪些页面跳出高 | `/api/admin/analytics/durations` |
| 邀请 | `/admin/analytics/invites` | `[当前实现]` | 邀请码带来多少注册和会员发放 | `/api/admin/analytics/invites`、`/api/admin/invite-codes` |
| 健康 | `/admin/analytics/health` | `[当前实现]` | 采集、聚合、成本和采样是否正常 | `/api/admin/analytics/health` |

### 2.3.1 与归因中心边界

`/admin/analytics` 是一方行为分析大盘，回答“站内访问、内容、点击、邀请和采集健康如何”。其中来源中的 `fb`、`facebook`、`meta`、`tiktok` 只表示站内 UTM、推广链接或 referrer 归因，不等同于广告平台 Pixel 或 Server API 回传数据。

广告投放相关能力统一进入 `/admin/attribution`：创建投放追踪链接、对比 `utm_content`、按 Meta / TikTok 查看有效联系、完成注册、Pixel / Server API delivery 与匹配覆盖，排查重复事件并执行发布检查。活动转化事件仅为 `Contact`、`CompleteRegistration`；`Lead` 只在独立历史对象中作只读对照，不进入活动漏斗、比率、排序、delivery 健康或 readiness，`StartTrial` 不支持。数据大盘可以提供跳转入口，但不在本页面内维护 Pixel ID、token 或 Test Event Code。

归因中心的交付状态必须避免夸大：Pixel `attempted` 只表示浏览器按指令尝试发送，不能显示为“平台已接收”；Server API 只有通过对应平台严格成功契约后才能记为 `sent`，且仍不等于广告归因成功。运营页仅展示 secret、Queue binding 与连接验证的存在状态，不展示凭证值、Test Event Code、原始 event ID、`fbp/fbc`、`_ttp/ttclid`、IP 或用户代理。

### 2.4 Global Layout

所有分析页面共享 `AnalyticsPageShell`：

```text
┌──────────────────────────────────────────────────────────────┐
│ 页面标题 / 状态徽标                         时间范围 / 导出 │
├──────────────────────────────────────────────────────────────┤
│ 采集状态条：开关、最近聚合、accepted/rejected、预算使用率    │
├──────────────────────────────────────────────────────────────┤
│ Tabs：总览 来源 内容 链路 点击 时长 邀请 健康                │
├──────────────────────────────────────────────────────────────┤
│ 页面专属 KPI / 趋势 / 表格 / 漏斗 / 路径边                   │
└──────────────────────────────────────────────────────────────┘
```

全局控件：

- 时间范围：7 天、30 天、90 天 segmented control，默认 30 天。
- 日期自定义：仅 owner 或 admin 可用，最长 90 天；超过范围时显示“请使用导出任务或缩小范围”。
- 来源筛选：全部、直接访问、搜索、社交、外链、邀请、广告、站内。
- 设备筛选：全部、desktop、tablet、mobile。
- 邀请码筛选：全部、单邀请码。
- 操作：刷新、导出 CSV(owner-only)、复制当前筛选链接。

#### 2.4.1 首屏信息优先级

`/admin/analytics` 首屏必须按“先判断异常，再判断增长，再进入明细”的顺序组织：

| 优先级 | 区域 | 展示内容 | 设计要求 |
|------|------|------|------|
| P0 | 采集健康条 | 采集开关、最近聚合、rejected、duplicate、D1 预算 | 位于标题下方，异常时变为黄色/红色整行提示 |
| P1 | KPI 8 宫格 | 访客、session、PV、注册、邀请注册、联系、会员发放、平均时长 | 每项包含环比和微趋势，文案不超过 8 个中文字符 |
| P1 | 转化漏斗 | 落地 -> 详情 -> 联系/注册 -> 会员发放 | 使用细金色主线，突出会员转化，不做夸张大图形 |
| P2 | 趋势面板 | 日趋势和上一周期对比 | 1440px 下和漏斗并排，1024px 以下堆叠 |
| P2 | Top 三列表 | 来源、页面、点击 | 每表只展示 5 行，更多进入对应子页 |
| P3 | 风险队列 | 采集关闭、聚合延迟、预算超阈值、重复点击异常 | 只展示需要处理的事项，无风险时折叠 |

首屏文案应避免技术化字段名，例如展示“采集延迟 18 分钟”，而不是直接展示 `lastAggregatedAt` 字段。

### 2.5 User Stories

**故事 1：总览运营状态 `[新增设计]`**  
作为 Owner，我希望打开 `/admin/analytics` 后立即看到访问、注册、联系、会员发放和采集健康，以便判断今天是否需要调整内容、广告或邀请活动。

验收标准：

- 首屏展示访客、session、PV、注册、邀请注册、联系点击、会员发放、平均有效时长。
- 每个 KPI 展示当前值、环比上一周期变化和小型趋势线。
- 采集健康条展示 `analytics_enabled`、最近聚合时间、accepted/rejected/duplicate、D1 rows read/write 预算使用率。
- 任一成本或采集异常时在首屏显示黄色或红色风险条。

**故事 2：判断来源质量 `[新增设计]`**  
作为运营人员，我希望比较不同来源的访问、详情页访问、联系、注册和会员发放，以便知道哪个渠道值得继续投入。

验收标准：

- 来源页展示来源漏斗：访问 -> 详情 -> 联系 -> 注册 -> 会员发放。
- 来源表支持按注册率、联系率、会员发放数和平均有效时长排序。
- referrer 只展示清洗后的 host，不展示 query/hash。
- 邀请来源优先展示邀请码名称和渠道。

**故事 3：定位链路断点 `[新增设计]`**  
作为 Owner，我希望看到入口页、退出页和路径边，以便知道用户在哪一步离开。

验收标准：

- 链路页展示 TOP 入口页、TOP 退出页、跳出页和 from_route -> to_route 路径边表。
- 典型漏斗展示“落地页 -> 搜索/发现 -> 图库详情 -> 联系/注册 -> 会员发放”每一步转化。
- 普通 admin 只看聚合路径；owner 才能按 session ID 查看脱敏明细。

**故事 4：优化点击入口 `[新增设计]`**  
作为 Admin，我希望看到广告、图库卡片、联系入口、规则入口、登录注册入口和筛选标签的点击效果，以便调整位置和文案。

验收标准：

- 点击页同时展示 raw clicks、effective clicks、duplicate clicks、独立访客、点击率、人均点击次数。
- 1 秒内重复点击在表格中有“重复点击率”列，不作为有效点击。
- 外链点击只展示目标域名和链接类型，不展示完整 URL query。

**故事 5：评估内容吸引力 `[新增设计]`**  
作为 Owner，我希望按页面、图库和标签查看平均停留、中位停留、有效浏览率和跳出率，以便决定内容排序和会员引导。

验收标准：

- 内容页展示 Top 图库、Top 标签结果页、Top 搜索结果页。
- 时长页展示平均时长、中位时长、深度浏览率、跳出率、滚动深度。
- 单页面超过 30 分钟的异常值按截断值展示，并在 tooltip 标记“已截断”。

**故事 6：管理邀请效果 `[新增设计]`**  
作为 Owner / Admin，我希望创建、禁用和查看邀请码效果，以便评估活动。

验收标准：

- 邀请页展示邀请码状态、渠道、落地量、注册数、会员发放数、注册转化率、会员发放转化率。
- 支持创建邀请码、复制邀请链接、禁用邀请码。
- 邀请码写操作必须显示二次确认结果并写入审计日志。

### 2.6 Non-Goals

- 不做实时秒级电视墙和自动刷新大屏。
- 不展示单个用户完整浏览画像给普通 admin。
- 不提供无条件全量原始事件列表。
- 不用图表动效替代可排序表格和明确指标定义。
- 不把 Facebook Pixel 事件作为后台大盘的唯一数据源。
- 不在 `/admin/analytics` 创建投放追踪链接或展示广告平台 delivery 明细；这些由 `/admin/attribution` 维护。

## 3. AI System Requirements

本大盘 MVP 不需要 AI 功能。

后续如增加“趋势摘要”或“异常解释”，只能使用聚合数据，不能把单个用户浏览链路、受保护媒体访问明细、联系方式、邮箱、session token 或私有媒体 URL 发送给外部模型。

## 4. Technical Specifications

### 4.1 Architecture Overview

```text
Nuxt 后台页面
  -> AnalyticsPageShell 读取公共筛选状态
  -> useAdminAnalytics composable 请求 admin analytics API
  -> API Worker 校验 admin/owner 权限
  -> D1 聚合表和摘要表
  -> 响应 KPI、趋势、表格、健康状态
  -> 页面渲染卡片、趋势、漏斗、路径边和可排序表格
```

广告归因链路：

```text
Nuxt 后台归因中心
  -> AttributionPageShell 读取日期筛选
  -> useAdminAttribution composable 请求 admin attribution API
  -> API Worker 校验 admin/owner 权限
  -> D1 转化账本和 delivery 聚合表
  -> 按 provider 进入独立 Cloudflare Queue / DLQ
  -> 页面渲染投放链接、转化趋势、平台同步、匹配覆盖和重复诊断
```

#### `/admin/attribution` 多平台归因工作台

- `[当前实现]` 归因中心固定为五个职责清晰的页面：`总览`、`转化明细`、`投放链接`、`平台接入`、`发布与诊断`。旧的独立 `Meta 运维` 页面已删除，连接验证、质量分析、放量与 incident 不得在多个页面重复维护。
- `[当前实现]` 所有平台化页面顶部使用 Meta / TikTok 分段控制，并通过 URL `provider` 保留上下文；summary、trend、conversion detail、tracking links、campaign breakdown、匹配覆盖和重复诊断必须携带明确 provider，切换后同步刷新。
- `[当前实现]` `attributionPlatforms.ts` 是前端平台展示能力注册表；新增平台先登记目标 ID、Browser/Server 名称和受控放量、incident、平台质量能力，再复用通用页面。平台专属协议仍留在 adapter 和专属组件中，不把差异塞进业务页条件分支。
- `[当前实现]` `总览` 只展示站内事实、平台投递与匹配质量；`平台接入` 只维护目标 ID、通道开关和一次性连接验证；`发布与诊断` 只维护 blocker/warning、受控放量和 incident。Test Event Code 只存在于平台接入页内存中。
- `[当前实现]` 平台健康分别显示 Pixel attempted、Server API sent、failed、skipped、pending、retry exhausted；不得合并为“已同步”总数。
- `[当前实现]` 匹配质量使用通用 `browserId` / `clickId`，UI 显示 Meta `fbp/fbc` 或 TikTok `_ttp/ttclid`。Meta Dataset Quality 不得显示为 TikTok 质量数据。
- `[当前实现]` 发布与诊断按选中平台分别计算 blocker 与 warning。Meta 复用服务端 production readiness、受控 rollout 和 incident；TikTok 使用自身连接、资源、路由隔离和投递状态，不读取 Meta 的验证结果。warning 只提示观察项，不伪装为生产放行。
- `[当前实现]` Owner 仅能在 `attribution_platform_connections.mode=test` 发起平台验证；成功条件由对应 adapter 的严格响应契约判定，不以创建审计记录代替平台接收。
- `[当前实现]` production live evidence 通过 migrations `0041`、`0045`、`0046` 的一次性 challenge 绑定正式环境、连接身份与增强匹配覆盖证明；challenge 必须在 24 小时内完成，人工确认在连接未变化时可复用 30 天。正式域名 Browser/CAPI 使用同组 opaque ID，UI 和 CLI 不展示原始 event ID。
- `[当前实现]` 资源 attestation 通过 migration `0042` 的 60 秒 D1 原子一次性 ticket 完成；Owner Cookie 只用于向固定可信 API origin 换票，最终 HMAC attestation 请求不携带 Cookie。
- `[运维前置]` Meta 发布遵循 production bootstrap -> 部署 -> post-deploy attestation -> Test Event -> live evidence -> full gate -> production mode -> `0 -> 10 -> 50 -> 100` 人工放量。TikTok 独立完成 production Test Events 验证后从 `10%` 起人工放量。任一步失败先关闭对应 Server transport、rollout 降为 `0`，再切 mode 为 `disabled`。
- `[运维前置]` Meta 与 TikTok 只使用各自 production Queue / DLQ；dev 不创建广告平台 Queue。页面不显示 Cloudflare resource ID 或命令原始输出。

### 4.2 Page Composition

#### `/admin/analytics` 总览

首屏布局：

```text
┌ 标题：数据分析                      [7天][30天][90天] [刷新] [导出] ┐
├ 采集状态：已开启 · 最近聚合 09:10 · D1 写入预算 42% · 拒绝 12  │
├ KPI 8 宫格：访客 session PV 注册 邀请注册 联系 会员 平均时长     │
├ 左 8列：访问与转化趋势折线 / 右 4列：关键漏斗                   │
├ Top 来源 / Top 页面 / Top 点击 三列表                           │
└ 风险队列：采集关闭、聚合延迟、预算超阈值、重复点击异常          │
```

核心组件：

- `[当前实现]` `AnalyticsPageShell`：标题、说明、tabs、时间范围、刷新、owner-only 导出和 usage 状态。
- `[当前实现]` `AnalyticsMetricCard`：KPI 卡片。
- `[当前实现]` `AnalyticsDataTable`：可排序分析表格。
- `[当前实现]` `AnalyticsHealthStrip`：采集状态、最近采集、accepted/rejected/duplicate 和 rows written。
- `[当前实现]` `AnalyticsTrendPanel`：按日展示访问与转化趋势，空数据时保持稳定空态。
- `[当前实现]` `AnalyticsConversionFunnel`：抽成共享组件，供总览展示落地、详情、联系、注册和会员发放。
- `[当前实现]` `AnalyticsTopList`：来源、页面、点击元素排行，空数据时展示排行空态。
- `[当前实现]` 风险队列：显示暂无数据、无最近采集、rejected 和 duplicate 等需要处理的事项。

#### `/admin/analytics/sources` 来源

布局：

- 顶部：来源渠道筛选 + 邀请码筛选 + UTM 筛选。
- 第一行：来源质量 KPI：访问、详情率、联系率、注册率、会员发放率。
- 主体：来源漏斗矩阵，每个来源一行，列为访问、详情、联系、注册、会员发放、平均有效时长。
- 右侧或下方：Top referrer host、Top UTM campaign、Top invite channel。

#### `/admin/analytics/pages` 内容

布局：

- 顶部：内容类型筛选：全部、首页、搜索、发现、图库、真实案例、规则、登录注册。
- 主体：页面价值表，列为 PV、UV、入口数、退出数、跳出率、平均时长、注册贡献、联系贡献。
- 图库子表：标题、required rank、标签、详情访问、媒体访问需求、会员 CTA、平均时长。
- 行点击：进入详情抽屉，展示该页面 7/30/90 天趋势和主要来源。

#### `/admin/analytics/paths` 链路

布局：

- 顶部：关键漏斗条，展示每一步人数和转化率。
- 主体：路径边表格，列为 from_route、to_route、次数、独立访客、后续联系率、后续注册率。
- 辅助：入口页、退出页、跳出页三列表。
- Owner-only：输入 session ID 查看脱敏事件序列。

#### `/admin/analytics/clicks` 点击

布局：

- 顶部：元素类型筛选：广告、图库卡片、联系入口、规则入口、会员 CTA、筛选标签、外链。
- KPI：有效点击、点击率、重复点击率、独立点击访客、人均点击。
- 主体：点击排行表，列为 element_id、位置、目标类型、raw、effective、duplicate、CTR、访客数、session 数。
- 异常区：重复点击率 > 20% 或 1 分钟内异常点击的元素。

#### `/admin/analytics/durations` 时长

布局：

- 顶部：页面类型 + required rank + 设备筛选。
- KPI：平均有效时长、中位时长、深度浏览率、跳出率、平均滚动深度。
- 主体：页面/图库时长表，列为 PV、平均秒数、中位秒数、P75、深度浏览率、跳出率。
- 下方：高跳出页面排查列表，提供“查看页面”“查看来源”“查看路径”操作。

#### `/admin/analytics/invites` 邀请

布局：

- 顶部：创建邀请码按钮、状态筛选、渠道筛选。
- KPI：邀请落地、邀请注册、会员发放、注册转化率、会员发放转化率。
- 主体：邀请码表，列为名称、display code、渠道、状态、有效期、落地、注册、会员、转化率、操作。
- 行详情抽屉：趋势、来源、落地页、注册用户摘要、首次会员发放。
- 操作：复制链接、禁用、编辑备注；禁用需要确认。

#### `/admin/analytics/health` 健康

布局：

- KPI：24 小时采集请求、accepted、rejected、duplicate、sensitive blocked、sampled、dropped。
- 成本：D1 rows read/write 预算使用率、查询 P95、聚合耗时、采样率。
- 任务：最近聚合时间、聚合状态、保留期清理状态、导出任务状态。
- `[后续增强]` Queue backlog、Queue failures、WAE data points。

### 4.3 Component Inventory

| 组件 | 职责 | 主要 props |
|------|------|------|
| `AnalyticsPageShell` | 标题、说明、tabs、全局筛选、操作区 | `title`、`description`、`activeTab`、`actions` |
| `AnalyticsRangeControl` | 7/30/90 天和自定义日期 | `modelValue`、`maxDays`、`disabled` |
| `AnalyticsHealthStrip` | 采集状态、聚合状态、成本状态 | `enabled`、`lastAggregatedAt`、`budget`、`status` |
| `AnalyticsMetricCard` | 单个 KPI、环比和 sparkline | `label`、`value`、`delta`、`trend`、`tone`、`icon` |
| `AnalyticsTrendPanel` | 小型趋势线和趋势表 | `series`、`unit`、`compareLabel` |
| `AnalyticsConversionFunnel` | 漏斗阶段和转化率 | `steps` |
| `AnalyticsRankTable` | 排序表格 | `columns`、`rows`、`sort`、`emptyText` |
| `AnalyticsPathEdgesTable` | from_route -> to_route 路径边 | `rows`、`highlightRoute` |
| `AnalyticsInviteDrawer` | 邀请码详情抽屉 | `inviteCodeId`、`open` |
| `AnalyticsEmptyState` | 空数据 / 关闭采集 / 权限不足 | `state`、`primaryAction` |
| `AnalyticsCostBadge` | rows read/write 和预算提示 | `usagePercent`、`mode` |

### 4.4 Visual Tokens

| 用途 | 推荐样式 |
|------|------|
| 页面背景 | `bg-gray-50` |
| 卡片背景 | `bg-white border border-gray-200 rounded-lg`，圆角最大 8px |
| 主文本 | `text-gray-950` |
| 次文本 | `text-gray-500` |
| 增长/健康 | `text-emerald-700 bg-emerald-50 border-emerald-100` |
| 来源/流量 | `text-blue-700 bg-blue-50 border-blue-100` |
| 会员/转化价值 | `text-amber-700 bg-amber-50 border-amber-100` |
| 风险/成本 | `text-red-700 bg-red-50 border-red-100` |
| 中性状态 | `text-slate-700 bg-slate-50 border-slate-200` |
| owner-only | `text-violet-700 bg-violet-50 border-violet-100` |

图标建议：

- 总览：`LayoutDashboard`
- 来源：`Share2`
- 内容：`Images`
- 链路：`GitBranch`
- 点击：`MousePointerClick`
- 时长：`Timer`
- 邀请：`Ticket`
- 健康：`ShieldCheck`
- 导出：`Download`
- 刷新：`RefreshCw`
- 成本：`Gauge`

### 4.5 Interaction States

| 状态 | UI 表现 | 行为 |
|------|------|------|
| 加载中 | KPI skeleton、表格 skeleton，保持稳定高度 | 不挤压布局 |
| 采集关闭 | 顶部显示灰色状态条“数据采集未开启” | Owner 可跳转设置；admin 只读提示 |
| 暂无数据 | 空状态文案“暂无数据，部署埋点后会在这里展示” | 提供刷新和查看接入说明 |
| 聚合延迟 | 黄色状态条显示最近聚合时间 | 提示“报表可能落后” |
| 成本超阈值 | 红色状态条 + `AnalyticsCostBadge` | Owner 可查看健康页 |
| 权限不足 | owner-only 操作隐藏；直接访问显示 403 空状态 | 不泄露接口细节 |
| 查询失败 | 卡片级错误，不清空其他成功模块 | 提供重试 |
| 导出处理中 | 按钮 loading，列表展示状态 | 完成后展示下载，有效期 7 天 |

### 4.6 Responsive Rules

- 1440px：主内容使用 12 列栅格，KPI 4 或 8 个一行，趋势 8 列 + 漏斗 4 列。
- 1024px：KPI 4 列，趋势和漏斗上下堆叠。
- 768px：tabs 横向滚动，筛选区折叠为两行，表格允许列隐藏。
- 360px：单列布局，KPI 2 列，表格转为卡片列表，只保留核心列；长 route、host 和 element_id 必须换行。
- 所有固定格式元素使用 `minmax(0, 1fr)`、`overflow-hidden`、`break-words`，避免长邀请码、URL host 或 route 造成横向滚动。

### 4.7 Integration Points

- API：使用 `useApi` 或现有后台 API composable 请求 `/api/admin/analytics/*`。
- 权限：后台页面由 admin layout 保护；owner-only 操作根据 `user.role === 'owner'` 控制显示，API 仍二次校验。
- 审计：邀请码写操作、导出、单 session 明细查看在 API 写 `admin_audit_logs`。
- 数据状态：所有页面响应都应包含 `range`、`generatedAt`、`lastAggregatedAt`，用于 UI 标记报表新鲜度。
- 成本状态：健康接口返回 rows read/write 估算、预算百分比、采样率和 rejected 原因聚合。

### 4.8 Security & Privacy

- 大盘不展示原始 IP、完整 user agent、完整 referrer query/hash、邮箱明文、联系值、session token、私有 R2 key 和 Stream token。
- 搜索报表不展示关键词明文，只展示 `has_query`、`query_length`、`tag_count`、结果数和无结果率。
- 单 session 明细 owner-only，且只展示脱敏 event_name、route、entity、时间和白名单 props。
- 导出 CSV owner-only，文件保存在 R2，默认 7 天过期。
- 所有外链 host 只显示清洗后的 host；点击下载或外链时使用 `rel="noopener noreferrer nofollow"` 与 `referrerpolicy="no-referrer"`。

### 4.9 指标定义合同

后台所有页面必须使用同一套指标定义，避免不同页面同名指标口径不一致：

| 指标 | 定义 | 展示位置 |
|------|------|------|
| 访客数 | `visitor_id` 去重数 | 总览、来源、内容 |
| session 数 | `session_id` 去重数 | 总览、来源 |
| PV | `page_view` 或页面摘要总数 | 总览、内容 |
| 注册数 | `register_success` 去重用户数 | 总览、来源、邀请 |
| 邀请注册数 | 带 `invite_code_id` 的注册成功用户数 | 总览、邀请 |
| 有效联系数 | `contact_method_click` 事件数；仅打开联系面板不计转化 | 总览、来源、页面、点击 |
| 会员发放数 | 首次 rank > 0 的会员发放转化数 | 总览、来源、邀请 |
| 注册率 | 注册数 / session 数 | 来源、邀请 |
| 联系率 | 联系点击独立 session 数 / session 数 | 来源、点击 |
| 会员发放率 | 会员发放数 / 注册数 | 总览、来源、邀请 |
| 跳出率 | 仅 1 个 page view 且 active_seconds < 15 秒的 session / session 数 | 内容、时长 |
| 平均有效时长 | active_seconds 总和 / page view 或 session 数 | 总览、内容、时长 |
| 中位有效时长 | active_seconds P50 | 时长 |
| 深度浏览率 | active_seconds >= 60 秒或 scroll_depth >= 75% 的页面访问 / 页面访问 | 内容、时长 |
| 有效点击 | 去除 1 秒内同 visitor + element_id 重复点击后的点击数 | 点击 |
| 重复点击率 | duplicate clicks / raw clicks | 点击、健康 |

所有比率分母为 0 时展示 `--`，不展示 0% 误导运营判断。

### 4.10 API 响应合同

后台分析 API 建议统一返回以下外壳：

```json
{
  "range": { "from": "2026-06-01", "to": "2026-06-07", "days": 7 },
  "generatedAt": "2026-06-07T13:00:00.000Z",
  "lastAggregatedAt": "2026-06-07T12:45:00.000Z",
  "dataFreshness": "fresh",
  "cost": {
    "rowsRead": 1234,
    "rowsWritten": 0,
    "budgetPercent": 18,
    "mode": "normal"
  },
  "filters": {
    "sourceChannel": "all",
    "deviceType": "all",
    "inviteCodeId": ""
  },
  "data": {}
}
```

字段约束：

- `dataFreshness` 只允许 `fresh`、`delayed`、`disabled`、`empty`、`error`。
- `cost.mode` 只允许 `normal`、`watch`、`limited`、`blocked`，前端据此渲染中性、黄色、红色状态。
- `data` 由页面决定，但表格数据必须由 API 完成分页和排序，前端不拉全量后排序。
- 所有响应都要保留 `range` 与 `lastAggregatedAt`，即使空数据也要返回，便于 UI 明确展示“暂无数据”而不是“查询失败”。

`/api/admin/analytics/overview` 的 `data` 建议包含：

| 字段 | 说明 |
|------|------|
| `totals` | 8 个首屏 KPI |
| `trends` | 按日期的 visitors、sessions、registrations、contactClicks、membershipGrants |
| `funnel` | landing、detail、contactOrRegister、membershipGrant 阶段数组 |
| `topSources` | 来源排行前 5 |
| `topPages` | 页面排行前 5 |
| `topClicks` | 点击排行前 5 |
| `risks` | 采集、聚合、成本、重复点击风险列表 |

### 4.11 性能、成本与 Cloudflare 约束

本设计延续当前 Cloudflare 成本约束和 D1 聚合优先策略。实现后台大盘时必须遵守：

| 约束 | UI / API 设计动作 |
|------|------|
| D1 成本与 rows read / rows written 相关 | 所有报表响应暴露 `cost`，健康条显示预算百分比 |
| D1 索引会降低扫描但增加写入成本 | 报表只依赖已规划组合索引，不为 `event_props` 任意字段建索引 |
| Workers 请求受 CPU、body、subrequest 等限制 | 报表接口不做复杂实时重算，默认读取聚合表 |
| Queues 适合后续批处理缓冲 | 健康页预留 Queue backlog / failures 区域，但 MVP 不显示空壳 |
| Workers Analytics Engine 适合高频高基数探索 | 健康页预留 WAE data points 指标，MVP 不作为默认依赖 |

默认预算：

- 30 天总览、来源、内容、点击、时长、邀请接口 rows read 目标 <= 10,000 / 接口。
- 90 天范围 rows read 目标 <= 30,000 / 接口。
- 查询 P95：30 天 <= 1 秒，90 天 <= 2 秒。
- 前端每页首屏最多并发 2 个分析请求：主数据 + 健康摘要；其余模块延迟加载或由主响应提供。
- 移动端不默认渲染复杂趋势图，优先展示 KPI 和可折叠卡片，降低首屏 JS 与 DOM 负担。

官方参考文档：

- [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Queues Batching, Retries and Delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Workers Analytics Engine Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)

### 4.12 实现交接与增强顺序

当前首版已完成统一 shell、时间范围、导出、总览和七个子页面的基础表格型实现。后续增强按以下顺序推进，避免 UI 先行后无法接数据：

1. `[当前实现]` `useAdminAnalytics`：统一 range、错误态、刷新逻辑和 usage 显示。
2. `[当前实现]` `AnalyticsPageShell`：统一标题、tabs、7/30/90 天范围、刷新和 owner-only 导出。
3. `[当前实现]` `/admin/analytics`：接入 overview API、8 个 KPI、漏斗、健康摘要、趋势表和 Top 列表。
4. `[当前实现]` `/admin/analytics/sources`、`/pages`、`/paths`、`/clicks`、`/durations`、`/invites`、`/health`：完成基础表格型报表。
5. `[新增设计]` 抽出 `AnalyticsHealthStrip`、`AnalyticsConversionFunnel`、`AnalyticsTrendPanel`，减少总览页内联 UI。
6. `[后续增强]` 来源、内容、邀请页增加页面级 KPI 和详情抽屉；链路、点击、时长页增加异常提示和排查入口。
7. `[后续增强]` owner-only session 脱敏明细、CSV 导出任务列表和多视口截图验收。

## 5. Risks & Roadmap

### 5.1 Phased Rollout

#### MVP：总览、来源、内容、链路、点击、时长、邀请、健康 `[当前实现]`

- `/admin/analytics` 总览。
- `/admin/analytics/sources` 来源质量。
- `/admin/analytics/pages` 内容价值。
- `/admin/analytics/paths` 路径边和典型链路。
- `/admin/analytics/clicks` 点击频率和重复点击。
- `/admin/analytics/durations` 时长、滚动和跳出。
- `/admin/analytics/invites` 邀请效果与邀请码管理。
- `/admin/analytics/health` 采集健康。
- 空状态、采集关闭、聚合延迟、成本告警和权限状态。

#### v1.1：业务判断能力细化 `[后续增强]`

- 来源页增加来源漏斗矩阵、来源质量评分和邀请码筛选。
- 内容页增加图库/标签/搜索结果页分组、行详情抽屉和内容价值提示。
- 链路页增加典型漏斗可视化、入口/退出/跳出三列表。
- 点击页增加重复点击异常队列和元素类型筛选。
- 时长页增加深度浏览率、P50/P75 和高跳出排查列表。
- Owner-only session 明细抽屉。

#### v2.0：规模与运营洞察

- Queue / WAE 接入后的采集健康指标。
- 投放活动对比、内容价值评分、留存分析。
- 基于聚合数据的趋势摘要，不触碰个人明细。

### 5.2 Technical Risks

- D1 rows read 失控：页面必须默认查聚合表；表格分页和排序由 API 控制，不在前端拉全量排序。
- UI 信息过载：MVP 每页只保留 1 个核心判断问题；复杂 drill-down 放抽屉或后续版本。
- 权限误显：owner-only 入口前端隐藏只是体验优化，API 必须二次校验。
- 数据滞后误判：所有页面显示 `lastAggregatedAt`，聚合延迟时给出醒目提示。
- 小屏表格溢出：移动端将表格转卡片，长 route/host 强制换行。

## 6. 页面验收清单

- `[新增设计]` `/admin/analytics` 首屏在 1440px 下无需滚动即可看到健康条、8 个 KPI、趋势和关键漏斗。
- `[新增设计]` 360px 下所有 KPI、tabs、筛选、表格卡片不产生横向滚动。
- `[新增设计]` 采集关闭时不展示 0 值假象，明确显示“数据采集未开启”。
- `[新增设计]` 空数据时所有页面显示同一句可理解空状态，不显示接口字段名。
- `[实现约束]` 默认报表接口不读取 `analytics_events` 全量明细。
- `[实现约束]` owner-only 导出和 session 明细在非 owner 用户下不渲染入口。
- `[实现约束]` 所有表格列名与指标定义在 tooltip 或说明区可查，避免运营误读。
- `[实现约束]` Web 构建必须通过 `corepack pnpm --filter @meigallery/web exec nuxt build`。
- `[实现约束]` API 类型检查必须通过 `corepack pnpm --filter @meigallery/api exec tsc --noEmit`。

## 7. Related Specifications / Further Reading

- `docs/PROJECT_STATUS.md`
- `docs/TECHNICAL_SPEC.md`
- `docs/UI_DESIGN.md`
