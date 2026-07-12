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

旧 `channel` 与 `meta_connection_revision` 在兼容期保留；新代码不得使用它们判断平台业务语义。migration `0047_ad_platform_delivery_core.sql` 回填全部历史 Meta 数据，并将唯一约束收口到 `conversion_action_id + provider + transport`。

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

前端通过 provider registry 分发。兼容期继续返回 `pixelEvents`，现有调用方迁移完成后再单独删除旧字段。

## 连接管理

后台以“平台连接”为产品单位展示 destination ID、凭证状态、模式、验证状态、revision 和最近验证时间。destination ID 与 token 在 UI 中属于同一连接，但底层分级存储：

- destination / Pixel ID：可保存在 D1。
- Access Token：只保存在 production secret 或受控加密凭证存储中，禁止回显。
- 任一配置变化都会使 connection revision 失效并要求重新验证。

统一只读入口为 `GET /api/admin/attribution/platforms`。平台专属写操作继续放在各 adapter 路由中，直到通用命令契约完成。

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
6. 将 provider 加入统一后台连接列表和趋势查询。
7. 验证 Browser/Server 同 event ID 去重。
8. 通过独立 rollout 放量。

新增平台不得修改 `recordContact()`、`recordRegistration()` 或注册/联系页面的业务判断。

## 当前迁移状态

- 已完成：通用 provider/transport schema、历史 Meta 回填、事件 registry、统一连接状态 API、浏览器 adapter registry、通用 tracking instruction 响应。
- 兼容保留：Meta `channel`、`meta_connection_revision`、`pixelEvents` 和 Meta 专属运维表。
- 下一平台：TikTok Pixel + Events API，通过新 adapter 接入。
- 后续清理：所有调用方改用通用字段后，再通过独立 migration 删除兼容列，禁止在同一次平台接入中强删历史字段。
