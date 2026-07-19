# API 与实时通信契约

版本：1.1

日期：2026-07-20
状态：`[目标设计]`

## 1. 契约原则

- Android、iOS、Windows 和 macOS 用户客户端只使用 `/api/v2` 和 `/realtime/v1`，不直接调用现有 v1 图库接口。
- 对外 JSON 使用 `camelCase`，数据库字段命名不构成公开契约。
- 所有时间为 UTC ISO 8601，所有金额为最小货币单位整数，金币为整数。
- 所有写请求支持或强制 `Idempotency-Key`；支付、礼物、消息和匹配接口强制使用。
- 客户端不传可信角色、会员 rank、余额、认证结论或审核状态。
- API 采用向后兼容扩展；删除字段或改变语义必须升级主版本。

## 2. 传输与鉴权

### 2.1 HTTP

- 只允许 HTTPS。
- 用户客户端使用 `Authorization: Bearer <access-token>`。
- access token 短期有效，refresh token 轮换并保存在 Keychain/Keystore/OS credential store。
- 请求包含 `X-Client-Platform`、`X-Client-Version`、`X-Request-Id`。
- `X-Client-Platform` 使用受控枚举：`android`、`ios`、`windows`、`macos`、`linux` 或 `web`；服务端不信任该值进行身份授权。
- 服务端按最低受支持客户端版本返回强制升级或建议升级信息。

### 2.2 WebSocket

- 客户端先通过 HTTPS 获取一次性、短期 `realtimeTicket`。
- WebSocket 握手只携带 ticket，不把长期 access token 放在 URL。
- ticket 绑定 `accountId`、`deviceId`、audience、过期时间和允许加入的 conversation。
- 断线重连重新获取 ticket，并携带每个会话最后确认序号补拉。

## 3. 标准响应

成功响应：

```json
{
  "data": {},
  "meta": {
    "requestId": "req_01...",
    "serverTime": "2026-07-19T08:00:00Z"
  }
}
```

错误响应：

```json
{
  "error": {
    "code": "PROFILE_NOT_APPROVED",
    "message": "资料通过审核后才能发送招呼",
    "fieldErrors": [],
    "retryable": false
  },
  "meta": {
    "requestId": "req_01...",
    "serverTime": "2026-07-19T08:00:00Z"
  }
}
```

客户端展示 `message`，业务分支使用稳定 `code`，不得解析文案。

## 4. 通用语义

### 4.1 分页

- 列表使用 opaque cursor，不使用页码作为长期契约。
- 请求：`?limit=20&cursor=<opaque>`，`limit` 最大值由端点定义。
- 响应：`pageInfo.nextCursor` 和 `pageInfo.hasMore`。
- cursor 绑定查询条件；修改筛选条件后必须从头请求。

### 4.2 幂等

- 同一账号、端点和 `Idempotency-Key` 在保留窗口内只执行一次。
- 相同 key、不同请求摘要返回 `409 IDEMPOTENCY_KEY_REUSED`。
- 重复请求返回原业务结果，并在 meta 中标记 `idempotentReplay=true`。

### 4.3 乐观并发

- 可编辑资源返回 `version` 和 `ETag`。
- 更新使用 `If-Match`；版本冲突返回 `409 VERSION_CONFLICT` 和最新摘要。
- 审核决定、账本和消息不允许普通覆盖更新。

### 4.4 隐私过滤

任何 Profile DTO 必须按查看者上下文构建：

- 自己可见私密设置，不返回身份凭证明文。
- 匹配用户可见匹配层字段。
- 陌生用户只见公开字段和模糊位置。
- 被拉黑、封禁或不可发现时返回统一不可用结果，避免枚举状态。

## 5. API 清单

### 5.1 认证与账号

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/auth/phone/challenges` | 发送短信验证码；高风险时要求 Turnstile token |
| POST | `/api/v2/auth/phone/verify` | 验证验证码并创建/读取账号 |
| POST | `/api/v2/auth/legacy/link` | 使用旧账号证明绑定 legacy 用户 |
| POST | `/api/v2/auth/refresh` | 轮换 refresh token |
| POST | `/api/v2/auth/logout` | 撤销当前设备 session |
| POST | `/api/v2/auth/logout-all` | 撤销全部 App session |
| GET | `/api/v2/me` | 当前账号、激活状态、权益和待完成步骤 |
| GET | `/api/v2/me/devices` | 登录设备列表 |
| DELETE | `/api/v2/me/devices/:deviceId` | 撤销指定设备 |

### 5.2 同意、身份与数据权利

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/legal/documents/current` | 当前条款、隐私和社区规则版本 |
| POST | `/api/v2/me/consents` | 记录或更新某一处理目的同意 |
| POST | `/api/v2/me/verifications` | 发起年龄/身份核验 |
| GET | `/api/v2/me/verifications` | 查看核验状态和过期时间 |
| POST | `/api/v2/me/data-exports` | 创建个人数据导出 Workflow |
| GET | `/api/v2/me/data-exports/:id` | 查询导出状态并获取短期下载凭证 |
| POST | `/api/v2/me/deletion-requests` | App 内发起注销和删除 |
| GET | `/api/v2/me/deletion-requests/:id` | 查询注销进度 |
| POST | `/api/v2/me/deletion-requests/:id/cancel` | 在允许的冷静期内取消 |

### 5.3 资料与媒体

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/me/profile` | 查看自己的线上版本、草稿和审核状态 |
| PUT | `/api/v2/me/profile/draft` | 保存资料草稿 |
| POST | `/api/v2/me/profile/submit` | 提交资料版本审核 |
| POST | `/api/v2/me/profile/media/uploads` | 创建私有 R2 直传凭证或 Worker 上传会话 |
| POST | `/api/v2/me/profile/media/:id/complete` | 完成上传并进入扫描/审核 |
| DELETE | `/api/v2/me/profile/media/:id` | 删除媒体并撤销变体 |
| GET | `/api/v2/profiles/:profileId` | 按查看者权限获取资料 |
| POST | `/api/v2/me/profile/visibility` | 暂停发现、隐藏距离等 |

### 5.4 发现与互动

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/discovery/recommended` | 个性化或非个性化推荐 |
| GET | `/api/v2/discovery/nearby` | 城市与模糊距离段结果 |
| GET | `/api/v2/discovery/active` | 近期活跃结果 |
| GET | `/api/v2/discovery/explanation` | 当前推荐主要因素、版本和关闭入口 |
| PUT | `/api/v2/me/discovery-preferences` | 修改偏好和个性化开关 |
| POST | `/api/v2/profiles/:profileId/likes` | 喜欢；幂等 |
| POST | `/api/v2/profiles/:profileId/passes` | 跳过；幂等 |
| POST | `/api/v2/profiles/:profileId/greetings` | 发送受限招呼；幂等 |
| POST | `/api/v2/greetings/:id/accept` | 接受招呼并创建匹配 |
| POST | `/api/v2/greetings/:id/reject` | 拒绝招呼 |
| GET | `/api/v2/matches` | 匹配列表 |
| POST | `/api/v2/matches/:id/unmatch` | 解除匹配并关闭发送权限 |

### 5.5 会话与消息

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/conversations` | 会话投影列表 |
| POST | `/api/v2/conversations/:id/realtime-ticket` | 获取 WebSocket 一次性 ticket |
| GET | `/api/v2/conversations/:id/messages?afterSeq=` | 断线补拉历史 |
| POST | `/api/v2/conversations/:id/read` | 更新已读序号；单调递增 |
| POST | `/api/v2/conversations/:id/mute` | 静音设置 |
| POST | `/api/v2/conversations/:id/messages/:messageId/recall` | 撤回允许窗口内自己的消息 |

消息主发送路径走 WebSocket；HTTP 可提供同幂等语义的降级发送端点，但不能形成第二套消息规则。

### 5.6 安全

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/profiles/:profileId/block` | 立即拉黑 |
| DELETE | `/api/v2/profiles/:profileId/block` | 解除拉黑；不自动恢复匹配 |
| GET | `/api/v2/me/blocks` | 黑名单 |
| POST | `/api/v2/reports` | 举报资料、用户、消息或交易 |
| GET | `/api/v2/me/reports` | 举报状态列表 |
| POST | `/api/v2/moderation-decisions/:id/appeals` | 用户申诉 |
| GET | `/api/v2/safety/resources` | 安全说明、紧急帮助和官方联系方式 |

### 5.7 权益、金币和礼物

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/commerce/products` | 返回当前平台和地区可售商品 |
| POST | `/api/v2/commerce/store-transactions/verify` | 验证商店交易；幂等 |
| POST | `/api/v2/commerce/store-notifications` | 商店服务端通知；独立签名校验入口 |
| GET | `/api/v2/me/entitlements` | 当前有效权益与来源摘要 |
| GET | `/api/v2/me/wallet` | 可用余额、冻结余额和最近变动 |
| GET | `/api/v2/me/wallet/ledger` | 账本分页 |
| GET | `/api/v2/commerce/gifts` | 礼物目录和价格版本 |
| POST | `/api/v2/conversations/:id/gift-transactions` | 扣币并发送礼物；强幂等 |
| POST | `/api/v2/commerce/purchases/restore` | 恢复可恢复购买 |

## 6. 关键 DTO

### 6.1 发现资料卡

```json
{
  "id": "prf_01...",
  "displayName": "小鹿",
  "age": 24,
  "city": { "code": "CN-BJ", "name": "北京市" },
  "distanceBand": "2–5km",
  "activityStatus": "online",
  "occupation": "设计师",
  "badges": [
    { "type": "identityVerified", "label": "身份已核验" }
  ],
  "primaryMedia": {
    "id": "pmd_01...",
    "thumbnailUrl": "https://短期或公开变体域名/...",
    "blurHash": "..."
  },
  "interaction": {
    "canLike": true,
    "canGreet": true,
    "greetingsRemaining": 3
  },
  "reason": "同城且有 2 个共同兴趣"
}
```

不得返回：精确坐标、准确最后在线时间、身份材料、手机号、内部安全分、个人不可见标签。

### 6.2 会话消息

```json
{
  "id": "msg_01...",
  "conversationId": "cnv_01...",
  "clientMessageId": "device-generated-uuid",
  "seq": 128,
  "type": "text",
  "senderId": "acc_01...",
  "content": { "text": "周末有时间一起喝咖啡吗？" },
  "moderationState": "accepted",
  "createdAt": "2026-07-19T08:00:00Z",
  "recalledAt": null
}
```

## 7. WebSocket 事件

### 7.1 包络

```json
{
  "eventId": "evt_01...",
  "type": "message.send",
  "schemaVersion": 1,
  "conversationId": "cnv_01...",
  "sentAt": "2026-07-19T08:00:00Z",
  "payload": {}
}
```

### 7.2 客户端到服务端

| 事件 | 必填字段 | 说明 |
|------|----------|------|
| `connection.resume` | `lastSeenSeqByConversation` | 重连恢复 |
| `message.send` | `clientMessageId`, `type`, `content` | 发送消息，client ID 为幂等键 |
| `message.read` | `throughSeq` | 已读序号只能增加 |
| `typing.start` / `typing.stop` | 无 | 临时状态，不持久化，不触发推送 |
| `heartbeat` | `clientTime` | 维护连接，不用于公开精确在线时间 |

### 7.3 服务端到客户端

| 事件 | 说明 |
|------|------|
| `connection.ready` | 连接、账号和服务器时间已确认 |
| `message.ack` | 发送被接受，返回 server ID 与 seq |
| `message.created` | 新消息 |
| `message.updated` | 撤回或审核状态变化 |
| `message.read` | 对方已读到某序号 |
| `conversation.closed` | 拉黑、解除匹配、封禁或注销导致关闭 |
| `sync.required` | 序号缺口或投影落后，需要 HTTP 补拉 |
| `error` | 稳定错误码和是否可重试 |

## 8. 关键错误码

| HTTP | 错误码 | 客户端动作 |
|------|--------|------------|
| 400 | `VALIDATION_FAILED` | 就地展示字段错误 |
| 401 | `AUTH_REQUIRED` | 尝试刷新；失败后登录 |
| 401 | `SESSION_REVOKED` | 清除本地敏感缓存并登录 |
| 403 | `AGE_VERIFICATION_REQUIRED` | 导航到成年人核验 |
| 403 | `CONSENT_REQUIRED` | 展示缺失的具体同意项目 |
| 403 | `PROFILE_NOT_APPROVED` | 导航到审核状态 |
| 403 | `CONVERSATION_NOT_OPEN` | 禁用输入框并显示状态 |
| 403 | `SAFETY_RESTRICTION` | 不披露内部规则；提供申诉入口 |
| 409 | `VERSION_CONFLICT` | 合并或重新载入 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 生成新操作 key 后由用户确认重试 |
| 422 | `CONTENT_REJECTED` | 保留草稿并给出安全文案 |
| 429 | `RATE_LIMITED` | 使用 `Retry-After`，不循环请求 |
| 503 | `DEPENDENCY_UNAVAILABLE` | 告知稍后重试，不丢本地 outbox |
| 426 | `CLIENT_UPGRADE_REQUIRED` | 强制升级页 |

## 9. 速率限制设计

具体数字由压测与风控调整，契约至少区分：

- 验证码按手机号、设备、IP 和账号组合限制。
- 登录、refresh、身份核验和数据导出独立限制。
- 发现接口按账号和设备限制，并防止批量枚举。
- 喜欢、招呼、资料查看和消息发送按账号、会话及风险等级限制。
- 举报接口防刷但不得阻止真实高危举报，可进入降级人工渠道。
- 商店交易验证按账号、transaction ID 和平台限制。

返回 `Retry-After` 与通用错误，不向攻击者披露具体风险规则。

## 10. 契约测试

- OpenAPI、JSON Schema 和 WebSocket event schema 是跨语言唯一契约源；Kotlin/TypeScript 模型不得各自手工演进。
- schema 变更后必须在 KMP、Web 和 API CI 中生成或校验模型；生成差异未提交、枚举/可空性不一致或破坏兼容性时阻断合并。
- 每个错误码至少有一个契约测试。
- 幂等测试覆盖重复、并发和 key 复用不同 payload。
- WebSocket 测试覆盖乱序、重复、断线、补拉、休眠恢复和会话关闭。
- 对象权限测试覆盖本人、陌生人、匹配、被拉黑、管理员和越权 ID 枚举。
- 支付契约测试只使用 sandbox 签名样本，生产凭证不得进入测试仓库。
- 平台矩阵至少覆盖 Android、iOS、Windows 和 macOS 的 header、强制升级、token 刷新、WebSocket 重连与错误映射。
