# 广告平台接入架构

## 目标

站内业务事实只定义一次，Meta、TikTok、Google 等平台通过 adapter 消费同一事实。新增平台不得复制联系、注册、授权、去重或分析业务逻辑。

```text
Contact / CompleteRegistration
              ↓
analytics_conversion_actions
              ↓
Advertising Delivery Core
              ↓
Meta Adapter / TikTok Adapter / Google Adapter
```

## 分层

### 业务事实层

- `analytics_conversion_actions` 是唯一事实源。
- 活动事件仅为 `contact`、`complete_registration`。
- 联系由公开联系命令经服务端校验创建；注册由服务端事务成功后创建。
- 广告平台关闭、失败或未配置时，站内事实仍正常写入。

### 通用投递层

`analytics_conversion_deliveries` 使用以下稳定维度：

- `provider`：`meta`、`tiktok`、`google` 等平台标识。
- `transport`：`browser` 或 `server`。
- `external_event_id`：同一 provider 的 Browser/Server 去重 ID。
- `connection_revision`：投递绑定的连接版本。
- `status`、重试、lease、rollout 和匹配覆盖率继续作为投递事实保存。

旧 `channel` 与 `meta_connection_revision` 已由 migration `0047_ad_platform_delivery_core.sql` 删除。旧投递和投递日聚合属于可重建的技术数据，迁移时清空；`analytics_conversion_actions` 业务事实、连接验证和平台诊断保留。唯一约束收口到 `conversion_action_id + provider + transport`。

### Adapter 层

每个平台 adapter 只负责事件映射、Browser 指令、Server API payload、连接验证、测试事件和平台专属诊断。adapter 不负责创建业务事实，也不得读取其他平台的 token、Queue 或 rollout。

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

统一只读入口为 `GET /api/admin/attribution/platforms`。Meta 连接通过 `PATCH /api/admin/attribution/platforms/meta` 原子管理公开标识、Browser/Server 开关、运行模式和灰度；token 仍只由 Worker secret 管理。

## 环境规则

- 真实 Pixel、Events API、token、Queue、测试事件和诊断仅存在于 production。
- dev/local 只运行 adapter 单元测试、契约测试、migration、类型检查和构建。
- 每个平台使用独立 Queue、DLQ、secret、连接状态、incident 和 rollout。
- 平台之间共享业务事实，但不共享凭证或投递状态。

## 新平台接入步骤

1. 在 shared types 注册 provider。
2. 注册事件映射和 transport。
3. 实现 Browser adapter。
4. 实现 Server API adapter、Queue 与 DLQ。
5. 实现连接验证、测试事件和凭证状态。
6. 将 provider 注册到统一后台连接列表，并补充平台专属趋势查询。
7. 验证 Browser/Server 同 event ID 去重。
8. 通过独立 rollout 放量。

新增平台不得修改 `recordContact()`、`recordRegistration()` 或注册/联系页面的业务判断。

## 当前迁移状态

- 已完成：统一连接表、通用 provider/transport schema、事件 registry、统一连接管理 API、浏览器 adapter registry、通用 tracking instruction 响应。
- 已清理：旧 Meta 站点设置键、`channel`、`meta_connection_revision`、`pixelEvents`、旧投递数据和旧投递日聚合。
- 保留：Meta adapter、Queue、secure outbox、incident、Dataset Quality 和 live challenge。这些是当前 Meta 实现，不是兼容层。
- 已完成：TikTok Browser Pixel、统一连接配置和浏览器投递账本。
- 下一阶段：TikTok Events API、独立凭证、Queue/DLQ、连接验证和 rollout。
