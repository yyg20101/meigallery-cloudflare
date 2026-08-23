# Recommendation-5 灰度目标、反指标与自动停止开发基线

日期：2026-08-20

状态：Cloudflare 源码开发完成；真实聚合来源、阈值、保留策略、配置、migration 执行、构建、专项测试与环境验证统一后置

## 1. 结论

Recommendation-5 为 Recommendation-1 已有的 `rolloutPercent=1..99` 补齐目标指标、反指标、最小观察条件和自动停止控制面。部分灰度现在必须绑定经独立复核的守护策略；批准来源缺少必需指标，或停止级反指标达到连续越线条件时，服务端写入不可变评估与永久投放阻断。后续新推荐会话不再选择该规则版本，只使用它已登记的 100% 安全回退。

本增量不修改公开 App 请求或响应 DTO，交付时累计 App API v2 为 `1.25.0`；Membership-7 后仓库当前累计为 `1.26.0`。不增加 KMP 或 Nuxt 页面，也不改变 Figma。当前事实保持 99 个 Page ID / 408 个正式状态，Mobile 50/208、Admin 49/200。

## 2. 默认关闭与决策门禁

`0113_app_recommendation_guardrails.sql` 只创建默认关闭的控制面：

- `evaluation_enabled=0`；
- 来源固定登记为 `recommendation_aggregate_v1`，但来源决策仍为 `unresolved`；
- 保留决策为 `unresolved`，`retention_days=NULL`，物理清理证明未启用；
- `production_ready=0`；
- 不 seed 真实策略、指标阈值、评估、阻断或规则绑定。

控制只有在来源、保留期与 purge 均批准后才允许开启；production 还同时要求控制和策略通过 production-ready。当前没有管理员接口修改该控制，避免在 OQ-009、OQ-020、OQ-031 未关闭时由页面或普通请求绕过治理决策。

## 3. 守护策略与职责分离

守护策略状态为：

```text
draft → pending_review → approved → retired
                    └─ reject → draft
```

- admin/Owner 可创建和编辑草稿、提交复核；Owner 才能决定或退休。
- 创建人不能复核自己的策略。
- approved 策略的来源、窗口、样本、连续次数、阈值和 production-ready 均不可改；调整必须创建新策略并重新复核。
- 被 active/scheduled 规则引用的策略不能退休；状态变更、事件和审计由同一 D1 batch 与 mutation token 绑定。
- 策略事件、评估、逐指标结果、停止阻断和幂等结果均为追加式事实，禁止更新或删除。

固定指标目录只定义允许的代码、方向和单位，不提供真实阈值：

| 类别 | 指标 |
|------|------|
| 目标 | 合格候选覆盖率、详情访问率、互动转化率、推荐理由覆盖率 |
| 反指标 | 举报率、拉黑率、披露投诉率、重复曝光率、无结果率、供给集中度、P95 延迟 |

每个策略至少包含一个目标和一个 `stop` 级反指标。比例统一以整数 ppm 表达，延迟以整数毫秒表达，避免浮点或任意公式进入运行时。

## 4. 聚合评估契约

仅 Owner 可提交评估。请求只接受：

- 当前规则乐观版本；
- `aggregate:recommendation:` 命名空间下、不含账号/会话/人物资料标识和凭证的内部快照引用；
- 快照内容小写 SHA-256；
- 窗口开始、结束、捕获时间和聚合样本数；
- 已登记指标的整数分子/分母或毫秒值。

未知字段、未知指标、重复指标、比率分子大于分母、未来或过期快照均拒绝。服务端不接收 accountId、sessionId、profileId、搜索词、消息、媒体或逐用户样本；审计只保存快照引用、摘要、样本量、指标数量和结果。

评估状态为：

- `observing`：样本量或观察次数不足；
- `healthy`：目标和反指标均满足；
- `target_missed`：目标未达，但没有安全越线；
- `warning`：warning 反指标越线，或 stop 指标尚未达到连续次数；
- `breached`：成熟样本中的 stop 指标达到连续越线次数；
- `source_incomplete`：批准来源缺少策略必需指标。

低样本不会被解释为健康；结构性缺失也不会等待更多样本，而是立即停止。`rule + sourceSnapshotRef` 和 `rule + policy + observationOrdinal` 均唯一；并发评估发生竞争时返回可重试冲突，不用重复序号伪造连续观察。

## 5. 自动停止与运行时回退

命中 `breached` 或 `source_incomplete` 时，同一事务写入：

1. 不可变评估与逐指标结果；
2. 每个规则版本唯一且不可删除的停止阻断；
3. 指向已登记 100% 回退版本的投放行为；
4. 评估和阻断两条管理员审计。

停止事实不会把规则行伪造为 `paused`，也不会生成不存在的操作者。管理员仍能在工作台看到原状态，并通过既有暂停流程记录真实人工动作。被阻断版本即使改成 100% 也不能重新进入投放；再次尝试必须复制为新规则、重新 Dry-run、复核并绑定合适策略。

运行时选择顺序继续为 scheduled、active、显式历史回退，但新增以下 fail-closed 条件：

- 部分灰度只有在控制开启、策略 approved、来源一致且环境门禁满足时才可执行；
- 任意比例的已阻断规则都被排除；
- 回退版本必须是已生效过、仍有效、当前地区/客户端兼容且 `rolloutPercent=100` 的完整版本；
- 目标被阻断或守护控制不可用时，只返回登记回退；没有安全回退则推荐 capability/请求明确不可用，不放宽公开人物资格。

## 6. 管理员 API

根路径仍为 `/api/admin/app/recommendations`：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/guardrails/overview` | 控制状态、策略/评估聚合、缺守护规则和阻断数量、固定指标目录 |
| `GET/POST` | `/guardrails` | 策略列表和幂等创建草稿 |
| `GET/PATCH` | `/guardrails/:policyId` | 详情、事件、引用量与草稿乐观更新 |
| `POST` | `/guardrails/:policyId/submit` | 提交独立复核 |
| `POST` | `/guardrails/:policyId/decision` | Owner 批准或驳回 |
| `POST` | `/guardrails/:policyId/retire` | 无生效引用时退休 |
| `POST` | `/rules/:ruleVersionId/guardrail-evaluations` | Owner 幂等冻结聚合评估 |
| `GET` | `/guardrail-evaluations/:evaluationId` | 读取评估、逐指标结果和停止事实 |

规则创建、编辑、复制和详情沿用既有 API，并增加 `guardrailPolicyId` 管理字段；公开 App DTO 不暴露守护策略或内部阈值。

## 7. UI、KMP 与 Figma 边界

当前正式 Figma 只有 `ADM-REC-01/02/03/04` 的规则、Dry-run 和精选工作台，没有守护策略编辑、监控或自动停止详情页面。本增量因此只实现服务端控制面和管理员 API，不自行增加 Nuxt 导航、页面、Page ID 或视觉状态。

KMP 继续只消费实际 `ruleVersionId`、模式、fallbackReason、推荐理由和精选披露；自动停止发生后，新会话自然取得回退版本，不需要客户端解析阈值或决定回滚。任何新监控页面、告警交互或图表都必须先进入正式 Figma。

## 8. 统一后置验证

全部开发完成后的统一验证至少覆盖：

- 默认关闭、来源/保留/purge/production-ready 任一缺失时部分灰度不可启用；
- 创建人与复核人分离、approved/retired/事件不可变、在用策略不能退休；
- 低样本保持 observing，目标未达与 warning 不错误停止；
- stop 连续次数、来源缺项立即停止和同快照哈希冲突；
- 幂等重放、并发观察序号、每规则唯一阻断和阻断后禁止复活；
- blocked target、完整回退、地区、客户端版本、taxonomy/heat 依赖与 production 门禁组合；
- 审计中不出现逐用户样本、账号、会话、人物资料或凭证。

当前没有修改 Wrangler，没有执行 `0083` 或 `0113`，没有写入真实来源/策略/阈值，没有启用推荐或守护 capability，也没有运行构建、测试、模拟器/真机或截图 QA。
