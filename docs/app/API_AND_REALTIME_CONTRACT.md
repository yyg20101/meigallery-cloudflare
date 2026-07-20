# App API 与实时通信契约

App 版本：1.0

日期：2026-07-20

状态：需求讨论中

## 1. 契约原则

- HTTP 基础路径使用 `/api/v2`，旧 Web API 保持兼容直至迁移完成。
- OpenAPI、JSON Schema 和实时事件 schema 是 Kotlin/TypeScript 契约源。
- 对外 ID 为不可枚举字符串；不暴露 D1 自增 ID。
- 所有对象权限在服务端校验，客户端隐藏按钮不构成授权。
- 消息、订单、礼物、调币和关键互动强制幂等。
- 未知字段向前兼容，未知枚举使用 `unknown`/安全降级，不扩大权限。

### 1.1 App 1.0 启用范围

- 1.0 必须实现：账号、真人发现、单向互动、五级会员目录、entitlement、会话/文本消息、站内通知、钱包余额/明细、管理员会员发放和管理员调币。
- 仅保留未来契约：订单/商店验证、金币包、礼物、装扮、真人认领和系统推送。未立项前不部署生产路由，也不向 1.0 客户端下发可执行 capability。
- 路由表中的“未来”表示长期兼容设计，不属于 App 1.0 上线验收。详细边界见 [App 1.0 发布范围](../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md)。

## 2. 通用请求

建议请求头：

```text
Authorization: Bearer <session-token>
X-Client-Platform: android | ios | windows | macos | web
X-Client-Version: <semver/build>
X-Contract-Version: <schema-version>
X-Request-Id: <uuid>
Idempotency-Key: <unique-key>（关键写接口）
Accept-Language: zh-CN
```

会话 Token 只代表身份。服务端仍需读取账号状态、设备、角色、资格、会员和风险状态。

## 3. 通用响应与错误

成功：

```json
{
  "data": {},
  "meta": {
    "requestId": "req_xxx",
    "contractVersion": "2.0"
  }
}
```

失败：

```json
{
  "error": {
    "code": "ENTITLEMENT_REQUIRED",
    "message": "开通心享会员后可创建真人私信",
    "details": {
      "requiredEntitlement": "direct_message.create",
      "operationMode": "platform_managed"
    },
    "retryable": false
  },
  "meta": {
    "requestId": "req_xxx"
  }
}
```

稳定错误码至少包括：

| 错误码 | HTTP | 说明 |
|--------|------|------|
| `AUTH_REQUIRED` | 401 | 未登录或会话失效 |
| `ACCOUNT_RESTRICTED` | 403 | 账号/资格/安全受限 |
| `ENTITLEMENT_REQUIRED` | 403 | 缺少会员权限 |
| `ENTITLEMENT_QUOTA_EXCEEDED` | 429 | 周期额度不足 |
| `PROFILE_NOT_AVAILABLE` | 404/410 | 真人资料未发布、暂停或归档 |
| `CONVERSATION_FORBIDDEN` | 403 | 非参与方或已拉黑/关闭 |
| `CONTENT_REVIEW_PENDING` | 202/409 | 内容需审核 |
| `INSUFFICIENT_COINS` | 409 | 金币不足 |
| `PRODUCT_NOT_AVAILABLE` | 409 | 商品下架/地区/版本不可用 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同一键对应不同请求 |
| `APP_UPGRADE_REQUIRED` | 426 | 能力需要更高客户端版本 |
| `RATE_LIMITED` | 429 | 频控，返回安全的重试时间 |
| `PRIVACY_REQUEST_IN_PROGRESS` | 409 | 已有相同数据权利任务在处理 |
| `TAXONOMY_VERSION_CONFLICT` | 409 | 目录或引用版本已变化 |
| `MODERATION_RESTRICTED` | 403 | 账号、内容或会话受安全限制 |

错误文案由客户端本地化或服务端文案键渲染，不能暴露内部表名、策略阈值或操作员隐私。

## 4. 分页与缓存

- 列表采用游标分页：`cursor`、`limit`，服务端返回 `nextCursor`。
- 推荐游标绑定排序规则版本，规则切换时返回新会话或 `CURSOR_EXPIRED`。
- 公共投影支持 `ETag`；账号、会员、消息、余额和订单响应禁止共享缓存。
- 时间为 UTC ISO 8601，客户端按地区展示。

## 5. 身份与账号 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/auth/register` | 创建观看者账号 |
| POST | `/api/v2/auth/login` | 登录与风险验证 |
| POST | `/api/v2/auth/refresh` | 刷新会话 |
| POST | `/api/v2/auth/logout` | 当前设备退出 |
| GET | `/api/v2/me` | 账号、角色、会员摘要和配置版本 |
| PATCH | `/api/v2/me` | 修改仅用于账号识别的昵称、头像等允许字段 |
| GET | `/api/v2/me/devices` | 设备列表 |
| DELETE | `/api/v2/me/devices/:deviceId` | 远程退出设备 |
| GET/PUT | `/api/v2/me/preferences` | 地区、偏好、推荐和隐私设置 |
| GET | `/api/v2/me/blocks` | 本人拉黑名单 |
| POST | `/api/v2/me/data-exports` | 创建数据导出 Workflow |
| GET | `/api/v2/me/data-exports/:requestId` | 查询导出状态 |
| POST | `/api/v2/me/data-exports/:requestId/download-ticket` | 再次验证后签发短期下载凭证 |
| POST | `/api/v2/me/deletion-requests` | 创建注销 Workflow |
| GET | `/api/v2/me/deletion-requests/:requestId` | 查询注销状态 |
| DELETE | `/api/v2/me/deletion-requests/:requestId` | 在允许阶段取消注销 |

注册响应不得返回 `personId` 或 `profileId`，除非该账号以后通过独立认领流程绑定真人。

## 6. 真人发现 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/discovery/feed` | 个性化或非个性化推荐 |
| GET | `/api/v2/discovery/regions` | 地区目录和模糊范围 |
| GET | `/api/v2/discovery/popular` | 热门资料 |
| GET | `/api/v2/discovery/latest` | 最新发布 |
| GET | `/api/v2/discovery/categories` | 标签/分类入口 |
| GET | `/api/v2/person-profiles` | 搜索和筛选 |
| GET | `/api/v2/person-profiles/:profileId` | 真人公开详情 |
| POST | `/api/v2/person-profiles/:profileId/media-access` | 受保护媒体短期凭证 |

推荐项关键字段：

```json
{
  "profileId": "pp_xxx",
  "personId": "per_xxx",
  "displayName": "示例展示名",
  "verification": {
    "status": "verified",
    "label": "真人资料已认证"
  },
  "operation": {
    "mode": "platform_managed",
    "label": "消息由平台运营接收"
  },
  "region": { "label": "北京市", "precision": "city" },
  "tags": [],
  "recommendation": {
    "mode": "personalized",
    "reasonCode": "PREFERRED_STYLE",
    "ruleVersion": "rec_2026_07_01"
  }
}
```

公开 API 只从已认证且已发布投影读取。客户端不得依赖字段缺失自行判断状态。

## 7. 单向互动 API

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT/DELETE | `/api/v2/person-profiles/:profileId/like` | 喜欢/取消喜欢 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/follow` | 关注/取消关注 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/favorite` | 收藏/取消收藏 |
| GET | `/api/v2/me/likes` | 喜欢列表 |
| GET | `/api/v2/me/follows` | 关注和更新 |
| GET | `/api/v2/me/favorites` | 收藏列表 |
| GET/POST/PATCH/DELETE | `/api/v2/me/favorite-folders[/:id]` | 收藏夹 |
| GET/DELETE | `/api/v2/me/view-history` | 历史查询/全部清除 |
| DELETE | `/api/v2/me/view-history/:profileId` | 删除单条历史 |
| GET/DELETE | `/api/v2/me/search-history` | 搜索历史查询/全部清除 |
| DELETE | `/api/v2/me/search-history/:historyId` | 删除单条搜索历史 |

这些接口不返回 reciprocal/matched 等字段，也不创建会话。

## 8. 会员和目录 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/catalog/memberships` | 五级会员目录、获取方式和已启用 entitlement |
| GET | `/api/v2/me/entitlements` | 已解析权限快照 |
| POST | `/api/v2/orders` | 未来：创建购买意图 |
| POST | `/api/v2/orders/verify` | 未来：提交商店交易供服务端验证 |
| POST | `/api/v2/orders/restore` | 未来：恢复购买 |
| GET | `/api/v2/me/orders` | 未来：订单列表 |
| GET | `/api/v2/me/orders/:orderId` | 未来：订单详情 |

entitlement 响应包含目录版本、来源、值、有效期和最低客户端版本。客户端可缓存展示，但受限 API 每次服务端重验。

## 9. 会话与消息 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/conversations` | 按真人资料创建/复用私信；强制幂等 |
| GET | `/api/v2/conversations` | 当前账号会话列表 |
| GET | `/api/v2/conversations/:id` | 会话、接收主体和状态 |
| GET | `/api/v2/conversations/:id/messages` | 按 sequence 补拉消息 |
| POST | `/api/v2/conversations/:id/messages` | HTTP 发送兜底 |
| POST | `/api/v2/conversations/:id/read` | 实际接收方已读到 sequence |
| POST | `/api/v2/conversations/:id/mute` | 静音/取消静音 |
| POST | `/api/v2/conversations/:id/close` | 用户关闭会话 |
| POST | `/api/v2/conversations/:id/handover-consent` | 历史交接选择（M3） |

创建请求：

```json
{
  "profileId": "pp_xxx",
  "clientCapabilityVersion": "2.0"
}
```

App 1.0 的用户消息 payload 只允许 `text` 和 `emoji`；`system` 只能由服务端生成。图片、语音、视频、文件和位置消息必须同时满足服务端 capability 与最低客户端版本后才能接收。

创建响应必须包含：

```json
{
  "conversationId": "cv_xxx",
  "operationMode": "platform_managed",
  "receiverLabel": "平台运营接收",
  "disclosureVersion": "managed_message_1",
  "quota": { "remaining": 2, "resetsAt": "2026-07-21T00:00:00Z" }
}
```

## 10. 实时通道

连接过程：HTTP 获取短期 WebSocket ticket → 连接会话 Durable Object → `hello` 携带最后确认 sequence → 服务端补发缺失事件。

通用事件：

```json
{
  "eventId": "evt_xxx",
  "eventType": "message.created",
  "schemaVersion": 1,
  "conversationId": "cv_xxx",
  "sequence": 42,
  "occurredAt": "2026-07-20T12:00:00Z",
  "payload": {}
}
```

| 事件 | 说明 |
|------|------|
| `conversation.snapshot` | 当前状态、运营模式、接收主体和 sequence |
| `message.created` | 新消息，含 `senderType: viewer/platform_operator/person/system` |
| `message.status_changed` | 审核、送达、失败、撤回状态 |
| `receipt.read` | 当前实际接收主体已读到某 sequence |
| `operation_mode.changed` | 平台运营/本人运营切换，必须落系统消息 |
| `conversation.restricted` | 拉黑、暂停、安全限制或关闭 |
| `entitlement.changed` | 会员变化提示客户端刷新 HTTP 快照 |
| `notification.created` | 新站内通知，提示客户端刷新通知列表/未读数 |

不为平台代运营会话发送 `person.typing`、`person.online` 或 `person.read` 事件。输入状态仅在真实发送主体主动产生且策略允许时短期发送，不持久化。

## 11. 站内通知 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/notifications` | 按消息、互动、会员/金币、系统/安全分类分页查询 |
| GET | `/api/v2/notifications/unread-counts` | 各分类未读数 |
| POST | `/api/v2/notifications/:id/read` | 标记单条已读，幂等 |
| POST | `/api/v2/notifications/read-all` | 按分类标记全部已读，幂等 |
| GET/PUT | `/api/v2/me/notification-preferences` | 站内通知偏好；交易/安全必要通知不可关闭 |

App 1.0 通过 HTTP 拉取和已连接实时通道刷新站内通知，不依赖 APNs、FCM 或其他系统推送。

## 12. 钱包、礼物与装扮 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/me/wallet` | 余额和最后同步时间 |
| GET | `/api/v2/me/wallet/entries` | 金币明细 |
| GET | `/api/v2/catalog/coin-packs` | 未来：金币包 |
| GET | `/api/v2/catalog/gifts` | 未来：礼物目录 |
| POST | `/api/v2/gifts` | 未来：赠礼并原子扣币；强制幂等 |
| GET | `/api/v2/me/gifts` | 未来：赠礼历史 |
| GET | `/api/v2/catalog/cosmetics` | 未来：装扮目录 |
| GET | `/api/v2/me/cosmetics` | 未来：库存和装备状态 |
| POST | `/api/v2/cosmetics/:productId/purchase` | 未来：金币购买 |
| PUT/DELETE | `/api/v2/me/cosmetics/:inventoryId/equip` | 未来：装备/卸下 |

赠礼返回订单/业务记录、钱包分录和权威余额。客户端不得先行扣减余额。

## 13. 举报、拉黑与支持 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/reports` | 举报真人、媒体、会话或消息 |
| GET | `/api/v2/me/reports` | 举报状态 |
| GET | `/api/v2/me/reports/:reportId` | 举报必要详情与用户可见时间线 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/block` | 拉黑/解除拉黑 |
| GET | `/api/v2/help/topics` | 帮助与政策 |
| POST | `/api/v2/appeals` | 申诉 |

拉黑后禁止新会话和消息，并停止目标推荐；解除拉黑不自动重开已关闭会话。

## 14. 管理 API

管理路由使用 `/api/v2/admin`，强认证、RBAC、对象范围和审计必需。

| 资源 | 主要能力 |
|------|----------|
| `/persons`, `/person-profiles` | 创建、编辑、来源、授权和状态 |
| `/verifications`, `/publications` | 认证、发布、暂停、归档 |
| `/imports` | MeiGallery/批量导入任务 |
| `/taxonomy`, `/taxonomy-catalogs` | 标签/地区/分类、alias、映射、合并和版本发布 |
| `/recommendation-rules`, `/editorial-placements` | 规则版本、dry-run、精选、灰度、暂停和回滚 |
| `/operation-assignments` | 真人运营模式和管理员组 |
| `/managed-conversations` | 队列、分配、平台回复和内部备注 |
| `/reviews`, `/reports`, `/appeals` | 举报案件、最小证据、审核、安全处置和申诉 |
| `/membership-catalogs`, `/membership-grants` | 1.0 五级权益、手动发放、撤销和有效期 |
| `/products` | 未来：价格和商品版本 |
| `/coin-adjustments` | 加币、扣币、批量任务、复核和冲正 |
| `/orders`, `/reconciliation` | 未来：订单、退款和对账 |
| `/claims`, `/handovers` | 未来：真人认领和交接 |
| `/audit-events` | 只读审计查询 |

管理员消息接口必须由服务端写入 `senderType=platform_operator`；客户端不能传入 `person` 冒充真人。

## 15. 幂等与并发

- `Idempotency-Key` 与账号、路由和规范化请求哈希绑定。
- 同键同请求返回首个权威结果；同键不同请求返回 `IDEMPOTENCY_CONFLICT`。
- 创建会话按观看者 + 真人建立唯一有效关系。
- 消息按会话 + clientMessageId 唯一。
- 外部交易 ID、钱包业务单号、礼物业务单号和调币申请唯一。
- 状态更新使用版本号/ETag 防止管理员并发覆盖。

## 16. 契约与安全测试

- OpenAPI lint、破坏性变更检测和 Kotlin/TypeScript 生成代码编译。
- 对象权限矩阵覆盖本人、其他观看者、未认领/已认领真人、代运营、审核、财务和越权 ID。
- 幂等、乱序、重复回调、断线补拉、DO 休眠和多设备已读测试。
- 资料暂停、会员到期、拉黑和运营模式切换的实时撤权测试。
- 个性化关闭、历史清除、taxonomy 合并、规则回滚和数据导出/注销的跨设备一致性测试。
- 举报证据最小化、审核越权、拉黑联动、申诉改判和高危 fail-closed 测试。
- 日志/分析事件扫描私信、证件、凭证和令牌泄漏。

## 17. 契约验收

- **API-AC-001**：公开接口无法返回未认证或未发布真人。
- **API-AC-002**：普通账号响应不包含自动生成的公开资料。
- **API-AC-003**：无 entitlement 创建私信返回明确错误且不消耗额度。
- **API-AC-004**：平台运营消息不能伪装为 `senderType=person`。
- **API-AC-005**：App 1.0 重复会员发放、消息和调币请求不产生重复结果；订单和礼物在未来启用时遵循同一规则。
- **API-AC-006**：资料暂停、会员到期或拉黑后，现有实时连接立即失去相关写权限。
- **API-AC-007**：未知 schema 字段不会使旧客户端扩大权限或崩溃。
- **API-AC-008**：管理写接口均能关联完整审计事件。
