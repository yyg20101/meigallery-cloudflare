# 归因中心干净方案设计

## 0. 文档状态

- 状态：独立大规格，已确认采用“归因中心”方向，尚未进入实现。
- 日期：2026-07-08。
- 范围：广告归因、Meta Pixel / Conversions API 同步、后台归因 UI、测试覆盖矩阵和生产发布闸门。
- 关联文档：
  - `docs/superpowers/specs/2026-07-08-meta-capi-attribution-layer-design.md`
  - `docs/UI_DATA_ANALYTICS_DASHBOARD.md`
  - `docs/TECHNICAL_SPEC.md`
  - `docs/GIT_WORKFLOW.md`

本文是更上层的产品和工程规格。`2026-07-08-meta-capi-attribution-layer-design.md` 继续作为 Meta Pixel / CAPI、转化账本和去重层的技术输入；本文负责定义后台如何让运营看懂归因、如何证明测试足够可靠、以及什么条件下允许进入生产。

## 1. 背景和问题

当前项目已经具备三类能力：

- 一方数据分析：前台 SDK 写入 `/api/analytics/events`，后台 `/admin/analytics` 展示来源、SEO、点击、趋势和健康数据。
- 推广来源链接：后台可创建 `mg_source`、UTM 链接，用于区分渠道和活动。
- Meta Pixel：浏览器侧可以向 Meta 发送部分标准事件。

这些能力的边界目前仍容易被混淆：

- 后台来源里的 `fb`、`facebook`、`meta` 是 UTM、推广链接或 referrer，不是 Pixel 或 CAPI 回传。
- 现有“Meta 像素测试地址”本质是广告测试链接生成器，不是 Pixel 测试页，也不是 CAPI 同步状态页。
- 联系点击、完成注册、开始试用等高价值动作需要统一业务口径，否则 Pixel 和 CAPI 难以用同一个 `event_id` 去重。
- 当前后台数据分析页面已经覆盖很多运营指标，如果继续把归因内容塞进去，会让“站内分析”和“广告归因”互相污染。

因此本轮不再继续补丁式增强来源页，而是新增独立的“归因中心”设计。

## 2. 设计目标

归因中心的目标是让 Owner / Admin 能高效回答：

- 哪些广告链接、素材、受众或渠道带来了有效联系、注册和会员转化。
- 某一天的转化和 Meta 同步是否正常。
- Pixel 与 CAPI 是否使用同一个去重 ID，是否仍出现重复事件。
- CAPI 失败、跳过或配置缺失时，原因是什么，是否影响站内转化。
- 上生产前哪些自动化测试和人工验收必须通过。

核心原则：

- **站内转化账本是唯一事实源**。后台大盘不从 Meta 反向覆盖站内转化。
- **Meta 是同步渠道，不是事实来源**。Pixel attempted、CAPI sent、CAPI failed 只描述投递状态。
- **广告链接不是 Pixel 地址**。投放链接只负责来源识别和 A/B 测试。
- **高价值动作才进入归因中心**。普通浏览、后台行为、受保护媒体访问不进入 Meta CAPI。
- **测试和发布门槛前置**。归因相关改动不能只靠生产后台观察。

## 3. 非目标

- 不在本阶段接入 Meta Marketing API 的花费、展示、点击、campaign、ad set、ad 明细。
- 不自动创建或管理 Meta 广告系列、预算和素材。
- 不把 Meta 后台归因结果作为站内后台事实数据。
- 不上传邮箱、手机号、联系方式值、会员备注、私有媒体 URL、R2 key、Stream token、后台路径或后台操作详情。
- 不在首期实现完整 CMP；但必须保留 marketing tracking 一键关闭能力和清晰状态提示。

## 4. 后台信息架构

推荐新增独立入口“归因中心”，优先路由：

```text
/admin/attribution
  /admin/attribution
  /admin/attribution/conversions
  /admin/attribution/links
  /admin/attribution/meta
  /admin/attribution/duplicates
  /admin/attribution/readiness
```

如果后续后台导航不希望新增一级入口，可降级为 `/admin/analytics/attribution` 系列，但页面命名仍必须使用“归因中心”，避免与泛 analytics 混淆。

页面分工：

| 页面 | 目标问题 | 核心数据 |
|------|------|------|
| 归因总览 | 今天广告归因是否健康，哪里需要处理 | 有效联系、注册、Lead、CAPI 状态、重复率 |
| 转化趋势 | 哪个来源、活动、素材带来高价值动作 | 转化账本日报、来源、campaign、content |
| 投放追踪链接 | 为广告测试创建和管理落地链接 | `mg_source`、UTM、目标页、备注、状态 |
| Meta 同步健康 | Pixel / CAPI 是否配置和投递正常 | Pixel attempted、CAPI sent / failed / skipped |
| 重复事件诊断 | 是否有重复点击或重复上报 | dedupe key、external event id、重复原因 |
| 发布检查 | 上线前是否满足测试和开关要求 | CI、dev 验收、Meta Test Events、回滚开关 |

## 5. UI 设计原则

归因中心是后台运营工具，不是营销展示页。视觉方向沿用当前后台“精密运营舱”基调：紧凑、克制、可扫描，用趋势图和表格服务判断，不做大 hero。

界面要求：

- 顶部固定时间范围：7 天、30 天、90 天、单日；单日必须支持选择某一天。
- 所有页面保留刷新时间、查询范围、数据延迟和异常状态。
- 所有 Meta 相关指标必须标注口径：站内转化、Pixel attempted、CAPI sent、CAPI failed、CAPI skipped。
- 卡片用于少量关键指标；主要分析使用趋势图、排序表和诊断表。
- 颜色语义保持克制：绿色表示正常，黄色表示需观察，红色表示阻断，蓝色表示来源，金色表示会员或高价值转化。
- 文案必须从运营视角命名，例如“投放追踪链接”，不再使用“Meta 像素测试地址”。

## 6. 归因总览

路由：`/admin/attribution`

首屏布局：

```text
┌ 归因中心                         [7天][30天][90天][单日] [刷新] ┐
├ 健康条：Pixel 已启用 · CAPI 已关闭 · 最近成功 10:32 · 重复率 0.4% │
├ KPI：有效联系 / 首次有效联系 Lead / 完成注册 / 会员发放 / CAPI 失败 │
├ 左：转化趋势图                      右：Meta 同步状态分布       │
├ Top 投放链接 / Top campaign / 异常队列                          │
└ 发布提醒：dev 验收未完成、Test Event 未通过、生产 CAPI 未开启     │
```

必须展示：

- 有效联系：站内转化账本中的有效联系动作。
- 首次有效联系 Lead：同一 session 首次有效联系派生的 `Lead`。
- 完成注册：注册成功后生成的 `CompleteRegistration`。
- 开始试用：只有真实试用入口存在时才允许上报，不再由注册成功自动派生。
- 会员发放：后台发放会员后的最终业务结果，暂不进入 Meta CAPI 首期同步。
- Meta 投递状态：sent、failed、skipped、duplicate_suppressed。
- 最近成功投递时间和最近失败原因。

空态：

- 没有数据时展示“当前范围暂无归因转化”，并引导创建投放追踪链接或查看采集健康。
- Pixel / CAPI 未启用时不显示为错误，显示为“未启用，同步已跳过”。
- Secret 缺失时显示红色配置风险，但不得展示 Secret 值。

## 7. 转化趋势

路由：`/admin/attribution/conversions`

核心能力：

- 趋势图：按日展示有效联系、Lead、完成注册、开始试用、会员发放。
- 来源表：source channel、source name、campaign、content、session、有效联系、Lead、注册、联系率、注册率。
- 单日查看：沿用 `range=day&from=YYYY-MM-DD&to=YYYY-MM-DD` 或等价查询能力。
- 下钻：从某个投放链接进入该链接的趋势、转化明细抽样和 Meta delivery 状态。

指标口径：

| 指标 | 口径 |
|------|------|
| 有效联系 | 用户点击可发起联系的方式，例如聊天跳转、复制联系方式、二维码打开；必须完成业务动作后记录。 |
| Lead | 同一 session 内首次有效联系派生，重复点击不重复派生。 |
| 完成注册 | 注册成功后记录，只映射 `CompleteRegistration`。 |
| 开始试用 | 只有用户真实进入试用流程后记录，不由注册成功自动推断。 |
| 重复转化 | 同一 dedupe key 或 external event id 被重复提交且被抑制。 |
| Meta 成功率 | CAPI sent / 需要 CAPI 投递的 delivery 数，不包含 disabled 或 consent denied。 |

趋势图要求：

- 至少展示一个多线趋势图。
- 默认显示有效联系、注册、CAPI 失败；其他线可通过图例开关。
- 单日模式下趋势图降级为小时分布或单日摘要；实现初期可先显示单日 KPI + 明细表。

## 8. 投放追踪链接

路由：`/admin/attribution/links`

当前来源页侧栏的“Meta 像素测试地址”迁移为独立页面中的“投放追踪链接”。

创建字段：

- 链接名称：运营可读名称，例如“Meta 广告 A｜聊天 CTA”。
- 渠道：Meta、Google、TikTok、社交、合作、其他；首期 Meta 只是默认模板。
- 目标页面：只允许公开前台路径，不允许 `/admin`、`/api`、敏感 query 和私有媒体路径。
- `utm_campaign`：活动名称。
- `utm_content`：素材、受众、版位或 CTA 版本，用于 A/B 测试。
- 备注：运营备注，不进入 Meta。

展示字段：

- 完整链接和短展示路径。
- 状态：active、disabled。
- session、有效联系、Lead、完成注册、会员发放。
- 联系率、注册率、最近转化时间。
- Meta CAPI 最近投递状态。

交互要求：

- 创建成功后复制链接。
- 支持停用链接，停用后不删除历史数据。
- 行操作支持“查看转化”“查看 Meta 投递”“复制链接”。
- 页面必须明确提示：这是 UTM / `mg_source` 投放链接，不是 Pixel 地址。

## 9. Meta 同步健康

路由：`/admin/attribution/meta`

该页面只描述 Meta 相关同步状态，不作为站内转化事实来源。

展示内容：

- Pixel 配置状态：enabled / disabled、Pixel ID 是否存在、debug 是否开启。
- CAPI 配置状态：enabled / disabled、Access Token 是否存在、Queue binding 是否可用。
- Test Event 状态：测试事件最近触发时间、事件名、结果。
- 投递趋势：Contact、Lead、CompleteRegistration 的 sent、failed、skipped。
- 错误分类：missing_secret、disabled、consent_denied、invalid_payload、meta_4xx、meta_5xx、network_error、duplicate_suppressed。

权限：

- admin 可以查看汇总状态和错误分类。
- owner 才能触发 Test Event、启停 CAPI、修改 Pixel / CAPI 设置。
- 所有设置修改和 Test Event 触发必须写审计日志。

## 10. 重复事件诊断

路由：`/admin/attribution/duplicates`

目的：专门处理 Meta 后台提示“重复事件”和站内重复点击问题。

必须展示：

- 重复事件总数和重复率。
- 按事件类型拆分：Contact、Lead、CompleteRegistration、StartTrial。
- 重复原因：相同 `dedupe_key`、相同 `external_event_id`、短时间重复点击、Pixel/CAPI 重复未去重、客户端重试。
- 最近重复样本：时间、来源、动作、处理结果。

处理原则：

- 站内有效转化按业务 dedupe key 计算。
- Pixel 和 CAPI 对同一 Meta 标准事件必须共享同一个 `external_event_id`。
- 已成功 CAPI sent 的同一 external event 不再重复调用 Meta。
- duplicate_suppressed 是健康处理结果，不应算作投递失败。

## 11. 发布检查

路由：`/admin/attribution/readiness`

该页面不是 CI 的替代品，而是运营和发布前的可视化检查单。

检查项：

- 站内 analytics 已启用。
- marketing tracking 当前模式明确显示。
- Pixel 生产开关状态明确。
- CAPI 生产开关状态明确。
- CAPI Secret 存在但不展示值。
- dev 环境 Meta Test Events 已通过。
- 最近 24 小时没有阻断级 CAPI 错误。
- 重复事件率低于告警阈值。
- 回滚开关可用：关闭 Pixel、关闭 CAPI、停止 Queue 入队。

页面状态：

- 绿色：可发布。
- 黄色：可发布但建议观察，例如 CAPI disabled 但本阶段只上线转化账本。
- 红色：阻断发布，例如 Secret 缺失且本次要启用 CAPI、Test Events 未通过、重复率异常。

## 12. 数据口径和边界

事实源分层：

```text
用户动作
  -> 站内转化账本 analytics_conversion_actions
  -> 一方 analytics 兼容聚合
  -> Pixel delivery / CAPI delivery
  -> 后台归因中心
```

口径要求：

- 后台归因中心优先读取转化账本和聚合表，不直接扫描全量原始事件作为默认报表。
- `fb`、`facebook`、`meta` 来源只表示站内来源识别，不表示 Meta 回传。
- Pixel attempted 只能说明浏览器尝试发送，不能证明 Meta 接收。
- CAPI sent 说明服务端收到 Meta 成功响应。
- skipped 需要细分 disabled、missing_secret、consent_denied、missing_pixel_id 等原因。
- failed 需要细分 Meta 4xx、Meta 5xx、网络错误和 payload 错误。

## 13. 测试覆盖策略

不能承诺“完全覆盖所有真实世界情况”，但必须做到核心风险进入生产前被阻断。测试分为自动化发布门槛和人工外部验收两类。

### 13.1 自动化测试矩阵

| 层级 | 必测内容 | 阻断标准 |
|------|------|------|
| shared 合约 | 转化事件枚举、Meta 映射、payload schema、禁止字段 | 映射缺失或敏感字段进入 payload 即失败 |
| API 单元 | conversion action、dedupe key、external event id、delivery 状态机 | 重复事件未抑制或 ID 不稳定即失败 |
| API 集成 | `/api/conversions/events`、账本写入、analytics 兼容、admin 查询 | 账本和后台口径不一致即失败 |
| Queue / CAPI | sent、failed、skipped、retry、duplicate_suppressed | 5xx 不重试或 4xx 无限重试即失败 |
| Web composable | `useConversionTracking()`、Pixel adapter、consent、统一 event id | 业务组件直接调用 Pixel 即失败 |
| 前台组件 | ContactPanel、ContactMethodItem、注册页、试用入口 | 联系值泄露或注册误发 StartTrial 即失败 |
| 后台 UI | 归因 tabs、单日筛选、趋势图、空态、错误态、权限态 | 单日不可查或 Meta 口径误导即失败 |
| E2E smoke | 点击聊天、完成注册、后台单日归因、投放链接创建 | 核心链路缺事件或页面溢出即失败 |

### 13.2 必须补齐的关键用例

事件口径：

- 点击聊天跳转后生成一条有效联系转化。
- 复制联系方式或打开二维码也按有效联系处理，但不记录联系方式值。
- 同一 session 首次有效联系派生 `Lead`。
- 重复点击不重复派生 `Lead`。
- 注册成功只触发 `CompleteRegistration`。
- 注册成功不自动触发 `StartTrial`。

去重：

- 同一业务动作生成一个 `conversion_action_id`。
- Pixel 和 CAPI 对同一 Meta 事件使用同一个 `external_event_id`。
- 同一 `external_event_id` 已 sent 后，CAPI 不重复调用 Meta。
- duplicate_suppressed 不计入 failed。

合规和安全：

- marketing consent denied 时，不加载 Pixel，不创建 Meta CAPI delivery。
- `/admin/**`、`/api/**`、私有媒体路径、敏感 query 不进入 Pixel / CAPI。
- payload、日志、后台表格不出现邮箱、手机号、联系方式值、token、R2 key、私有 URL。
- CAPI token 只存在 Worker Secret，不进 D1、前端 runtime config、日志或后台表单。

后台 UI：

- 归因中心能按单日查看有效联系、Lead、注册和 CAPI 状态。
- 投放追踪链接支持 `utm_campaign` 和 `utm_content`。
- Meta 同步页能展示 Secret 缺失、CAPI disabled、Meta 4xx/5xx、duplicate_suppressed。
- 非 owner 不显示 Test Event 触发、启停 CAPI 等危险操作。

### 13.3 CI 发布门槛

归因中心实现完成后，CI 至少必须覆盖：

- `pnpm lint`
- `pnpm test:scripts`
- `pnpm --filter @meigallery/api exec tsc --noEmit`
- `pnpm --filter @meigallery/web typecheck`
- `pnpm --filter @meigallery/web test:unit`
- `pnpm --filter @meigallery/api test`
- `pnpm --filter @meigallery/api test:coverage`
- `pnpm --filter @meigallery/web test:e2e`
- `pnpm --filter @meigallery/web build`
- `pnpm --filter @meigallery/api build`

若归因相关核心文件变更但未运行归因相关测试，PR 不允许合入。

### 13.4 人工外部验收

自动化无法完全替代 Meta 后台真实接收验证。启用生产 CAPI 前必须完成：

- Dev 环境使用测试 Pixel 或 Test Event Code 验证 Contact、Lead、CompleteRegistration。
- Meta Pixel Helper 验证浏览器 Pixel 事件带 `eventID`。
- Meta Test Events 验证 CAPI 事件带同一个 `event_id`。
- Meta 后台不再提示同一事件重复上报；若仍提示，必须记录诊断原因。
- Worker Logs 不出现联系方式值、token、私有 URL。
- 后台归因中心能看到测试链接对应转化和 delivery 状态。

## 14. 发布阶段

### 阶段 1：归因中心规格和 UI 骨架

- 写入独立规格。
- 确认后台入口、页面分工和文案口径。
- 不接生产 CAPI，不改现有投放逻辑。

验收：

- 规格明确区分站内来源、Pixel attempted、CAPI sent。
- 测试矩阵明确阻断条件。

### 阶段 2：转化账本和统一事件入口

- 实现转化事件合约和账本。
- 实现 `useConversionTracking()`。
- 迁移联系和注册链路。
- Pixel 支持统一 `eventID`。
- 后台归因中心展示基础转化趋势。

验收：

- 点击聊天跳转后生成有效联系。
- 同一 session 首次有效联系派生 Lead。
- 注册成功只触发 CompleteRegistration。
- 后台单日可查。

### 阶段 3：Meta CAPI 和同步健康

- 配置 Cloudflare Queue。
- 实现 CAPI adapter 和 consumer。
- 实现 delivery 状态机和 Meta 同步页。
- 引入 Test Event 入口和审计日志。

验收：

- Pixel 和 CAPI 共享 `event_id`。
- CAPI sent / failed / skipped 可追踪。
- Secret 缺失或 CAPI disabled 不影响站内转化。

### 阶段 4：投放链接和诊断增强

- 独立投放追踪链接页面。
- 支持 `utm_content` 和版本测试。
- 增加重复事件诊断页。
- 增加发布检查页。

验收：

- 每条投放链接可查看转化和 Meta delivery。
- 后台不再把 UTM 来源称为 Pixel 回传。
- 发布检查能阻断明显不合规或未验证的上线。

## 15. 风险和缓解

| 风险 | 缓解 |
|------|------|
| UI 继续变得拥挤 | 归因中心独立入口，不继续塞进来源页侧栏。 |
| 运营误解 Meta 数据 | 所有 Meta 卡片显示口径标签，投放链接不叫 Pixel 地址。 |
| 重复事件进入生产 | external event id 统一生成，CAPI sent 幂等，重复诊断页和自动化测试双保险。 |
| CAPI 失败影响用户动作 | 投递失败不阻断聊天、复制、二维码或注册。 |
| Secret 或 PII 泄露 | Secret 只放 Worker Secret，payload 白名单，日志脱敏，测试断言禁止字段。 |
| 测试覆盖虚高 | 区分自动化门槛和人工 Meta 验收，不承诺无法证明的“100% 覆盖”。 |
| 一次性范围过大 | 分 4 阶段实施，Meta Marketing API 暂不进入。 |

## 16. 最终验收标准

进入生产前必须满足：

- 归因中心后台 UI 已明确区分一方来源、站内转化、Pixel attempted、CAPI sent。
- 有效联系、Lead、CompleteRegistration、StartTrial 的触发条件和测试全部通过。
- 投放追踪链接能按广告版本查看单日和趋势数据。
- Meta 同步健康能展示 sent、failed、skipped、duplicate_suppressed 和错误分类。
- 自动化 CI 全绿。
- Dev 环境 Meta Pixel Helper 和 Meta Test Events 验收通过。
- 回滚开关验证通过：关闭 Pixel、关闭 CAPI、停止 CAPI 入队均不影响站内转化。
- 生产启用前由 Owner 明确确认。
