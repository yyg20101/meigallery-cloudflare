# 数据分析来源归因与日报聚合修复设计

## 1. 背景

生产测试发现：用户浏览页面、执行点击操作后，后台数据分析大盘仍显示为 0。排查结果显示，生产 `analytics_enabled` 原本处于关闭态；开启后，`/api/analytics/events` 已能返回 `accepted > 0`，`analytics_sessions` 与 `analytics_ingest_health_daily` 也能写入数据，但后台总览读取的 `analytics_daily_sources`、`analytics_daily_pages`、`analytics_daily_events`、`analytics_click_daily` 仍为空。

根因不是前端完全没有上报，而是批量采集路径 `persistAcceptedEvents` 只写入 visitor、session、page summary、click summary、raw sampled events 和采集健康表，没有同步写后台报表依赖的日报聚合表。后台大盘读不到日报聚合，自然显示为 0。

已有 `2026-06-08-analytics-source-tracking-design.md` 已完成推广来源主数据和标准追踪链接设计。本设计承接该方案，修复采集到后台展示的断点，并补齐“来源相关数据必须标注来源”的页面访问与点击分析能力。

## 2. 目标

- 修复浏览、点击后后台大盘仍为 0 的问题。
- 当访问存在来源时，页面访问、点击、注册、联系和会员转化都能归因到统一来源。
- 后台继续使用 `analytics_tracking_sources` 管理推广来源，运营能用统一来源查看流量质量。
- 来源创建必须包含可编辑自定义文案；稳定 `code` 由后台自动生成，用于追踪链接与数据保存，自定义文案用于后台和页面展示。
- 来源质量分析覆盖来源总览、各页面访问表现和所有点击事件表现。
- 后台提供流量漏斗效果图，用于分析从访问到联系、注册、会员发放的转化表现。
- 保持 Cloudflare D1 成本可控，不在常规后台查询中扫描大批原始事件。
- 后台能提示采集关闭、健康表有数据但日报为空、来源未匹配等常见诊断状态。

## 3. 非目标

- 不引入第三方分析平台。
- 不接入广告平台 API 或自动拉取投放成本。
- 不重建完整实时事件仓库。
- 不把邀请码和推广来源合并为同一个概念。
- 不开放普通用户创建或修改推广来源。
- 不用原始 `analytics_events` 作为后台默认报表数据源；原始事件仅用于抽样排查和关键事件明细。
- 不支持直接修改已创建来源的 `code` 并自动迁移历史数据；需要新 `code` 时创建新来源并停用旧来源。

## 4. 归因口径

采用会话首触来源归因。

一次 session 初始化时确定来源，后续本 session 内的页面访问、点击、注册、联系、会员转化默认都标注同一个来源。事件 payload 仍保留当前事件携带的 UTM、referrer、`mg_source` 等字段，方便排查，但后台默认质量分析使用 session 首触来源。

归因优先级：

1. 邀请来源：存在有效邀请码上下文时，`source_channel = invite`，并记录 `invite_code_id`。
2. 推广来源：存在 `mg_source` 或标准 UTM 时，优先匹配 `analytics_tracking_sources`；数据保存使用稳定 `source_code`，展示时再解析为自定义文案。
3. 外部 referrer：保留清洗后的 referrer host。
4. 直接访问：无外部来源时归为 `direct`。

邀请码仍用于邀请注册和会员发放归因；推广来源用于访问来源质量归因。两者可以同时存在：来源报表看入口，邀请报表看邀请码。

## 5. 数据模型

### 5.1 保留现有表

继续使用：

- `analytics_tracking_sources`：推广来源主数据。
- `analytics_daily_sources`：来源总览日报。
- `analytics_daily_pages`：页面访问日报。
- `analytics_click_daily`：点击日报。
- `analytics_daily_events`：事件日报。
- `analytics_ingest_health_daily`：采集健康日报。

### 5.2 推广来源主数据语义

`analytics_tracking_sources` 当前已有 `slug` 与 `name` 字段，本轮设计明确它们的业务语义：

| 对外字段 | 当前字段 | 说明 |
|----------|----------|------|
| `sourceCode` | `slug` | 稳定来源 code，用于 `mg_source`、默认 `utm_source`、聚合表保存和报表筛选 |
| `sourceLabel` | `name` | 自定义展示文案，用于后台列表、筛选器、漏斗标题和页面展示 |
| `utmSource` | `utm_source` | 默认等于 `sourceCode`，用于兼容 UTM 体系 |
| `utmMedium` | `utm_medium` | 来源渠道媒介 |
| `utmCampaign` | `utm_campaign` | 活动标识 |

约束：

- `sourceCode` 创建后不可修改，避免历史聚合数据失去稳定键。
- `sourceCode` 由后台按渠道和短随机 ID 自动生成，后台创建表单不要求运营手动命名 code。
- `sourceLabel` 支持修改，历史数据不用回写；报表展示时通过 `sourceCode` 关联当前文案。
- 聚合表继续使用 `source_name` 这个历史列名时，列值语义调整为 `sourceCode`，不再保存可变展示文案。
- API 返回来源数据时同时给出 `sourceCode` 和 `sourceLabel`，前端显示优先使用 `sourceLabel`，导出和排查保留 `sourceCode`。
- 追踪链接使用 `?mg_source={sourceCode}&utm_source={sourceCode}`，展示文案不进入 URL。

### 5.3 新增来源维度聚合表

为避免直接扩大现有唯一索引导致历史数据迁移复杂，新增两张低成本来源维度聚合表。

`analytics_source_page_daily`：

| 字段 | 说明 |
|------|------|
| `date` | 运营日期 |
| `source_channel` | 来源渠道 |
| `source_name` | 来源 code，沿用历史列名 |
| `invite_code_id` | 邀请码 ID，可为空字符串 |
| `route_name` | 页面路由名 |
| `path` | 页面路径 |
| `entity_type` | 页面实体类型 |
| `entity_id` | 页面实体 ID |
| `page_title` | 页面标题 |
| `visitor_count` | 访客计数 |
| `session_count` | session 计数 |
| `page_view_count` | PV |
| `entry_count` | 入口次数 |
| `exit_count` | 退出次数 |
| `bounce_count` | 跳出次数 |
| `active_seconds_total` | 有效停留秒数 |
| `max_scroll_depth` | 最大滚动深度 |
| `register_count` | 注册成功数 |
| `contact_click_count` | 联系点击数 |

唯一索引：

```text
date, source_channel, source_name, invite_code_id, route_name, path, entity_type, entity_id
```

`analytics_source_click_daily`：

| 字段 | 说明 |
|------|------|
| `date` | 运营日期 |
| `source_channel` | 来源渠道 |
| `source_name` | 来源 code，沿用历史列名 |
| `invite_code_id` | 邀请码 ID，可为空字符串 |
| `element_id` | 点击元素 ID |
| `element_type` | 点击元素类型 |
| `location` | 点击位置 |
| `target_type` | 目标类型 |
| `target_id` | 目标 ID |
| `raw_click_count` | 原始点击数 |
| `effective_click_count` | 有效点击数 |
| `duplicate_click_count` | 重复点击数 |
| `visitor_count` | 访客计数 |
| `session_count` | session 计数 |
| `user_count` | 登录用户计数 |
| `exposure_session_count` | 曝光 session 计数 |

唯一索引：

```text
date, source_channel, source_name, invite_code_id, element_id, location, target_type, target_id
```

这两张表用于后台来源质量 drill-down，不替代现有无来源维度页面表和点击表。

## 6. 采集写入设计

### 6.1 修复批量采集断点

`persistAcceptedEvents` 在批量写入时需要补齐日报聚合：

- 写 `analytics_daily_events`。
- 写 `analytics_daily_sources`。
- 写 `analytics_daily_pages`。
- 写 `analytics_click_daily`。
- 写 `analytics_source_page_daily`。
- 写 `analytics_source_click_daily`。

实现时优先按批次分组后 upsert，避免每个事件都单独多次写入造成 D1 rows written 放大。单事件兜底路径 `_persistAcceptedEvent` 也保持一致，避免未来调用路径再次出现聚合缺口。

### 6.2 来源取值

每个事件写聚合时使用 session 首触来源：

- `source_channel`
- `source_name`，语义为稳定来源 code
- `invite_code_id`

如果事件中存在更明确的 `tracking_source_slug`、`utm_source` 或 `source_name`，只在创建 session 或更新 visitor 首触字段时参与来源确定，并统一规范为 `sourceCode`；后续事件不覆盖本 session 的归因来源。可编辑自定义文案只在查询展示阶段通过 `analytics_tracking_sources` 解析，不进入采集 payload 或日报聚合键。

### 6.3 计数语义

为首期可解释和低成本，聚合计数采用近似增量：

- `visitor_count`：按进入该聚合 key 的批次或事件增量计数，不做跨天精确 distinct。
- `session_count`：按 session 首次进入该聚合 key 的批次或事件增量计数，不扫描历史明细做去重。
- `page_view_count`、`raw_click_count`、`event_count`：按事件数准确累加。
- `active_seconds_total`、`max_scroll_depth`：沿用当前页面 summary 的计算口径。

后台文案使用“访客计数”“Session 计数”等口径，避免暗示强 distinct。

## 7. API 设计

### 7.1 现有接口修复

`GET /api/admin/analytics/overview`：

- 总览卡片继续读 `analytics_daily_sources`。
- 如果 health 有 `accepted_count > 0` 但日报聚合总量为 0，返回诊断字段 `diagnostics.aggregateMissing = true`。

`GET /api/admin/analytics/sources`：

- 保持现有来源总览。
- `trackingSources` 继续返回来源主数据与质量指标。
- 聚合结果返回 `sourceCode`、`sourceLabel` 和历史兼容字段 `source_name`。
- 增加来源未匹配计数，帮助运营发现 UTM 或 `mg_source` 未进入主数据。

`POST /api/admin/tracking-sources` 与 `PATCH /api/admin/tracking-sources/:id`：

- 创建时必须提交 `sourceLabel`；`sourceCode` 由后台生成。创建接口收到 `sourceCode`、`slug` 或 `utmSource` 时返回 400，避免运营误以为需要手工命名 code。
- `sourceCode` 创建后不可修改，更新接口收到 `sourceCode` 或 `slug` 变更时返回 400。
- `sourceLabel` 支持修改，更新后所有后台报表展示当前文案。

### 7.2 新增来源 drill-down 接口

`GET /api/admin/analytics/source-pages`：

- 支持 `range`、`from`、`to`。
- 可选筛选：`sourceChannel`、`sourceName`、`inviteCodeId`。
- `sourceName` 参数兼容历史命名，语义为 `sourceCode`；API 另支持 `sourceCode` 参数。
- 返回来源维度下的页面访问排行。

`GET /api/admin/analytics/source-clicks`：

- 支持 `range`、`from`、`to`。
- 可选筛选：`sourceChannel`、`sourceName`、`inviteCodeId`。
- `sourceName` 参数兼容历史命名，语义为 `sourceCode`；API 另支持 `sourceCode` 参数。
- 返回来源维度下的点击排行。

这两个接口都读新增来源维度聚合表，不扫原始事件。

### 7.3 新增漏斗接口

`GET /api/admin/analytics/funnel`：

- 支持 `range`、`from`、`to`。
- 可选筛选：`sourceChannel`、`sourceName`、`inviteCodeId`、`path`。
- `sourceName` 参数兼容历史命名，语义为 `sourceCode`；API 另支持 `sourceCode` 参数。
- 返回漏斗阶段数组、阶段间转化率、总入口转化率和主要流失点。

默认漏斗阶段：

| 阶段 | 计算来源 | 说明 |
|------|----------|------|
| `sessions` | `analytics_daily_sources.session_count` 或来源筛选下的 `analytics_source_page_daily.session_count` | 进入站点的 session |
| `page_views` | `page_view_count` | 实际页面访问 |
| `gallery_details` | `gallery_detail_count` 或详情页 `entity_type = gallery` 汇总 | 进入图库详情 |
| `key_clicks` | 来源点击聚合中 CTA、联系、广告、图库卡片点击汇总 | 产生关键点击 |
| `contacts_or_registers` | `contact_click_count + register_count` | 产生联系或注册意向 |
| `membership_grants` | `membership_grant_count` | 站长手动发放会员 |

接口返回示例结构：

```ts
{
  stages: [
    { key: 'sessions', label: 'Session', value: 1240, rateFromPrevious: 1, rateFromEntry: 1 },
    { key: 'page_views', label: '页面访问', value: 1018, rateFromPrevious: 0.821, rateFromEntry: 0.821 }
  ],
  dropOffs: [
    { from: 'page_views', to: 'gallery_details', lost: 422, lossRate: 0.415 }
  ],
  filters: {
    sourceChannel: 'social',
    sourceCode: 'telegram-june',
    sourceLabel: 'Telegram 六月互推'
  }
}
```

漏斗接口仍只读聚合表；当筛选范围没有来源维度时读总览聚合，当带来源筛选时读来源维度聚合。

### 7.4 来源展示解析

后台分析接口统一在查询阶段用 `sourceCode` 左连接 `analytics_tracking_sources.slug`。解析规则：

1. 匹配到推广来源时，返回当前 `sourceLabel`。
2. 未匹配但有 `sourceCode` 时，展示 `sourceCode`，并标记 `sourceMatched = false`。
3. 直接访问、外部 referrer、邀请来源等无推广主数据场景，按渠道和安全来源 host 展示。

## 8. 后台设计

### 8.1 总览诊断提示

后台 `/admin/analytics` 增加诊断提示：

- 采集关闭：提示 Owner 到站点设置开启数据分析。
- 采集健康有接收但日报为空：提示聚合链路缺失或需要部署修复。
- 追踪来源未匹配：提示检查 `mg_source`、UTM 和来源主数据。

### 8.2 来源分析页

`/admin/analytics/sources` 继续作为来源主入口：

- 展示来源总览和推广来源管理。
- 增加入口跳转到来源页面排行和来源点击排行。
- 来源创建表单只要求选择渠道、填写自定义文案和落地页；`code` 创建后自动生成并锁定，文案可修改。
- 来源列表中显示自定义文案、`code`、追踪链接、状态、session、PV、联系、注册、会员、有效停留。
- 来源报表标题、筛选器和漏斗标题优先显示自定义文案，旁边保留 `code` 作为小号辅助信息。

### 8.3 页面和点击来源视图

新增或扩展现有页面：

- 页面来源分析：按来源查看页面访问质量。
- 点击来源分析：按来源查看所有点击事件质量。

如果 UI 首期控制范围，可以在现有内容页和点击页增加来源筛选与来源列；后续再拆独立子页。无论 UI 形态如何，接口和聚合表必须支持来源维度。

### 8.4 流量漏斗效果图

后台新增流量漏斗模块，默认放在 `/admin/analytics` 总览首屏的趋势区域下方，并提供进入独立 `/admin/analytics/funnel` 页的入口。

视觉形态：

- 左侧为横向阶梯漏斗，从 `Session` 到 `会员发放` 逐层收窄。
- 每一层展示阶段名称、数量、相对上一阶段转化率、相对入口转化率。
- 右侧展示主要流失点和运营解释，例如“页面访问到详情浏览流失最高”。
- 顶部提供日期、来源、邀请码和页面筛选。
- 点击某一阶段可跳转到对应明细：页面访问跳页面来源分析，关键点击跳点击来源分析，联系/注册跳来源总览或邀请报表。

低保真效果图已通过视觉辅助草图展示，结构如下：

```text
来源筛选：Telegram 六月互推（code: telegram-june）/ 最近 7 天

Session        ████████████████████  1,240  100%
页面访问       ████████████████      1,018   82.1%
详情浏览       █████████            596    58.5%
关键点击       █████                347    58.2%
联系/注册      ██                   136    39.2%
会员发放       █                    43     31.6%

右侧：主要流失点、来源质量解释、下钻入口
```

漏斗颜色使用后台现有中性色和低饱和强调色，不做营销式大色块；在移动端改为纵向列表，保持每层高度固定，避免数字变化造成布局抖动。

## 9. 数据修复与上线

生产已有少量测试 session 和健康数据，但日报聚合为空。上线顺序：

1. 新增 D1 migration，创建来源维度聚合表。
2. 部署 API 修复，使新事件能写入日报和来源维度聚合，并让来源查询返回 `sourceCode/sourceLabel`。
3. 部署 Web 后台诊断、来源维度视图和自动生成 code 的自定义文案表单。
4. 生产开启 `analytics_enabled = true`，保持当前 1% 原始事件采样。
5. 用追踪链接访问首页、点击联系或 CTA，验证后台总览、来源、页面来源、点击来源和流量漏斗均有数据。

历史空日报不强制回填；如果需要回填，只能基于 `analytics_sessions`、`analytics_session_summaries`、`analytics_page_summaries` 和关键 raw events 做一次性脚本。由于当前生产仍是早期测试数据，本轮不把历史回填作为上线阻断。

## 10. 测试计划

- API unit：批量 `page_view`、`page_leave` 写入 `analytics_daily_pages` 和 `analytics_daily_sources`。
- API unit：批量点击事件写入 `analytics_click_daily` 和 `analytics_source_click_daily`。
- API unit：带 `mg_source` / UTM 的 session 内页面和点击都使用同一来源。
- API unit：来源创建必须包含 `sourceLabel`；`sourceCode` 自动生成、唯一且创建后不可修改，`sourceLabel` 可修改。
- API unit：来源聚合保存稳定 `sourceCode`，展示查询能解析当前 `sourceLabel`。
- API unit：overview 在 health 有接收但日报为空时返回诊断字段。
- API unit：source-pages 和 source-clicks 查询支持日期范围与来源筛选。
- API unit：funnel 查询返回阶段值、阶段间转化率和主要流失点。
- Web unit：后台总览渲染诊断提示。
- Web unit：来源页能展示推广来源质量，并跳转来源页面/点击视图。
- Web unit：来源创建表单只填写自定义文案等运营字段；创建后展示自动生成的 `code`，编辑时只允许修改自定义文案等展示字段，不允许改 `code`。
- Web unit：流量漏斗组件能渲染非 0 数据、空数据和来源筛选态。
- 构建验证：`corepack pnpm --filter @meigallery/api exec tsc --noEmit`。
- 构建验证：`corepack pnpm --filter @meigallery/web exec nuxt build`。
- 生产验证：真实访问追踪链接并点击后，D1 日报表、后台页面和漏斗阶段都显示非 0 数据。

## 11. 验收标准

- 访问普通页面后，后台总览 PV、Session 和有效时长不再全部为 0。
- 点击广告、联系入口、会员 CTA 或图库卡片后，后台点击页能看到对应点击。
- 使用推广来源追踪链接访问后，来源总览能显示该来源的 session、PV、联系、注册或会员转化。
- 来源创建时必须填写自定义文案，`code` 由后台自动生成并写入数据和追踪链接，自定义文案用于页面展示且支持后续修改。
- 修改自定义文案后，历史来源报表和漏斗显示新文案，但底层数据仍按原 `code` 聚合。
- 来源页面分析能回答“某来源访问了哪些页面，表现如何”。
- 来源点击分析能回答“某来源触发了哪些点击，质量如何”。
- 流量漏斗效果图能回答“某来源从访问到联系、注册、会员发放的每一步转化如何”。
- 漏斗阶段点击后能进入对应页面或点击明细，不需要运营重新拼筛选条件。
- 采集关闭或聚合异常时，后台给出明确中文提示，而不是只显示空表。
- 新增或修改的后台写操作继续写审计日志；本轮分析采集聚合不新增管理员写操作。
- API 类型检查和 Web 构建通过。

## 12. 自审记录

- 文档章节完整，未留下未决事项。
- 已明确本轮根因：批量采集缺少日报聚合写入，不是单纯前端点击事件缺失。
- 已明确来源口径：默认会话首触来源，事件级来源只用于排查。
- 已明确来源主数据口径：稳定 `code` 用于保存，可编辑自定义文案用于展示。
- 已避免把邀请码和推广来源混为同一模型。
- 已给出页面访问和点击事件的来源维度数据结构。
- 已补充流量漏斗效果图的阶段、指标口径、接口和后台展示位置。
- 已说明不回填历史早期测试数据，避免把一次性脚本变成本轮上线阻断。
- 已保留 D1 成本约束：后台默认查聚合表，不扫原始事件。
