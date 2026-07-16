# 通用广告归因架构

## 核心原则

站内只创建一次可信业务事实，Meta、TikTok、Google 通过独立 adapter 消费。单条事实最多归属于一个广告平台，不允许广播、fan-out、按“哪些平台已开启”重复发送，也不允许平台 adapter 创建业务事实。

```text
Contact / CompleteRegistration
              ↓
attribution_conversion_facts
              ↓
唯一可信来源（meta / tiktok / google / none）
              ↓
Planner + Consent + Rollout
              ↓
唯一平台的 Browser / Server delivery
```

## 最终数据模型

`0051_unified_attribution_expand.sql` 创建最终 11 张通用表：

- `attribution_platform_connections`：平台连接、模式、开关、版本与 rollout。
- `attribution_event_bindings`：标准事件到 Browser/Server destination 的映射。
- `attribution_credentials`：由通用主密钥加密的平台凭证。
- `attribution_conversion_facts`：唯一业务事实源。
- `attribution_deliveries`：Browser/Server 投递账本和 lease 状态。
- `attribution_outbox`：按 provider 隔离的加密待发送上下文。
- `attribution_provider_receipts`：来源和 Browser 回执。
- `attribution_verifications`：连接验证结果。
- `attribution_incidents`：平台运行故障。
- `attribution_quality_snapshots`：平台质量指标。
- `attribution_usage_daily`：平台调用和成本预算。

`0052_unified_attribution_contract.sql` 在事实覆盖、旧 Server 投递静止和旧 Outbox 清空后，迁移 Meta 质量历史并删除旧事实表、旧投递表、旧连接/验证表、旧 Outbox、旧 Meta 运维表、桥接 trigger 和 `users.meta_external_id`。应用运行时不得再访问这些历史结构。

历史 migration `0001..0050` 只用于已有数据库升级和空库顺序建库，不代表当前运行架构。

## 事实与来源

- 活动事件只有 `Contact` 和 `CompleteRegistration`。
- `Contact` 仅在原生联系跳转或复制联系方式成功并通过服务端校验后创建。
- `CompleteRegistration` 仅由注册事务成功后创建，客户端不能声明注册成功。
- 二维码展开、页面浏览和普通点击属于一方分析事件，不进入广告转化事实。
- `PUT /api/ad-attribution` 根据 click ID、明确 UTM 平台和后台投放来源签发短期 HttpOnly receipt；浏览器不能直接声明 provider。
- 多平台信号冲突、来源未知、授权无效或校验失败时，只保留站内事实，不创建广告投递。

## 平台隔离

- Planner 只读取事实上的唯一 `attribution_provider`。
- Meta 只读取 Meta connection、credential、Queue 和 receipt；TikTok、Google 同理。
- 三个平台共享状态机和数据结构，但使用独立主 Queue/DLQ、destination、connection revision、credential revision 和 rollout。
- 同一 provider 的 Browser/Server delivery 复用同一 external event ID 去重；不同 provider 的 event ID 不共享。
- Meta 加密上下文只允许 `fbp/fbc`，TikTok 只允许 `ttclid/ttp`，Google 只允许其标准点击和增强转化字段。
- 连接关闭、凭证缺失、营销授权拒绝或 rollout 未命中时，站内事实仍写入，平台投递明确记录为跳过或失败。

## Adapter 边界

每个平台 adapter 只负责：

1. 标准事件映射。
2. Browser 指令。
3. Server API payload 和响应分类。
4. 连接验证和测试事件。
5. 平台专属质量指标。

新增平台不得修改 `recordContact()`、`recordRegistration()`、来源 receipt 规则或通用 Queue 状态机。前端只消费 provider-aware `trackingInstructions`，通过 registry 分发到唯一 adapter。

## 连接与凭证

后台以“平台连接”为配置单位，destination ID、事件映射、凭证、模式和开关原子保存：

- 公开配置保存在 `attribution_platform_connections`。
- Token 或 Service Account 由 Owner 写入 `attribution_credentials`，使用 `AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT/PREVIOUS` 加密。
- 明文凭证不回显、不写日志、不进入审计和发布报告。
- connection revision 或 credential revision 变化后，原验证立即失效并要求重新验证。
- Meta/TikTok Test Event Code 是单次请求参数，不持久化；production 正式事件不携带测试码。

## 环境规则

- production 才绑定真实平台 Queue、凭证和平台 API。
- dev/local 只进行 migration、adapter mock、Queue/Workflow mock、来源隔离、类型检查和构建验证。
- 生产发布不自动修改 enabled、mode、rollout、incident 或凭证。
- 通用门禁要求 `0052` 已应用、启用的 production 连接具有当前有效验证、无 critical incident、无过期 Outbox、无 dead letter 且 rollout 一致。

## 新平台接入

1. 在 shared type 和 registry 注册 provider、能力和公开配置 schema。
2. 实现 Browser、Server 和 Verification adapter。
3. 配置独立 Queue/DLQ 与凭证类型。
4. 注册标准事件 bindings 和可信来源规则。
5. 接入统一后台平台连接、质量和诊断视图。
6. 覆盖同平台去重、跨平台冲突零投递、授权拒绝、凭证失效和重试测试。
7. production 验证后从 rollout `0` 人工放量。

## 当前状态

- Meta、TikTok、Google 已进入同一最终 schema、Planner、Queue 状态机和后台连接 API。
- Meta production 已验证并按现有 rollout 运行；TikTok、Google 是否启用以后台实时连接状态为准。
- Meta Dataset Quality 由通用 collector 写入 `attribution_quality_snapshots`，不再依赖旧 Meta 运维表。
- 旧平台专用运行代码、迁移桥接和数据库技术表由 `0052` Contract 删除。
