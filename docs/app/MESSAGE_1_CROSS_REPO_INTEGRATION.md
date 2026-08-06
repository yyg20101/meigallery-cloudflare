# Message-1 平台话题跨仓集成边界

App 版本：1.0

日期：2026-08-06

状态：开发纵向切片已完成；所有环境默认关闭；未获准生产发布

## 1. 目标

Message-1 验证一条最小但权威的“有效会员围绕合格真人资料发起平台话题，由管理员以平台运营身份回复”的跨仓链路。该链路复用现有账号、人物公开投影和五级会员事实，不创建第二套用户、人物或会员模型。

本阶段的完成含义是：数据库、Hono API、Nuxt 运营工作台、KMP 客户端、契约和自动化测试可以共同表达并验证这条链路。它不表示需求整体冻结、生产政策关闭、远端 migration 已执行或功能已面向用户开放。

## 2. 本阶段冻结范围

### 2.1 用户侧

- 从合格人物详情查看“平台运营接收”说明。
- 登录后进行二次披露确认，再幂等创建或复用话题。
- 按账号查看话题列表、人物当前可用状态、未读数和只读原因。
- 查看会话详情与按 sequence 正序返回的系统、观看者和平台运营文本消息。
- 发送纯文本或文本中的普通 Unicode 表情。
- 手动刷新会话并单调推进本人已读 sequence。
- 会员到期、账号受限、人物下线或 entitlement 失效后保留历史只读。

### 2.2 运营侧

- 在现有 Nuxt 管理后台查看待运营、待观看者、已关闭或全部队列。
- 查看单个会话元数据与正文；正文访问固定声明 `service_operation` 并写审计。
- 单调推进运营已读 sequence。
- 以固定 `platform_operator` 身份幂等回复文本消息。
- 在发送前再次确认平台身份；服务端拒绝冒充真人或承诺回复、见面和关系结果的明确表达。

### 2.3 本阶段不包含

- WebSocket、Durable Objects、Cloudflare Queues、自动轮询、系统推送和输入中/在线状态。
- 图片、语音、视频、文件、位置、礼物、打赏、支付或自动回复。
- 撤回、举报、拉黑、静音、关闭、会话设置、站内通知和客服工单。
- 多操作员分配、抢单/租约、运营分组、SLA、质量抽检和自动容量门禁。
- 真人本人运营、真人认领、历史会话交接或普通用户之间聊天。

上述能力仍可保留在完整 PRD 和 Figma 中，但不能标记为 Message-1 已实现，也不能通过远程配置生成可执行入口。

## 3. 跨仓责任

| 责任 | `meigallery-cloudflare` | `meigallery-client` |
|---|---|---|
| 契约事实 | OpenAPI `1.5.0`、共享 TypeScript 类型、错误码 | 手写 DTO、严格 Mapper、契约版本头 |
| 账号与授权 | Bearer 会话、账号/设备/session version 校验 | 安全存储、单航班刷新、401 清理 |
| 人物资格 | 公开投影与来源图库实时复核 | 只接受安全公开 ID 和平台运营模式 |
| 会员与额度 | grant、entitlement、有效期、上海日额度原子消耗 | 只展示服务端结果，不本地推算授权或额度 |
| 消息事实 | D1 会话、消息、幂等、已读高水位 | Domain/Repository/Compose 状态，不持久化正文 |
| 运营处理 | Nuxt 队列、正文访问审计、平台身份回复 | 不存在运营入口 |
| 发布控制 | Wrangler 开关、目录选择、production-ready | bootstrap capability 安全停用 |

客户端不得直接访问 D1 或从等级中文名推导权限。Nuxt 管理后台不得绕过服务层直接伪造消息身份。

## 4. 运行时门禁

用户侧同时满足以下条件才可启用：

1. Auth-1 安全可用；
2. `APP_MEMBERSHIP_ENABLED=true`；
3. `APP_MESSAGING_ENABLED=true`；
4. `APP_MEMBERSHIP_CATALOG_VERSION` 精确指向 Message-1 目录；
5. 披露版本合法且与客户端提交一致；
6. production 额外满足会员与消息两个 production-ready 运行时门禁；
7. 目录行必须满足生产状态要求；
8. 当前账号具有未撤销、已开始且未到期的有效 App grant；
9. 对应 entitlement 为 `available` 且值允许当前动作；
10. 目标人物仍满足全部公开资格。

运营侧还要求 `APP_MEMBERSHIP_ADMIN_ENABLED=true` 与 `APP_MESSAGING_ADMIN_ENABLED=true`，并通过现有 admin+ Web 会话鉴权。

当前 `wrangler.toml` 的消息用户/后台开关和 production-ready 均为 `false`，目录仍指向 Membership-1 原始开发目录；因此代码合入不会自动产生可执行消息权限。

## 5. HTTP 契约

累计 App 契约版本为 `1.5.0`，唯一公开事实源为 `contracts/app-api-v2.openapi.yaml`。

### 5.1 Bootstrap

`GET /api/v2/app/bootstrap` 在 capability 之外返回：

- `receiverLabel`：当前只接受“平台运营接收”；
- `disclosureVersion`：创建请求必须回传的披露版本；
- `disclosureText`：人物详情确认、会话顶部和系统说明使用；
- `transport=http_pull`：明确当前没有实时连接；
- `maxTextLength=1000`：服务端、KMP 与 Nuxt 同步限制。

客户端遇到字段缺失、未知传输方式、非法披露版本、矛盾主体或不安全文本上限时，必须把 Message-1 降级为不可用。

### 5.2 用户 API

| 方法 | 路径 | 关键约束 |
|---|---|---|
| POST | `/api/v2/conversations` | Bearer、`Idempotency-Key`、人物公开资格、披露版本、创建 entitlement、日额度 |
| GET | `/api/v2/conversations` | 只返回当前账号；不透明账号作用域游标 |
| GET | `/api/v2/conversations/:id` | 对象归属、当前人物可用状态、服务端可发送结论 |
| GET | `/api/v2/conversations/:id/messages` | `afterSequence` 正序补拉；最大 100 条 |
| POST | `/api/v2/conversations/:id/messages` | Bearer、幂等键、clientMessageId、文本、发送 entitlement 与频控 |
| POST | `/api/v2/conversations/:id/read` | 不能超过 `lastSequence`，只能单调增加 |

创建成功后首条消息固定为服务端生成的接收主体说明。客户端不能省略、修改或伪造该系统消息。

### 5.3 管理员 API

当前沿用受保护的 `/api/admin/app/conversations` 前缀。列表不返回正文；详情和消息正文读取必须携带 `accessReason=service_operation`。回复正文不允许客户端提交发送身份，服务端固定写为 `platform_operator` 并绑定真实 `adminId`。

## 6. D1 权威模型

`0072_app_managed_conversations.sql` 新增：

- `app_conversations`：账号、人物、运营模式、披露版本、状态、队列和读写高水位；账号与人物唯一。
- `app_conversation_quota_consumptions`：每个新会话一条追加式日额度消耗，绑定 grant、目录、tier 和 entitlement。
- `app_conversation_messages`：会话内单调 sequence、发送身份、正文、正文 SHA-256、状态和真实 actor。
- `app_messaging_idempotency`：按 actor、操作和幂等键绑定请求哈希与结果。

migration 还创建独立的 Message-1 `development` 目录。它不创建账号、grant、会话或消息 seed，不回填旧 Web 私信，也不修改运行时开关。

## 7. 原子性、幂等与并发

- 新建会话使用 D1 `batch()` 同时写会话、系统说明、额度消耗和幂等记录；任何一步失败均不留下部分成功。
- 已有会话复用不再次消耗额度，但仍必须绑定本次幂等键；该键之后不能用于另一人物。
- 观看者与运营发送分别按 actor scope 保存幂等结果；相同键配不同请求哈希返回冲突。
- 会话内 `sequence`、`clientMessageId` 和账号/人物唯一约束处理并发竞争；竞争后的安全重读只能返回同一正文哈希与同一 actor 的结果。
- 新话题日键使用 `Asia/Shanghai`，响应同时返回服务端计算的剩余量与下一次重置时间；客户端不得自行扣减。

## 8. 权限与隐私

- 每个用户请求从 Bearer 会话取得账号，不接受请求体账号 ID。
- 创建与发送在写入时重新校验账号、grant、entitlement、人物资格和会话归属；前端隐藏按钮不构成授权。
- 人物失效时会话返回最小人物占位，不能从本地或旧快照恢复已下线展示信息。
- 消息正文不得进入通用日志、分析事件、错误上报或审计 JSON。
- 正文访问审计只保存会话、业务目的、request ID 和当时 sequence；运营回复审计只保存消息 ID、身份、正文 SHA-256 和长度。
- Message-1 不发送真人在线、输入中、已读或本人回复等虚假状态。

## 9. UI 与交互验收

### 9.1 KMP

- “消息”始终保留为一级导航，但 capability 关闭时只显示真实不可用状态，不请求话题 API。
- 人物详情只有在资料为 `platform_managed` 且消息 capability 安全可用时显示执行入口。
- 第一次点击只展开接收主体与完整说明；再次确认才调用创建 API。
- 会话列表持续显示平台接收边界、当前队列状态、未读数和只读原因。
- 会话页固定显示接收主体和披露文案；发送框只在服务端 `canSend=true` 时出现。
- 文本输入遵循 bootstrap 上限；发送中禁止重复提交，失败保留草稿并给出可恢复说明。
- 当前采用手动刷新，不能显示“实时”“在线”“正在输入”或系统推送承诺。

### 9.2 Nuxt

- 队列与详情在窄屏可换行、缩放和滚动，按钮、长 ID、昵称和正文不得横向越界。
- 列表不预览正文；选择会话后才触发受控正文读取及审计。
- 回复区域持续显示“发送身份：平台运营”，提交前再次确认。
- 发送失败不清空正文；成功后回读权威队列和会话状态。

## 10. 自动化验证基线

- API：全量 Vitest、API TypeScript 类型检查、Nuxt production build、OpenAPI YAML 解析。
- D1：全新本地数据库连续执行 `0001–0072`。
- Message-1 定向测试：创建原子性、系统披露、创建/发送幂等、已有会话幂等绑定、上海日额度、对象隔离、会员到期、人物失效、双端已读、队列变化、运营身份和审计无正文。
- KMP：Android Host Test 覆盖授权路径、DTO/Mapper、capability 关闭、平台身份防伪、会员/额度错误、会话失效和非法请求 token。
- 构建：Android Debug APK 与 iOS Simulator Kotlin/Native 编译。
- 端侧：在消息 capability 关闭的默认环境验证“消息”安全不可用；完整可执行链路必须在临时本地 D1、临时测试账号/grant/人物和仅本机开关下另行验收。

测试数量可能随仓库演进变化，是否通过以当前 CI 和交付记录为准，不在需求文档固化易过期数字。

## 11. 生产放行门禁

以下条件全部满足前，不得切换目录或打开任何消息开关：

1. 客户确认 Message-1 文案、等级额度、服务时段、回复预期和未成年人/地区边界；
2. 隐私、消息保留期、管理员正文访问范围和数据权利流程通过评审；
3. 举报、拉黑、紧急暂停与安全升级至少具有可执行替代流程；
4. 运营排班、容量、首响目标、禁止表达和抽检责任人确认；
5. Cloudflare WAF/Rate Limiting Rules、监控、备份、恢复与告警完成；
6. dev 环境使用合成数据完成 Android/iOS、Nuxt 和 API E2E；
7. 生产 migration 备份、回滚点、smoke 与逐项开关顺序获批；
8. production 目录以独立发布动作从 `development` 进入 `published + production_ready`，不能原地改写旧目录；
9. 先部署仍关闭的兼容代码与 migration，通过 smoke 后再单独切换目录和开关；
10. 任一异常可通过关闭 `APP_MESSAGING_ENABLED` 或 `APP_MESSAGING_ADMIN_ENABLED` 立即停止新写入，同时保留历史证据。

## 12. 后续切片建议

Message-1 之后不直接进入实时化。建议先完成 Message-2 安全与运营闭环：举报/拉黑、紧急暂停、会话关闭、保留期、容量门禁、运营分配和端到端审计；再评估通知与实时通道。这样可以在增加到达速度前先具备处理滥用、过载和数据权利的能力。
