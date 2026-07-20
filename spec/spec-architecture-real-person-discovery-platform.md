---
title: 真人发现与互动平台共享架构规格
version: 1.0
date_created: 2026-07-20
last_updated: 2026-07-20
owner: MeiGallery 项目 Owner
tags: [architecture, app, kmp, cloudflare, person-discovery, messaging, commerce]
---

# Introduction

本规格定义 App 1.0 的产品边界、共享平台架构、核心数据、接口、安全要求和可验收行为。目标是让产品、设计、KMP 客户端、Nuxt Web、Hono API、管理后台和测试使用同一组明确规则。

当前状态为需求讨论中，尚未授权创建客户端工程、API、数据库 migration 或部署资源。需求讨论期间直接修订本规格，版本保持与 App 版本一致。

## 1. Purpose & Scope

### 1.1 目的

- 定义“管理员认证的真人发现与互动平台”，避免被实现为普通用户双方配对产品。
- 定义 MeiGallery 数据复用、共享核心和渐进迁移边界。
- 定义 KMP/CMP 客户端、Cloudflare 后端、消息和商业化的目标接口。
- 为功能拆分、测试自动化、安全评审和发布门禁提供机器可读编号。

### 1.2 范围

包含：账号、真人、公开资料、图库映射、认证发布、发现、喜欢/关注/收藏、心享会员私信、平台代运营、本人认领、金币、礼物、装扮、管理后台、安全隐私、KMP 客户端、桌面演进和数据迁移。

不包含：普通用户公开交友资料、双方喜欢/招呼/匹配、普通用户间聊天、未披露管理员冒充、提现/转账/博彩、首版直播和音视频通话。

### 1.3 受众

产品负责人、设计、架构、KMP/Android/iOS/Desktop、Nuxt、Hono、数据、测试、安全、运营、客服和财务人员。

## 2. Definitions

| 术语 | 定义 |
|------|------|
| Account | 注册观看者的登录、设备、角色、隐私和付费主体 |
| Person | 被展示的现实真人主体，不一定拥有登录账号 |
| PersonProfile | 管理员审核通过后用于公开展示的真人资料 |
| Gallery | 与真人资料关联的图片/视频内容集合 |
| Viewer | 使用 Account 发现和互动的普通用户或会员 |
| 心享会员 | 由 rank 和 entitlement 驱动的五级付费体系 |
| Entitlement | 服务端定义的布尔、额度、枚举、集合或时间窗口权限 |
| Platform-managed | 未认领真人的会话由平台运营接收和回复 |
| Person-managed | 已认领真人本人接收和回复新会话 |
| Claim | 真人申请并完成身份、授权和账号绑定的流程 |
| Ledger | 记录金币全部变动的不可变追加式账本 |
| KMP | Kotlin Multiplatform |
| CMP | Compose Multiplatform |
| D1 / R2 / DO | Cloudflare D1、R2、Durable Objects |

## 3. Requirements, Constraints & Guidelines

### 3.1 产品和角色要求

- **PRD-001**：普通注册只能创建 Account，不得创建 Person 或公开 PersonProfile。
- **PRD-002**：只有管理员认证且发布的 PersonProfile 可以出现在推荐、列表、搜索和分享页。
- **PRD-003**：喜欢、关注、收藏和浏览记录必须是 Account 到 PersonProfile 的单向关系，不得创建 Match。
- **PRD-004**：只有有效 `direct_message.create` entitlement 的账号可以创建真人私信。
- **PRD-005**：创建真人私信不要求双方喜欢、招呼、接受或匹配。
- **PRD-006**：未认领真人的私信由平台运营接收；界面必须披露实际接收主体。
- **PRD-007**：管理员不得以 Person 身份发送消息或伪造本人在线、输入、已读和回复。
- **PRD-008**：真人认领成功后默认只接收新会话，历史代运营会话不得自动开放。

### 3.2 真人和内容要求

- **PER-001**：Person、PersonProfile、Gallery 和 Account 必须使用独立稳定 ID。
- **PER-002**：真人来源仅限管理员上传、MeiGallery 合规导入或外部提交后审核。
- **PER-003**：每个公开资料必须关联来源、用途授权、认证、发布、运营模式和审计记录。
- **PER-004**：资料状态至少支持 draft、pending_review、verified、published、suspended、archived 和 rejected。
- **PER-005**：暂停、撤销认证或归档后必须停止新曝光、新私信和受保护媒体凭证签发。
- **PER-006**：公开地区使用城市或模糊区域，不公开精确住址或持续位置轨迹。
- **PER-007**：热度、运营推荐和付费不得被表达为真人认证。

### 3.3 发现与互动要求

- **DIS-001**：发现至少支持推荐、地区、热门、最新、分类、搜索和筛选。
- **DIS-002**：个性化候选集只包含 verified + published 资料，并返回推荐理由代码和规则版本。
- **DIS-003**：用户必须能使用非个性化排序、关闭个性化并清除相关行为记录。
- **DIS-004**：喜欢、关注和收藏必须独立、幂等并可撤销。
- **DIS-005**：收藏支持文件夹；浏览历史仅本人可见并可清除。

### 3.4 私信与代运营要求

- **MSG-001**：建会话必须校验 Account、目标资料、entitlement、周期额度、拉黑、频控和安全状态。
- **MSG-002**：同一观看者与同一真人默认复用一条有效会话；重复请求不得重复扣减额度。
- **MSG-003**：会话必须保存 `operation_mode`，取值至少包括 platform_managed、person_managed、suspended 和 closed。
- **MSG-004**：管理员消息的 sender type 必须是 platform_operator，并关联受限的实际操作员审计。
- **MSG-005**：内部备注与用户消息隔离，任何用户 API 或实时事件不得返回内部备注。
- **MSG-006**：消息发送使用客户端消息 ID、幂等键和会话内单调 sequence。
- **MSG-007**：拉黑、资料暂停、账号冻结、会员失效或会话关闭后，服务端立即重新判断发送权限。
- **MSG-008**：平台代运营的已读只代表平台实际接收主体已查看，不得表示真人本人已读。
- **MSG-009**：首版消息支持文本、表情、系统消息和经审核图片；语音、视频、文件和位置不在首版。

### 3.5 心享会员要求

- **MEM-001**：首版同时展示并销售 rank 10 心遇、20 心悦、30 心知、40 心契、50 心耀。
- **MEM-002**：授权只使用 rank 和 entitlement；名称、文案、颜色和价格不得参与权限判断。
- **MEM-003**：高等级默认继承低等级权益；不继承项必须显式配置和说明。
- **MEM-004**：会员目录必须包含明确价格、期限、续订、权益值、接收主体说明和最低客户端能力。
- **MEM-005**：现有通用展示和额度字段可以服务端配置；未知能力在不支持的客户端安全忽略且不得扩大权限。
- **MEM-006**：任何等级都不能绕过认证、审核、举报、拉黑、频控、资格、隐私或账本规则。

### 3.6 金币、礼物与装扮要求

- **COM-001**：金币不可提现、用户间转账、兑换法币、跨产品流通或用于概率博彩。
- **COM-002**：余额必须由只追加 wallet ledger 分录计算或校验，不允许直接覆盖余额。
- **COM-003**：订单、充值、赠礼、装扮购买和退款必须幂等。
- **COM-004**：礼物是固定价格的非提现互动商品，不向 Person 产生可提现收入或分成。
- **COM-005**：头像框、主页皮肤和聊天皮肤使用统一商品、库存、期限和装备槽模型。
- **COM-006**：管理员可加币、扣币、补偿和冲正，但必须记录原因、用户说明、操作者和审计。
- **COM-007**：高额、高频、批量或负余额风险调币必须双人复核，发起人与复核人不得相同。
- **COM-008**：错误分录只能通过关联冲正修复，不得编辑或删除原记录。

### 3.7 本人认领要求

- **CLM-001**：认领至少包含申请、身份核验、用途/权利复核、账号安全、管理员批准和绑定。
- **CLM-002**：同一 Person 的并发认领必须进入冲突处理，不能后写覆盖。
- **CLM-003**：认领只改变运营主体，不自动改变历史会话可见性。
- **CLM-004**：历史交接需要观看者明确同意、真人权利确认和管理员审批。
- **CLM-005**：认领撤销、争议或账号受限时可暂停新会话或恢复平台运营，并记录审计。

### 3.8 安全、隐私和后台要求

- **SEC-001**：所有对象级权限由服务端执行；客户端状态不得作为授权依据。
- **SEC-002**：受保护 R2/Stream 媒体必须在服务端验证后签发短期凭证。
- **SEC-003**：后台认证、发布、代运营、审核、商业、财务、复核和审计角色必须分离。
- **SEC-004**：所有后台写操作记录操作者、目标、原因、前后状态、请求 ID 和审批链。
- **SEC-005**：通用日志、分析和崩溃报告不得包含消息正文、完整证件、授权原件、支付凭证、精确位置或 Token。
- **SEC-006**：用户必须能举报、拉黑、管理推荐偏好、导出数据和申请注销。
- **SEC-007**：真人/权利人必须有更正、暂停、撤回授权和争议渠道。
- **SEC-008**：发布前必须关闭目标地区的运营主体、数据位置、跨境、年龄、商店和支付结论。

### 3.9 平台和迁移约束

- **CON-001**：基础设施使用 Cloudflare Workers、Workers Assets、D1、R2、Durable Objects、Queues、Workflows、Turnstile、WAF 和 Rate Limiting；不使用 Cloudflare Pages。
- **CON-002**：Web 与 API 保持独立 Worker，管理后台保留 Nuxt；Compose Web 不在范围。
- **CON-003**：Android/iOS 首发使用 KMP + CMP；Windows/macOS 后续复用业务核心和大部分 UI。
- **CON-004**：Kotlin 与 TypeScript 使用 OpenAPI、JSON Schema 和实时事件 schema 对齐，不直接共享源码。
- **CON-005**：App 不能直接访问 D1/R2/DO 或 legacy 表。
- **CON-006**：迁移使用共享核心 + 渐进切换，每个阶段只有一个写主并提供对账和回滚点。
- **CON-007**：当前阶段只允许文档变更，不允许创建实现代码或运行生产迁移。

### 3.10 工程指南

- **GUD-001**：优先保持逻辑领域边界，在容量或团队需要前不强制拆分微服务。
- **GUD-002**：配置包含 schema、版本、生效时间、地区/渠道、灰度、审批和回滚。
- **GUD-003**：远程配置不得下载可执行代码或启用客户端不存在的原生能力。
- **GUD-004**：高风险状态使用显式状态机和关联事件，不使用散落布尔值。
- **GUD-005**：所有页面实现加载、空、错误、离线、无权限、下架和安全受限状态。
- **GUD-006**：移动/桌面支持屏幕阅读器、动态字体/缩放、键盘、高对比度和减少动态效果。

## 4. Interfaces & Data Contracts

### 4.1 核心实体关系

```text
Account ──< ViewerInteraction >── PersonProfile ──> Person
Person ──< PersonAuthorization / Verification / OperatorAssignment / Claim
PersonProfile ──< ProfileGallery >── Gallery ──< Media
Account ──< Conversation >── Person
Conversation ──< Message / Receipt / Assignment
Account ──< EntitlementGrant / Order / WalletEntry / CosmeticInventory
PersonProfile ──< GiftTransaction
```

### 4.2 主要 API 资源

| 资源 | 路径前缀 | 权限 |
|------|----------|------|
| 账号与设置 | `/api/v2/me`, `/api/v2/auth` | 当前账号 |
| 发现与真人 | `/api/v2/discovery`, `/api/v2/person-profiles` | 公开投影/登录策略 |
| 单向互动 | `/api/v2/me/follows`, `/likes`, `/favorites` | 当前账号 |
| 私信 | `/api/v2/conversations` | 参与者 + entitlement + 状态 |
| 会员和订单 | `/api/v2/catalog`, `/api/v2/orders`, `/entitlements` | 当前账号/公开目录 |
| 钱包和商品 | `/api/v2/me/wallet`, `/gifts`, `/cosmetics` | 当前账号 |
| 举报和拉黑 | `/api/v2/reports`, `/person-profiles/:id/block` | 当前账号 |
| 管理后台 | `/api/v2/admin/*` | 强认证 + RBAC + 审计 |

### 4.3 会话创建响应

```json
{
  "conversationId": "cv_01...",
  "operationMode": "platform_managed",
  "receiverLabel": "平台运营接收",
  "disclosureVersion": "managed_message_1",
  "quota": {
    "remaining": 2,
    "resetsAt": "2026-07-21T00:00:00Z"
  }
}
```

### 4.4 实时事件

所有事件包含 `eventId`、`eventType`、`schemaVersion`、`conversationId`、`sequence`、`occurredAt` 和 `payload`。允许类型至少包括：

- `conversation.snapshot`
- `message.created`
- `message.status_changed`
- `receipt.read`
- `operation_mode.changed`
- `conversation.restricted`

`message.created.payload.senderType` 只能是 viewer、platform_operator、person 或 system。只有已认领并授权的真人账号可以产生 person。

### 4.5 账本分录

```json
{
  "entryId": "le_01...",
  "accountId": "acc_01...",
  "direction": "debit",
  "amount": 100,
  "businessType": "gift_purchase",
  "businessId": "gift_01...",
  "reasonCode": "USER_PURCHASE",
  "userVisibleDescription": "赠送虚拟礼物",
  "balanceAfter": 420,
  "createdAt": "2026-07-20T12:00:00Z"
}
```

## 5. Acceptance Criteria

- **AC-001**：Given 普通账号完成注册，When 查询发现流，Then 该账号没有公开 PersonProfile 且不会作为真人出现。
- **AC-002**：Given 真人资料未认证或未发布，When 访问任一公开入口，Then 服务端不返回该资料。
- **AC-003**：Given 观看者喜欢、关注和收藏真人，When 操作完成，Then 分别产生单向关系且不存在 Match。
- **AC-004**：Given 账号无有效私信 entitlement，When 创建会话，Then 返回 `ENTITLEMENT_REQUIRED` 且不创建记录、不消耗额度。
- **AC-005**：Given 会员向未认领真人创建会话，When 收到管理员回复，Then 用户看到 platform_operator，后台可追溯实际操作员。
- **AC-006**：Given 管理员尝试发送 senderType=person，When 服务端校验，Then 拒绝请求并写入安全审计。
- **AC-007**：Given 资料暂停、账号拉黑或会员失效，When 已连接客户端继续发送，Then 服务端立即拒绝且不持久化消息。
- **AC-008**：Given 同一订单、消息、赠礼或调币请求重试，When 幂等键相同，Then 只产生一次权威业务结果。
- **AC-009**：Given 高风险扣币未复核，When 查看用户余额，Then 余额不变；复核后新增分录且历史不可修改。
- **AC-010**：Given 真人完成认领，When 新建会话，Then 路由本人；历史会话无 consent 时本人不可读取。
- **AC-011**：Given 客户端收到未知 entitlement，When 渲染和调用 API，Then 安全忽略展示且不能自行获得权限。
- **AC-012**：Given 真人授权被撤回，When 公开查询或请求媒体凭证，Then 资料/媒体停止可用并保留审计。

## 6. Test Automation Strategy

### Test Levels

- 单元：状态机、rank/entitlement、公开过滤、互动幂等、额度、账本和认领规则。
- 契约：OpenAPI、JSON Schema、实时事件、Kotlin/TypeScript 生成和错误码。
- 集成：D1 事务、R2 凭证、DO 顺序/休眠、Queue 重试、Workflow 和外部商店回调。
- E2E：Android/iOS、Nuxt 后台与 dev/staging，覆盖发现、代运营、购买、调币、举报和认领。
- 安全：对象越权、管理员 RBAC、凭证重放、批量抓取、消息身份伪造和敏感日志扫描。
- 非功能：性能、容量、恢复、无障碍、桌面键盘和目标设备矩阵。

### Test Data Management

- 使用合成账号和明确授权的测试真人/媒体。
- 测试环境禁止复制生产私信、证件、支付凭证和授权原件。
- 每个测试创建唯一 stable ID 和幂等键，支持确定性清理。

### CI/CD Integration

- Pull Request 必须执行 schema lint、破坏性变更检查、类型检查、构建和核心单元/集成测试。
- migration 在隔离 D1 上演练并验证 forward-fix/回滚路径。
- Android/iOS 必须在对应 runner 构建；Desktop 在 M4 加入 Windows/macOS 构建矩阵。

### Performance and Recovery

- 压测推荐分页、单会话/多会话消息、订单回调、账本并发和批量导入/调币。
- 演练 DO 休眠/重连、Queue 重复、Workflow 中断、D1 备份恢复和 R2 资源撤回。

## 7. Rationale & Context

现有 MeiGallery 是管理员发布的图库平台，真实人物供给由平台控制。普通注册用户只观看内容，因此把产品建模为双方交友会创造不存在的公开用户资料和匹配关系。将 Account、Person、PersonProfile 和 Gallery 分离，可以复用现有内容、准确表达授权与运营，并为未来本人认领保留路径。

未认领阶段由管理员提供互动服务，但付费用户必须知道实际接收方。平台运营身份和只追加审计既是信任要求，也是消息权限、举报、已读和交接的技术基础。

五级会员使用 rank/entitlement，使未来功能可以挂接到等级而不依赖展示名称；同时，任何新客户端能力仍需显式版本门槛，避免远程配置制造不可执行或越权状态。

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**：目标应用商店——数字会员/金币购买、交易验证、退款和恢复购买。
- **EXT-002**：目标平台推送服务——消息、交易和安全通知；按地区和平台适配。
- **EXT-003**：身份/真人核验供应商——处理认领和资格所需的最小核验结果，接入前完成隐私与地区评估。
- **EXT-004**：内容审核服务（如需要）——只有人工/规则不足时，经 DPA 和安全评审通过适配器接入。

### Infrastructure Dependencies

- **INF-001**：Cloudflare Workers/Workers Assets——Nuxt Web、管理后台和 Hono API。
- **INF-002**：Cloudflare D1——结构化业务、投影、账本和审计。
- **INF-003**：Cloudflare R2——私有媒体、导入包、授权和必要审核证据。
- **INF-004**：Cloudflare Durable Objects——会话顺序、连接、去重和短期实时状态。
- **INF-005**：Cloudflare Queues/Workflows——异步投影、通知、导入、认领、调币和删除。
- **INF-006**：Cloudflare Turnstile/WAF/Rate Limiting——人机验证和边缘防护。

### Technology Platform Dependencies

- **PLT-001**：KMP + Compose Multiplatform——Android/iOS 首发，Windows/macOS 后续。
- **PLT-002**：Nuxt 4——现有 Web 和管理后台。
- **PLT-003**：Hono on Cloudflare Workers——API 运行时。
- **PLT-004**：OpenAPI/JSON Schema——跨语言契约源。
- **PLT-005**：Ktor Client + kotlinx.serialization——Android 使用 OkHttp 引擎，iOS 使用 Darwin 引擎。
- **PLT-006**：Jetpack Lifecycle/ViewModel、Navigation 3、Paging、Room/SQLite 和 DataStore Preferences——公共状态、导航、分页和本地数据基线。
- **PLT-007**：Coil 3——公共图片加载；公开和受保护媒体使用不同缓存策略。
- **PLT-008**：视频共享控制契约，Android 使用 Media3 ExoPlayer，iOS 使用 AVPlayer/AVKit；Cloudflare Stream 使用服务端授权的短期签名 HLS。
- **PLT-009**：Android App 1.0 使用 `minSdk = 26`；API 25 及以下不提供兼容、测试或降级方案，可以经显式决策继续提高最低版本。

### Data and Compliance Dependencies

- **DAT-001**：MeiGallery 账号、会员、图库、媒体、标签和审计——按稳定 ID、授权证据和迁移任务接入。
- **COM-001**：目标地区运营主体、年龄、数据位置/跨境、商店、支付、隐私和内容结论——公开发布前必须关闭。

## 9. Examples & Edge Cases

### 9.1 管理员上传不等于自动发布

```text
管理员上传媒体
→ 创建 Person/Profile 草稿
→ 关联来源和用途授权
→ 认证审核
→ 发布审核
→ 生成公开投影
```

缺少任一必要证据时停留在不可公开状态。

### 9.2 平台运营切换为本人运营

```text
Person 完成认领
→ OperatorAssignment 切换为 person_managed
→ 新会话路由真人账号
→ 旧会话继续 platform_managed
→ 观看者单独同意后才可进入历史交接 Workflow
```

### 9.3 重复赠礼

同一账号以相同 Idempotency-Key 重试相同礼物请求时返回首个 gift transaction 和 wallet entry。若请求金额或目标不同，返回 `IDEMPOTENCY_CONFLICT`。

### 9.4 未知客户端能力

服务端目录包含客户端尚未实现的 `video_call.priority` 时，客户端忽略该展示；服务端不得因为该字段存在就允许旧客户端调用视频接口。

## 10. Validation Criteria

- 所有编号需求能映射到至少一个自动或人工验收用例。
- 产品、UI、技术、数据、API、安全、商业和路线图对普通账号、真人资料、私信接收方、会员和金币规则表述一致。
- 仓库正式文档中不存在双方匹配、普通用户公开资料或未披露代聊作为当前需求。
- App 文档版本统一为 1.0，状态统一为需求讨论中。
- Markdown 链接、Mermaid、JSON 示例和表格通过文档检查。
- 当前阶段没有因文档工作产生实现代码、API、migration 或生产变更。

## 11. Related Specifications / Further Reading

- [App 文档总览](../docs/app/README.md)
- [产品需求文档](../docs/app/PRODUCT_REQUIREMENTS.md)
- [技术架构方案](../docs/app/TECHNICAL_ARCHITECTURE.md)
- [数据模型与迁移方案](../docs/app/DATA_AND_MIGRATION.md)
- [API 与实时通信契约](../docs/app/API_AND_REALTIME_CONTRACT.md)
- [信任、安全、隐私与合规](../docs/app/TRUST_SAFETY_PRIVACY_COMPLIANCE.md)
- [Feature PRD 目录](../docs/ways-of-work/plan/real-person-discovery-platform/README.md)
