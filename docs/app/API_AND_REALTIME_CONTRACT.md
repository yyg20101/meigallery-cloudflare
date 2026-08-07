# App API 与实时通信契约

App 版本：1.0

日期：2026-08-07

状态：整体需求讨论中；M0 公共发现已冻结，M1、Auth-1、Interaction-1、Membership-1、Message-1、Message-2 与 Safety-2 进入默认关闭的保守开发验证

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

### 1.2 M0 局部冻结记录

本轮只冻结并实现以下开发联调边界，唯一 HTTP 事实源为 [`contracts/app-api-v2.openapi.yaml`](../../contracts/app-api-v2.openapi.yaml)：

- `GET /api/v2/app/bootstrap`：返回真实可用 capability；未启用的登录以及未实现的消息、支付和系统推送必须为 `false`。
- `GET /api/v2/discovery/feed`：支持 `recommended`、`popular`、`latest` 三种稳定排序、地区筛选和不透明游标。
- `GET /api/v2/discovery/regions`：只统计当前具有公开资格的人物。
- `GET /api/v2/person-profiles/:profileId`：返回同一公开资格边界下的基础详情投影。
- 四个 M0 响应统一返回 `Cache-Control: no-store`，避免资格撤回、授权到期或源图库下线后被中间缓存继续展示；后续只有在完成可撤销缓存设计后才能调整。

账号体系不属于 M0 冻结范围；Auth-1 只以默认关闭的开发基线独立推进。真人认领、通知、钱包和媒体访问仍按开放问题与专业门禁逐项冻结。M0 migration 只创建空的可重建读投影，不自动迁移或公开任何现有图库，也不代表允许直接部署生产。

### 1.3 M1 人物供给开发边界

M1 在现有 Web 管理员会话域内使用 `/api/admin/app/persons`，先验证候选、用途授权、认证、发布和暂停的完整后台闭环。该前缀是当前 Nuxt 后台的受保护管理接口，不是 KMP 客户端公开契约；未来若统一为 `/api/v2/admin`，必须通过服务层复用或兼容适配迁移，不能形成第二套人物事实表或第二条投影链路。

M1 管理命令全部要求 `expectedVersion`，认证和授权绑定具体 `contentVersion`。发布决定再次校验全门禁后才写入公开投影；授权/认证撤销与人工暂停立即下线。当前不导入真实人物或证据，不执行 production migration，认证正式声明和职责分离仍是生产门禁。

### 1.4 Membership-1 局部冻结记录

Membership-1 以兼容新增方式把契约提升为 `1.4.0`，只冻结并实现以下最小边界：

- `GET /api/v2/membership/catalog`：公开读取当前明确配置的五级目录和 typed entitlement。
- `GET /api/v2/me/entitlements`：使用 App Bearer 会话读取本人最高有效 App grant 与权威快照。
- bootstrap 增加 `membership.catalog`、`membership.entitlements` 和 `membership.applications`；本阶段申请能力固定为 `false`。
- Nuxt 后台暂时复用受保护的 `/api/admin/app/memberships`，覆盖目录、账号状态、低风险预览/发放/续期和追加式撤销。

当前五级数值全部是 `development + planned`，不构成正式额度承诺或可执行业务权限。`user_memberships` 的旧 `vip/svip` 不进入 App 权益解析。用户申请、高风险双人复核、批量操作、额度消耗和迁移仍未冻结为实现契约。

### 1.5 Message-1 局部冻结记录

Message-1 以兼容新增方式把累计契约提升为 `1.5.0`，只冻结并实现默认关闭的最小平台话题边界：

- 用户侧实现创建/复用、会话列表、详情、sequence 补拉、文本发送和已读；传输固定为 `http_pull`，不包含实时通道或系统推送。
- bootstrap 增加 `capabilities.messaging` 以及受校验的 `receiverLabel`、`disclosureVersion`、`disclosureText`、`transport` 和 `maxTextLength`。字段缺失、矛盾或未知时客户端必须关闭入口。
- 只有精确配置到 Message-1 开发目录且三项消息 entitlement 为 `available` 时才能通过服务端校验；等级名称不参与授权，日额度按上海自然日原子消耗。
- 未认领真人仅允许 `platform_managed`。平台接收披露必须出现在人物详情确认、会话列表、会话顶部和系统消息中；运营回复只能标记为 `platform_operator`。
- Nuxt 暂时使用 `/api/admin/app/conversations` 队列处理消息；正文访问声明 `service_operation` 并审计，审计和通用日志不得复制正文。
- 实时消息、媒体、撤回、静音、关闭、举报/拉黑、多操作员分配、本人运营及历史交接均保留在完整产品需求中，不属于 Message-1 已实现契约。

Message-1 的 production/dev 用户与后台开关、production-ready 门禁均保持关闭，现有环境目录也未切换到新开发目录。migration 和代码存在不表示可以部署或开放生产能力。

### 1.6 Message-2 局部冻结记录

Message-2 以兼容新增方式把累计契约提升为 `1.6.0`，冻结并实现以下默认关闭边界：

- bootstrap 增加分项 `capabilities.safety.reports|blocks|conversationClose`、版本化原因目录、最大说明长度和四种预声明目标；非法或矛盾配置必须使客户端安全关闭对应入口。
- 登录发现请求可以携带 Bearer token，由服务端排除当前账号已屏蔽人物；匿名发现保持可用，无效 token 返回 401，不能静默降级为匿名结果。
- 用户可读取/变更人物屏蔽状态，分页读取当前屏蔽列表，举报人物、媒体、本人话题或本人消息，读取本人举报列表/必要时间线，并主动关闭本人话题。
- 屏蔽、举报与关闭写操作均要求独立幂等键；屏蔽联动清理喜欢/关注并关闭旧话题，解除不恢复历史关系或话题。
- 管理后台为过渡实现：会话正文要求限时 assignment；举报领取后才允许读取最小证据；运行控制可暂停新建、观看者发送或运营发送，并设置容量和租约。
- `0073` 保留策略仍为 `unresolved`，自动清理关闭；production/dev safety 开关和 production-ready 均保持 false。申诉、改判、用户上传证据、系统通知和实时通道不属于本切片。

完整实现与生产门禁见 [Message-2 跨仓集成边界](./MESSAGE_2_CROSS_REPO_INTEGRATION.md)。

### 1.7 Safety-2 局部冻结记录

Safety-2 以兼容新增方式把累计契约提升为 `1.7.0`，只冻结举报“未发现违规”结论的独立复核：

- bootstrap 增加 `capabilities.safety.appeals`、`appealPolicyVersion` 与 `maxAppealStatementLength`；用户端、后台端和 production-ready 开关相互独立且当前全部关闭。
- 举报摘要增加单调 `version`，详情增加服务端权威申诉资格、不可用原因、既有申诉 ID 与状态。客户端不得本地推导申请窗口。
- `POST /api/v2/appeals` 只接受 `report_no_violation_review` 的举报 ID、预期举报版本和 1–500 字说明；同一举报结论版本只允许一个申诉，不接受文件证据。
- `GET /api/v2/me/appeals` 与 `GET /api/v2/me/appeals/:appealId` 只返回本人记录和用户可见时间线。
- 复核必须由不同于原审核人的管理员领取。`upheld` 维持原结论；`changed` 只把原举报重开为调查中，不自动认定违规或执行处置。

完整实现与生产门禁见 [Safety-2 跨仓集成边界](./SAFETY_2_APPEAL_INTEGRATION.md)。

## 2. 通用请求

建议请求头：

```text
Authorization: Bearer <session-token>
X-Client-Platform: android | ios | windows | macos | web
X-Client-Version: <semver>
X-Client-Build: <build-number>
X-Contract-Version: <contract-version>
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
    "serverTime": "2026-08-02T00:00:00.000Z",
    "apiVersion": "2",
    "contractVersion": "1.7.0"
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
| `INVALID_DISCOVERY_SORT` | 400 | 发现页排序值不受支持 |
| `INVALID_REGION` | 400 | 地区 code 格式不合法 |
| `INVALID_CURSOR` | 400 | 游标损坏或与当前排序、地区、规则版本不匹配 |
| `CONVERSATION_FORBIDDEN` | 403 | 非参与方或已拉黑/关闭 |
| `FEATURE_DISABLED` | 403 | 对应开发能力未由服务端开放 |
| `REPORT_TARGET_NOT_FOUND` | 404 | 举报目标不存在或不属于当前账号范围 |
| `REPORT_RATE_LIMITED` | 429 | 举报提交超过服务端频控 |
| `BLOCK_STATE_CONFLICT` | 409 | 屏蔽状态发生并发变化 |
| `CONVERSATION_CLOSE_CONFLICT` | 409 | 话题关闭发生并发变化 |
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
| POST | `/api/v2/auth/email-challenges` | Auth-1 已实现：统一响应的注册邮箱验证码申请 |
| POST | `/api/v2/auth/register` | Auth-1 已实现：创建观看者账号、同意、设备和 App 会话 |
| POST | `/api/v2/auth/login` | Auth-1 已实现：邮箱密码登录、风险挑战与当前同意校验 |
| POST | `/api/v2/auth/refresh` | Auth-1 已实现：旋转 Access/Refresh Token，检测旧 Refresh Token 重放 |
| POST | `/api/v2/auth/logout` | Auth-1 已实现：撤销当前 App 会话 |
| GET | `/api/v2/me` | Auth-1 已实现：账号、角色、会员摘要和当前设备 |
| PATCH | `/api/v2/me` | 修改仅用于账号识别的昵称、头像等允许字段 |
| GET | `/api/v2/me/devices` | Auth-1 已实现：本人设备和登录状态列表 |
| DELETE | `/api/v2/me/devices/:deviceId` | Auth-1 已实现：幂等远程退出其他设备 |
| GET/PUT | `/api/v2/me/preferences` | 地区、偏好、推荐和隐私设置 |
| GET | `/api/v2/me/blocks` | 本人拉黑名单 |
| POST | `/api/v2/me/data-exports` | 创建数据导出 Workflow |
| GET | `/api/v2/me/data-exports/:requestId` | 查询导出状态 |
| POST | `/api/v2/me/data-exports/:requestId/download-ticket` | 再次验证后签发短期下载凭证 |
| POST | `/api/v2/me/deletion-requests` | 创建注销 Workflow |
| GET | `/api/v2/me/deletion-requests/:requestId` | 查询注销状态 |
| DELETE | `/api/v2/me/deletion-requests/:requestId` | 在允许阶段取消注销 |

注册响应不得返回 `personId` 或 `profileId`，除非该账号以后通过独立认领流程绑定真人。

Auth-1 当前是默认关闭的开发基线：`APP_AUTH_ENABLED`、注册开关、四类文档版本、四个可阅读正文 URL 和 production Turnstile 必须同时满足，bootstrap 才返回 `auth=true`。`challenge.type=turnstile` 时同时返回固定 `pagePath`/`resultPath`，三类业务动作使用不同 action 且 token 单次使用。本阶段只启用邮箱身份，不写死年龄或地区，不开放手机号/第三方登录。现有 `users` 是唯一账号主体；旧 Web 账号只有在密码校验成功后才生成 App 身份映射，不按邮箱静默合并。

Access Token 为短期不透明凭证，Refresh Token 旋转使用；两者在 D1 只保存 SHA-256 摘要。每次授权校验账号、设备、App session version、状态、有效期和当前文档同意。成功刷新会替换当前 Access/Refresh Token，使旧 Access Token 立即失效；旧 Refresh Token 重放将撤销该会话并写安全事件。客户端必须串行刷新并把两种 Token 仅存入 Keystore/Keychain。

## 6. 真人发现 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/app/bootstrap` | M0 已实现：能力与发现配置 |
| GET | `/api/v2/discovery/feed` | M0 已实现：规则推荐、热门、最新、地区筛选和游标分页；Message-2 登录请求排除本人已屏蔽人物 |
| GET | `/api/v2/discovery/regions` | M0 已实现：当前可用地区目录 |
| GET | `/api/v2/discovery/popular` | 后续兼容别名；M0 使用 `feed?sort=popular` |
| GET | `/api/v2/discovery/latest` | 后续兼容别名；M0 使用 `feed?sort=latest` |
| GET | `/api/v2/discovery/categories` | 待标签目录冻结后实现 |
| GET | `/api/v2/person-profiles` | 待搜索与筛选契约冻结后实现 |
| GET | `/api/v2/person-profiles/:profileId` | M0 已实现：公开基础详情投影 |
| POST | `/api/v2/person-profiles/:profileId/media-access` | 待媒体授权契约冻结后实现 |

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
  "region": { "code": "cn-bj", "label": "北京市", "precision": "city" },
  "tags": [],
  "recommendation": {
    "mode": "rule_based",
    "reasonCode": "PREFERRED_STYLE",
    "ruleVersion": "discovery_v1"
  }
}
```

公开 API 只读取 `verified + published + authorization active/started/unexpired + verification unexpired + visible` 且来源图库仍发布的投影。客户端不得依赖字段缺失自行判断状态；现有图库没有管理员明确创建的合格投影时，列表必须为空。

## 7. 单向互动 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/person-profiles/:profileId/interactions` | Interaction-1：本人喜欢/关注权威状态 |
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

Interaction-1 契约版本为 `1.3.0`，只实现状态查询、喜欢/关注写入和本人喜欢/关注列表。新增关系必须重新校验资料当前公开资格；取消关系不依赖资料仍公开。列表中失效资料只返回 `profileId`、关系时间和 `PROFILE_NOT_AVAILABLE`，不返回历史公开内容。

收藏/收藏夹、浏览历史、关注更新事件和推荐信号仍未冻结，现阶段不得以扁平收藏关系替代。所有互动接口不返回 reciprocal/matched 等字段，不创建会话，也不向目标真人或运营人员发送具体观看者通知。

## 8. 会员和目录 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/membership/catalog` | Membership-1 已实现：五级开发目录、获取方式与 typed entitlement |
| GET | `/api/v2/me/entitlements` | Membership-1 已实现：当前 App grant、等级、有效区间和已解析权益 |
| GET | `/api/v2/me/membership` | 后续：独立会员时间线；当前 `/me/entitlements` 已返回当前 grant 摘要 |
| POST | `/api/v2/orders` | 未来：创建购买意图 |
| POST | `/api/v2/orders/verify` | 未来：提交商店交易供服务端验证 |
| POST | `/api/v2/orders/restore` | 未来：恢复购买 |
| GET | `/api/v2/me/orders` | 未来：订单列表 |
| GET | `/api/v2/me/orders/:orderId` | 未来：订单详情 |

Membership-1 原始目录 `amc_app_1_0_draft_1` 的七项权益全部为 `planned` 且 `executable=false`。Message-1 新建独立 `development` 目录，只把创建、发送和每日新话题额度三项改为 `available`，其余权益继续为 `planned`；Message-2 再复制为独立开发目录以冻结安全运营切片，但当前环境仍不切换目录。客户端目录快照只用于展示，受限 API 每次仍由服务端重验当前 grant、稳定 entitlement key、有效期和额度。等级中文名不参与授权，App 1.0 当前不部署订单写路由或购买 capability。

## 9. 会话与消息 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v2/conversations` | Message-1 已实现：按真人资料幂等创建/复用平台话题并原子消耗额度 |
| GET | `/api/v2/conversations` | Message-1 已实现：当前账号会话列表 |
| GET | `/api/v2/conversations/:id` | Message-1 已实现：会话、接收主体和当前可发送状态 |
| GET | `/api/v2/conversations/:id/messages` | Message-1 已实现：按 sequence 正序补拉消息 |
| POST | `/api/v2/conversations/:id/messages` | Message-1 已实现：幂等发送观看者文本并校验 `direct_message.send` |
| POST | `/api/v2/conversations/:id/read` | Message-1 已实现：单调推进观看者已读 sequence |
| POST | `/api/v2/conversations/:id/messages/:sequence/recall` | 后续：在服务端返回窗口内撤回本人消息；幂等 |
| POST | `/api/v2/conversations/:id/mute` | 后续：静音/取消静音 |
| POST | `/api/v2/conversations/:id/close` | Message-2 已实现：幂等关闭本人话题，历史只读且不可重开 |
| POST | `/api/v2/conversations/:id/handover-consent` | 未来：历史交接选择 |

创建请求：

```json
{
  "profileId": "pp_xxx",
  "disclosureVersion": "managed_message_1"
}
```

Message-1 的用户消息只接受 `contentType=text`，普通 Unicode 表情可作为文本内容；`system` 只能由服务端生成。图片、语音、视频、文件和位置消息没有可执行入口，未来必须同时满足独立产品评审、服务端 capability 与最低客户端版本后才能接收。

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

连接过程：`POST /api/v2/realtime/tickets` 获取绑定账号、设备和允许会话范围的短期 WebSocket ticket → 连接会话 Durable Object → `hello` 携带最后确认 sequence → 服务端补发缺失事件。

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
| `notification.read_state_changed` | 多设备已读变化，提示刷新服务端未读数 |
| `wallet.changed` | 钱包分录生效，提示刷新权威余额和明细 |

不为平台代运营会话发送 `person.typing`、`person.online` 或 `person.read` 事件。输入状态仅在真实发送主体主动产生且策略允许时短期发送，不持久化。

## 11. 站内通知 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/notifications` | 按消息、互动、会员/金币、系统/安全分类分页查询 |
| GET | `/api/v2/notifications/:id` | 通知安全详情和当前目标可用状态 |
| GET | `/api/v2/notifications/unread-counts` | 各分类未读数 |
| POST | `/api/v2/notifications/:id/read` | 标记单条已读，幂等 |
| POST | `/api/v2/notifications/read-all` | 按分类标记全部已读，幂等 |
| GET/PUT | `/api/v2/me/notification-preferences` | 站内通知偏好；账号/安全/会员/金币/数据权利必要通知不可关闭 |

App 1.0 通过 HTTP 拉取和已连接实时通道刷新站内通知，不依赖 APNs、FCM 或其他系统推送。通知 action 使用受控 `targetType + targetId + action`，打开时重新校验目标和客户端 capability；实时事件不携带完整私信正文。

## 12. 钱包、礼物与装扮 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/me/wallet` | 余额和最后同步时间 |
| GET | `/api/v2/me/wallet/entries` | 金币明细 |
| GET | `/api/v2/me/wallet/entries/:entryId` | 用户可见原因、业务单安全引用和关联冲正 |
| GET | `/api/v2/catalog/coin-packs` | 未来：金币包 |
| GET | `/api/v2/catalog/gifts` | 未来：礼物目录 |
| POST | `/api/v2/gifts` | 未来：赠礼并原子扣币；强制幂等 |
| GET | `/api/v2/me/gifts` | 未来：赠礼历史 |
| GET | `/api/v2/catalog/cosmetics` | 未来：装扮目录 |
| GET | `/api/v2/me/cosmetics` | 未来：库存和装备状态 |
| POST | `/api/v2/cosmetics/:productId/purchase` | 未来：金币购买 |
| PUT/DELETE | `/api/v2/me/cosmetics/:inventoryId/equip` | 未来：装备/卸下 |

App 1.0 钱包路由只读，余额来自追加式分录/受控快照，客户端不得先行加减。赠礼等未来写路由只有独立 Feature 上线后才部署；启用时返回订单/业务记录、钱包分录和权威余额。

## 13. 举报、拉黑与支持 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v2/person-profiles/:profileId/safety` | Message-2：本人对人物的权威屏蔽状态 |
| PUT/DELETE | `/api/v2/person-profiles/:profileId/block` | Message-2：幂等屏蔽/解除屏蔽并执行服务端联动 |
| GET | `/api/v2/me/blocks` | Message-2：本人当前屏蔽人物游标分页 |
| POST | `/api/v2/reports` | Message-2：幂等举报真人、媒体、本人会话或本人消息 |
| GET | `/api/v2/me/reports` | Message-2：本人举报状态游标分页 |
| GET | `/api/v2/me/reports/:reportId` | Message-2：举报必要详情与用户可见时间线 |
| POST | `/api/v2/appeals` | Safety-2：幂等申请本人未发现违规举报结论的独立复核 |
| GET | `/api/v2/me/appeals` | Safety-2：本人复核申请游标分页 |
| GET | `/api/v2/me/appeals/:appealId` | Safety-2：本人复核详情与用户可见时间线 |
| GET | `/api/v2/help/topics` | 后续：帮助与政策 |

拉黑后由服务端清理喜欢/关注、关闭关联话题、禁止后续互动/建话题/发送，并在登录发现页停止推荐目标；解除拉黑不恢复旧关系或旧话题。举报说明最多 500 字，原因来自版本化目录；客户端不能提交证据正文，服务端只固定目标版本、目标消息摘要及相邻引用。申诉只接受文本说明，不开放证据上传，申请本身不自动改变原结论。所有入口要求有效 Auth-1，但举报和申诉不要求会员。

## 14. 管理 API

管理路由使用 `/api/v2/admin`，强认证、RBAC、对象范围和审计必需。

M1 过渡实现复用现有 Nuxt 后台 `/api/admin/app/persons`：列表/详情/创建/草稿更新，以及 `/authorization`、`/verification/submit`、`/verification/decision`、`/publication/submit`、`/publication/decision`、`/publication/pause` 和授权/认证撤销命令。Membership-1 同样暂时复用 `/api/admin/app/memberships`，提供目录、账号状态、预览、低风险发放/续期与追加式撤销。Message-2 暂时复用 `/api/admin/app/conversations` 的限时领取/续租/释放/正文/回复/关闭和 `/api/admin/app/safety` 的举报领取、最小证据、结论及 Owner 运行控制；Safety-2 在同一 safety 路由下增加申诉队列、领取、受控详情和结论。过渡路由只供 admin+ Web 会话使用，全部写命令与敏感读取均审计；下表 `/api/v2/admin` 仍表示长期统一目标。

| 资源 | 主要能力 |
|------|----------|
| `/persons`, `/person-profiles` | 创建、编辑、来源、授权和状态 |
| `/verifications`, `/publications` | 认证、发布、暂停、归档 |
| `/imports` | MeiGallery/批量导入任务 |
| `/taxonomy`, `/taxonomy-catalogs` | 标签/地区/分类、alias、映射、合并和版本发布 |
| `/recommendation-rules`, `/editorial-placements` | 规则版本、dry-run、精选、灰度、暂停和回滚 |
| `/operation-assignments` | 真人运营模式和管理员组 |
| `/managed-conversations`, `/conversation-assignments` | 队列、租约分配、平台回复、内部备注和安全升级 |
| `/reviews`, `/reports`, `/appeals` | 举报案件、最小证据、审核、安全处置和申诉 |
| `/membership-catalogs`, `/entitlement-definitions`, `/membership-grants` | 1.0 五级目录、typed entitlement、预览、手动发放/续期/替换/撤销、复核和有效期 |
| `/products` | 未来：价格和商品版本 |
| `/coin-adjustments`, `/coin-adjustment-batches` | 加币、扣币、补偿、批量逐项结果、复核和冲正 |
| `/orders`, `/reconciliation` | 未来：订单、退款和对账 |
| `/claims`, `/handovers` | 未来：真人认领和交接 |
| `/operation-dashboards`, `/operational-incidents` | 聚合指标、数据新鲜度、异常认领和受控安全开关 |
| `/audit-events`, `/audit-exports` | 只读审计查询、完整性状态和受控短期导出 |

管理员消息接口必须由服务端写入 `senderType=platform_operator`；客户端不能传入 `person` 冒充真人。会员发放、调币和审计导出均使用独立申请/批准/执行状态，批准不等于已经生效；任何余额变化只能产生新钱包分录。

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
