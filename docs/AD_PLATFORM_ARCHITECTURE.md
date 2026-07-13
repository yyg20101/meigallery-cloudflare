# 广告平台接入架构

## 目标

站内业务事实只定义一次，Meta、TikTok、Google 等平台通过 adapter 消费同一事实。新增平台不得复制联系、注册、授权、去重或分析业务逻辑。

```text
Contact / CompleteRegistration
              ↓
analytics_conversion_actions
              ↓
可信来源路由（零或一个 provider）
              ↓
Advertising Delivery Core
              ↓
唯一命中的 Provider Adapter
```

## 分层

### 业务事实层

- `analytics_conversion_actions` 是唯一事实源。
- 每条事实的 `attribution_provider` 只能是一个明确平台或空值，写入后不可修改。
- 活动事件仅为 `contact`、`complete_registration`。
- 联系由公开联系命令经服务端校验创建；注册由服务端事务成功后创建。
- 广告平台关闭、失败或未配置时，站内事实仍正常写入。

### 可信来源层

- 浏览器把 `fbclid`、`ttclid`、UTM 和后台投放链接 code 交给 `PUT /api/ad-attribution`，不能直接提交 provider。
- API 以 click ID、明确平台别名和 `analytics_tracking_sources.ad_provider` 解析唯一来源，并使用 `SESSION_SECRET` 签发短期 HttpOnly receipt。
- Meta 与 TikTok 信号冲突、显式来源未知、输入非法、数据库不可用或营销授权无效时，结果均为空并清除旧 receipt。
- 页面导航可以在无新信号时继承未过期 receipt；出现任何新的显式信号时必须重新判定，不能沿用旧平台。
- 浏览器端来源校验必须串行执行，并使迟到的旧响应失效；平台发生切换时先卸载旧 Pixel，再初始化唯一命中的 Pixel。
- Contact 与注册请求中的客户端状态只能将投递降级为 `suppress`，不能把无 receipt 的请求升级为任何平台。

### 通用投递层

`analytics_conversion_deliveries` 使用以下稳定维度：

- `provider`：`meta`、`tiktok`、`google` 等平台标识。
- `transport`：`browser` 或 `server`。
- `external_event_id`：同一 provider 的 Browser/Server 去重 ID。
- `connection_revision`：投递绑定的连接版本。
- `status`、重试、lease、rollout 和匹配覆盖率继续作为投递事实保存。

旧 `channel` 与 `meta_connection_revision` 已由 migration `0047_ad_platform_delivery_core.sql` 删除。旧投递和投递日聚合属于可重建的技术数据，迁移时清空；`analytics_conversion_actions` 业务事实、连接验证和平台诊断保留。唯一约束收口到 `conversion_action_id + provider + transport`。

### Adapter 层

每个平台 adapter 只负责事件映射、Browser 指令、Server API payload、连接验证、测试事件和平台专属诊断。adapter 不负责创建业务事实，也不得读取其他平台的 token、Queue 或 rollout。Server transport 共用加密、outbox、lease、重试与 DLQ 状态机，但必须通过 `provider` 隔离数据、密钥和消息；Meta 密文只允许 `fbp/fbc`，TikTok 密文只允许 `ttclid/ttp`。投递规划只读取事实上的唯一 `attribution_provider`，不得枚举已启用平台或 fan-out。D1 trigger 会拒绝已明确归因事实与 delivery 平台不一致的写入；空来源只为 migration 先于 Worker 的发布窗口保留 schema 兼容，新应用对其始终零投递。

### 浏览器指令

API 优先返回 `trackingInstructions`：

```ts
interface AdBrowserInstruction {
  provider: 'meta' | 'tiktok' | 'google'
  deliveryId: string
  eventName: string
  eventId: string
  payload: Record<string, string | number | boolean>
  receiptToken: string
}
```

前端通过 provider registry 分发。API 只返回 `trackingInstructions`，不再返回平台专属兼容字段。

## 连接管理

后台以“平台连接”为产品单位展示 destination ID、凭证状态、模式、验证状态、revision 和最近验证时间。destination ID 与 token 在 UI 中属于同一连接，但底层分级存储：

- destination / Pixel ID：可保存在 D1。
- Access Token：只保存在 production secret 或受控加密凭证存储中，禁止回显。
- destination、凭证指纹或平台 API 版本等连接身份变化时，connection revision 失效并要求重新验证；普通开关、运行模式和 rollout 调整不轮换连接身份。

统一只读入口为 `GET /api/admin/attribution/platforms`。Meta 与 TikTok 分别通过 `PATCH /api/admin/attribution/platforms/meta`、`PATCH /api/admin/attribution/platforms/tiktok` 原子管理公开标识、Browser/Server 开关、运行模式和灰度；token 仍只由对应 Worker secret 管理。TikTok Test Event Code 只通过 `POST /api/admin/attribution/platforms/tiktok/verify` 的单次请求使用，不持久化、不审计、不回显。

后台总览、趋势、匹配覆盖和 campaign 拆分必须显式携带 `provider=meta|tiktok`。通用响应使用 `serverSent`、`browserId`、`clickId`；平台 adapter 再把匹配标识解释为 Meta 的 `fbp/fbc` 或 TikTok 的 `_ttp/ttclid`。Meta Dataset Quality 只属于 Meta，不得伪装为 TikTok 质量数据。

## 环境规则

- 真实 Pixel、Events API、token、Queue、测试事件和诊断仅存在于 production。
- dev/local 只运行 adapter 单元测试、契约测试、migration、类型检查和构建。
- 每个平台使用独立 Queue、DLQ、secret、连接状态、incident 和 rollout。
- 平台之间共享事实 schema，但单条业务事实不共享归因所有权；Meta 来源只进入 Meta，TikTok 来源只进入 TikTok，无来源只保留站内事实。
- production 发布在任何 D1 migration 前只读确认 Meta/TikTok 的主 Queue 与 DLQ 全部存在；缺失资源时直接阻断，不允许先改变 schema。

## 新平台接入步骤

1. 在 shared types 注册 provider。
2. 注册事件映射和 transport。
3. 实现 Browser adapter。
4. 实现 Server API adapter、Queue 与 DLQ。
5. 实现连接验证、测试事件和凭证状态。
6. 将 provider 注册到统一后台连接列表，并补充平台专属趋势查询。
7. 验证 Browser/Server 同 event ID 去重。
8. 注册可信来源识别规则，并验证与所有既有 provider 的冲突场景均为零投递。
9. 通过独立 rollout 放量。

新增平台不得修改 `recordContact()`、`recordRegistration()` 或注册/联系页面的业务判断。

## 当前迁移状态

- 已完成：统一连接表、通用 provider/transport schema、事件 registry、统一连接管理 API、浏览器 adapter registry、通用 tracking instruction 响应。
- 已清理：旧 Meta 站点设置键、`channel`、`meta_connection_revision`、`pixelEvents`、旧投递数据和旧投递日聚合。
- 保留：Meta adapter、Queue、incident、Dataset Quality 和 live challenge。这些是当前 Meta 实现，不是兼容层。
- migration `0049_tiktok_events_api.sql` 以 expand 方式建立 `ad_platform_secure_outbox`、通用用户转化标识、TikTok 匹配覆盖字段与 production 连接验证表。旧 Meta outbox 和用户标识列仅在发布/回滚窗口由数据库 trigger 双向桥接，应用代码已完全收口到通用结构。
- contract 清理必须在后续独立版本进行：production 新 Worker 稳定、桥接一致性为零差异且旧 Worker 回滚窗口关闭后，才删除旧表、旧列和桥接 trigger；不得把 expand 与 contract 放进同一次迁移批次。
- 已完成：TikTok Browser Pixel、Events API v1.3、独立凭证、Queue/DLQ、加密 outbox、连接验证、rollout、真实 D1 测试和统一后台数据看板。
- 已完成：`0050` 严格来源路由、签名来源 receipt、单 provider 投递规划、后台来源平台绑定、跨平台 D1 写入防护和冲突零投递测试。
- 生产状态：TikTok 默认 `disabled`、Server rollout `0`；只有 production 配置完成并通过 TikTok Test Events 验证后才能人工开启。dev/local 不连接真实 TikTok 资源。

## 官方参考

- [TikTok Events API Web Events](https://business-api.tiktok.com/portal/docs/report-app-web-offline-or-crm-events/v1.3)
- [TikTok Events API 概览](https://ads.tiktok.com/help/article/events-api?lang=en)
- [TikTok 标准事件与参数](https://ads.tiktok.com/help/article/standard-events-parameters?lang=en)
- [TikTok Web Lead 事件口径](https://ads.tiktok.com/help/article/available-events-for-web-lead-generation?lang=en)
- [TikTok Browser / Server 事件去重](https://ads.tiktok.com/help/article/event-deduplication)
- [TikTok Events API 匹配参数](https://ads.tiktok.com/help/article/how-to-set-up-matching-events-with-events-api)
