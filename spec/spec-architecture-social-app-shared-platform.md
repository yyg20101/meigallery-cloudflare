---
title: 独立交友 App 与共享业务平台架构规格
version: 1.1.0
date_created: 2026-07-19
last_updated: 2026-07-20
owner: MeiGallery 项目 Owner
tags: [architecture, app, cloudflare, social, migration, trust-safety, kmp, desktop]
---

# Introduction

本规格定义独立交友用户客户端（工作名“心动遇见你”）与当前 MeiGallery Web 共用核心数据、并将 Web 渐进迁移到共享业务平台的要求、约束、接口和验收标准。客户端先发布 Android/iOS，后续覆盖 Windows/macOS。本文是面向研发、测试和 AI 工程代理的自包含执行规格，不表示能力已实现。

## 1. Purpose & Scope

### 1.1 目的

- 建立独立 Android/iOS App 以及后续 Windows/macOS 用户客户端的产品与技术边界。
- 复用现有用户、会员、合法授权媒体、标签和管理员事实。
- 隔离图库、交友、实时消息和商业化领域。
- 使现有 Web 在不中断服务的前提下逐模块迁移到共享平台。

### 1.2 范围

包含：账号与同意、成年与身份核验、交友资料、发现、匹配、消息、举报拉黑、会员权益、金币礼物、KMP 客户端、桌面演进、数据迁移、隐私安全、测试和发布门禁。

不包含：本阶段实现代码、匿名随机聊天、未成年人交友、直播、博彩/随机礼物、用户提现、精确位置分享和端到端加密承诺。

### 1.3 已确认假设

- App 是独立产品和独立客户端。
- 目标架构为共享核心平台 + 渐进式迁移。
- 用户客户端采用 KMP + Compose Multiplatform：Android/iOS 优先，Windows/macOS 后续；后端继续使用 Cloudflare Workers/Hono。
- 现有图库人物不得自动成为交友资料。
- 首发交友功能仅限 18 岁及以上用户。

## 2. Definitions

| 术语 | 定义 |
|------|------|
| Account | 共享平台的账号根，跨 App/Web 使用稳定且不可枚举的 `account_id` |
| Legacy User | 当前 `users` 表中的既有账号，以整数 ID 标识 |
| Profile | 用户主动创建、授权并经审核的交友公开资料，不等同于 Gallery |
| Entitlement | 某账号在特定时间范围内拥有的能力，不依赖会员名称硬编码 |
| Grant | entitlement 的来源事实，可来自 legacy、人工发放或商店订单 |
| Conversation DO | 以单会话为协调原子的 Durable Object |
| Outbox | 与业务写入同事务记录、随后由异步发布器投递的领域事件 |
| UGC | 用户生成内容，包括资料、媒体、聊天和举报说明 |
| PII | 可识别或关联自然人的个人信息 |
| Sensitive PII | 身份、生物识别、精确位置、通信、金融等高风险个人信息 |
| DLQ | Dead Letter Queue，多次消费失败后的隔离队列 |
| SLO | Service Level Objective，服务目标 |
| KMP | Kotlin Multiplatform，共享跨平台 Kotlin 业务代码的技术 |
| CMP | Compose Multiplatform，共享 Android、iOS 和 Desktop UI 的框架 |

## 3. Requirements, Constraints & Guidelines

### 3.1 产品要求

- **PRD-001**：系统只允许已核验年满 18 周岁的用户进入发现、匹配和聊天。
- **PRD-002**：持续聊天必须基于双方匹配或收件人明确接受招呼。
- **PRD-003**：系统必须提供举报、拉黑、解除匹配、申诉和安全中心。
- **PRD-004**：位置默认展示城市或模糊距离段，不展示精确坐标或稳定精确距离。
- **PRD-005**：用户必须能够关闭个性化推荐并使用非个性化结果。
- **PRD-006**：VIP 与认证是独立概念，付费不得改变认证或审核结论。

### 3.2 架构要求

- **ARC-001**：App 只能通过 `/api/v2` 和 `/realtime/v1` 访问平台数据。
- **ARC-002**：目标平台必须隔离核心 D1、社交 D1、会话 Durable Object Storage 和私有媒体存储职责。
- **ARC-003**：一个 conversation 必须映射到一个 Durable Object，以提供消息顺序和连接协调。
- **ARC-004**：跨领域状态变化必须使用本地事务、outbox、Queue 和幂等消费者；不得依赖分布式事务。
- **ARC-005**：API 对外 ID 必须不可枚举；legacy integer user ID 不得作为 App 公开 ID。
- **ARC-006**：Web 和 App 必须独立发布，API 破坏性变更只能进入新主版本。
- **ARC-007**：重要 Durable Object 状态必须持久化，不得只保存在内存。
- **ARC-008**：客户端共享代码必须使用 KMP/CMP，平台 SDK 通过 Android/iOS/Desktop source set 或适配端口接入。
- **ARC-009**：OpenAPI、JSON Schema 和 WebSocket event schema 必须是 Kotlin/TypeScript 的唯一跨语言契约源，禁止手工维护两套语义不同的 DTO。
- **ARC-010**：Android/iOS、Windows/macOS、Nuxt Web 和管理后台必须可独立发布；桌面客户端不得直接读取数据库或复用管理员凭证。

### 3.3 数据与迁移要求

- **DAT-001**：复用 legacy 账号不能自动创建可发现 Profile。
- **DAT-002**：现有 Web session 不迁移为 App session。
- **DAT-003**：现有媒体只有在交友用途授权、主体一致和审核全部通过后才能关联 Profile。
- **DAT-004**：会员迁移必须保留 legacy 来源、原 ID、发放者和有效期，并投影为 entitlement grant。
- **DAT-005**：迁移任务必须可重入，并记录批次、条目、输入/输出摘要和失败分类。
- **DAT-006**：迁移期间每类数据只能有一个写入权威。
- **DAT-007**：站内分析、广告归因和私聊内容不得在无相应同意时进入交友推荐画像。

### 3.4 安全与隐私要求

- **SEC-001**：对象级授权必须由服务端完成，不信任客户端传入的身份、角色、余额或认证状态。
- **SEC-002**：手机号、证件、生物识别、精确位置、消息和支付数据按敏感级别最小化处理。
- **SEC-003**：身份核验优先由合规服务处理，平台只保存最小结果和供应商引用。
- **SEC-004**：拉黑必须即时关闭发现、消息和访客可见性，解除拉黑不自动恢复匹配。
- **SEC-005**：公开资料和资料媒体必须先审后发；聊天文本必须具备实时高危过滤和举报审核。
- **SEC-006**：身份、消息证据、管理员和账本访问必须审计。
- **SEC-007**：日志不得包含令牌、验证码、完整证件、精确位置、私聊正文或商店凭证明文。
- **SEC-008**：生产接入中国大陆用户数据前必须关闭数据驻留、跨境、备案和适用许可决策。

### 3.5 消息要求

- **MSG-001**：每个会话消息必须拥有严格递增 `seq`。
- **MSG-002**：客户端发送消息必须携带唯一 `clientMessageId`，重复发送返回原结果。
- **MSG-003**：断线恢复必须从最后确认序号补拉。
- **MSG-004**：消息投影或推送失败不得导致权威消息丢失。
- **MSG-005**：会话被拉黑、解除匹配、封禁或注销后，发送权限立即失效。
- **MSG-006**：M1 只支持文本、官方表情/贴纸、系统通知和礼物消息；聊天图片、语音和视频默认关闭。

### 3.6 商业化要求

- **COM-001**：商店交易只在服务端验证后发放权益或金币。
- **COM-002**：`store + original_transaction_id` 必须唯一，重复回调不得重复发放。
- **COM-003**：金币余额由只追加账本得到，不得直接修改。
- **COM-004**：已购买金币不得过期、提现、转账或跨产品使用。
- **COM-005**：礼物必须确定性定价，不包含随机奖励或现金价值。
- **COM-006**：退款和人工调整必须通过冲正/调整分录并写审计日志。

### 3.7 约束与指南

- **CON-001**：Cloudflare 是主要运行时和基础设施平台。
- **CON-002**：APNs、FCM、应用商店支付、短信和身份核验是明确允许的外部平台集成，但需完成合同和安全评估。
- **CON-003**：当前 Web 的人工会员发放在独立 App M2 前保持不变。
- **GUD-001**：优先在现有 Hono API Worker 内按模块实现 v2；只有风险或容量证据支持时才拆更多 Worker。
- **GUD-002**：所有新接口和事件使用 schema 版本、稳定错误码和契约测试。
- **GUD-003**：所有开放能力以 feature flag 和地区门禁发布。

## 4. Interfaces & Data Contracts

### 4.1 API 边界

| 接口 | 用途 | 鉴权 |
|------|------|------|
| `/api/v2/auth/*` | 手机登录、legacy link、token refresh | 按端点；高风险 Turnstile |
| `/api/v2/me/*` | 当前账号、资料、同意、数据权利 | 用户客户端 bearer token |
| `/api/v2/discovery/*` | 推荐、附近、活跃、解释 | 已激活 App account |
| `/api/v2/profiles/*` | 资料读取、互动、拉黑 | 查看者上下文授权 |
| `/api/v2/matches/*` | 匹配与解除 | 匹配成员 |
| `/api/v2/conversations/*` | 会话索引、历史、ticket、礼物 | 会话成员 |
| `/api/v2/reports` | 举报 | 已认证用户；紧急渠道可降级 |
| `/api/v2/commerce/*` | 商品、交易验证、权益、钱包 | App token 或商店签名入口 |
| `/api/v2/admin/*` | 审核、举报、迁移、账本 | Admin audience + RBAC + MFA |

### 4.2 标准事件

```json
{
  "eventId": "evt_01...",
  "eventType": "gift.sent",
  "schemaVersion": 1,
  "aggregateId": "gtx_01...",
  "aggregateVersion": 1,
  "occurredAt": "2026-07-19T08:00:00Z",
  "traceId": "trc_01...",
  "payload": {}
}
```

### 4.3 主要数据关系

```text
legacy users 1 ── 1 legacy_user_links * ── 1 accounts
accounts 1 ── 0..1 profiles
profiles 1 ── * profile_media
accounts * ── * matches（规范化双成员唯一）
matches 1 ── 0..1 conversations
conversations 1 ── 1 Conversation Durable Object
accounts 1 ── * entitlement_grants
accounts 1 ── 1 wallet_accounts 1 ── * wallet_ledger_entries
```

## 5. Acceptance Criteria

- **AC-001**：Given legacy 用户未同意交友用途，When 身份影子迁移完成，Then 不存在对外可发现 Profile。
- **AC-002**：Given legacy 媒体缺少交友用途授权，When 用户选择迁移媒体，Then 系统拒绝创建 `profile_media` 并记录原因。
- **AC-003**：Given 双方未匹配且招呼未接受，When 发送第二条消息，Then 返回 `CONVERSATION_NOT_OPEN` 且不持久化消息。
- **AC-004**：Given 相同 `clientMessageId` 被重试，When Durable Object 处理请求，Then 返回同一 server message 和 seq。
- **AC-005**：Given 用户拉黑匹配对象，When 对方同时发送消息，Then 最终授权状态以拉黑优先且消息不可送达。
- **AC-006**：Given 同一商店交易回调重复或乱序，When 服务端处理，Then 只存在一次发放且最终状态符合平台事实。
- **AC-007**：Given 同一礼物 Queue 事件重复到达，When conversation DO 消费，Then 只生成一条礼物消息。
- **AC-008**：Given 用户拒绝定位和个性化推荐，When 访问发现页，Then 可使用手动城市和非个性化排序。
- **AC-009**：Given 用户提交账号删除，When Workflow 完成，Then 公开资料、非必要 UGC、session 和推送 token 已移除，必要留存被用途隔离。
- **AC-010**：Given 管理员修改审核、封禁、权益或钱包，When 操作完成，Then 存在操作者、目标、前后状态、原因和时间的审计事件。
- **AC-011**：Given 同一契约版本，When CI 生成/校验 Kotlin 与 TypeScript 模型，Then 字段、枚举、可空性、错误码和事件版本语义一致且不存在未提交差异。
- **AC-012**：Given 某桌面设备被远程退出或账号被封禁，When 客户端收到失效状态或下一次请求失败，Then 所有窗口立即隐藏敏感内容、停止消息发送并要求重新认证。

## 6. Test Automation Strategy

- **Test Levels**：单元、组件、契约、D1/DO 集成、E2E、安全、性能和恢复。
- **Frameworks**：API/Web/TypeScript Shared 沿用 Vitest；KMP 使用 `kotlin.test`、平台测试和 Compose Multiplatform UI 测试；E2E 工具在技术验证后按 Android/iOS/Windows/macOS 支持情况固定。
- **Contract**：OpenAPI/JSON Schema 和 WebSocket event schema 兼容检查进入 CI。
- **Test Data**：只用合成成人资料、脱敏迁移 fixture、身份与商店 sandbox。
- **Coverage**：关键状态机、授权、账本、幂等、迁移和删除分支必须 100% 分支覆盖；全项目覆盖率阈值由实施计划按现有基线设定。
- **Performance**：API P95、WebSocket 连接/消息、Queue 延迟、迁移吞吐和客户端弱网。
- **Recovery**：D1 Time Travel/导出、R2 对象清单、DO 状态、DLQ 重放和 Workflow 恢复演练。

### 6.1 要求追踪矩阵

| 要求组 | 验收标准 | 主要自动化证据 | 主要人工证据 |
|--------|----------|----------------|--------------|
| PRD-001..006 | AC-001、AC-003、AC-005、AC-008、AC-009 | 激活、发现、匹配、拉黑和注销 E2E | 年龄/推荐/付费文案和商店评审 |
| ARC-001..010 | AC-004、AC-007、AC-010、AC-011、AC-012 | API 契约、双语言生成、平台边界、DO 休眠恢复、outbox/Queue 集成 | 部署拓扑、桌面分发与权限复核 |
| DAT-001..007 | AC-001、AC-002、AC-009 | 迁移可重入、数量/语义对账、同意撤回 | 媒体授权与数据用途抽检 |
| SEC-001..008 | AC-002、AC-005、AC-009、AC-010 | 对象授权、日志脱敏、拉黑竞态、删除 Workflow | PIA、供应商、备案和事件演练 |
| MSG-001..006 | AC-003、AC-004、AC-005 | 序号、幂等、断线补拉、Queue 重复、会话关闭 | 弱网与多设备体验验收 |
| COM-001..006 | AC-006、AC-007 | 商店 sandbox、账本平衡、退款冲正、礼物幂等 | 财务对账与商店商品复核 |

实施计划必须把每个具体要求映射到至少一条可定位的测试或人工证据；本表用于确保所有要求组都有闭环，不替代测试用例清单。

## 7. Rationale & Context

直接扩展现有 API 虽然启动快，但会让 Gallery、Profile、会员、钱包和消息共享遗留表，后续无法清晰处理授权、审计和迁移。全新平台双向同步隔离更强，但长期双写和一致性成本过高。因此选择共享核心平台 + 渐进式迁移：新 App 从第一天使用目标契约，Web 在可验证的边界上逐步切换。

Durable Objects 适合用会话作为协调原子；D1 适合跨会话查询、身份和账本事务；Queues/Workflows 处理跨域最终一致和长任务。组合方案避免将实时顺序、财务强一致和全局查询硬塞进同一种存储。

KMP/CMP 在 Android、iOS 和 Desktop 目标上提供稳定的共享业务与 UI 基础，符合移动优先、桌面后续的路线。平台支付、推送、安全存储、权限、签名和更新仍由适配层承担。现有 Nuxt Web/后台继续服务 SEO 和运营场景，避免把尚未稳定的 Compose Web UI 当作迁移目标。

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**：现有 MeiGallery v1 API/D1/R2，作为迁移期 legacy source。
- **EXT-002**：Apple App Store / StoreKit，用于 iOS 分发、订阅和虚拟币。
- **EXT-003**：Google Play / Billing，用于相应 Android 分发与支付。
- **EXT-004**：目标中国 Android 应用商店及支付系统，按渠道审批。
- **EXT-005**：Windows/macOS 的签名、notarization、商店或批准的更新分发渠道。

### Third-Party Services

- **SVC-001**：短信服务，需支持验证码、限流、送达和数据处理协议。
- **SVC-002**：身份/年龄核验服务，需提供最小结果、回调签名、数据位置和删除能力。
- **SVC-003**：APNs、FCM 和可选厂商推送。
- **SVC-004**：如人工审核无法满足过滤要求，经审批接入的内容安全服务。

### Infrastructure Dependencies

- **INF-001**：Cloudflare Workers + Hono。
- **INF-002**：Cloudflare D1 核心库与社交库。
- **INF-003**：SQLite-backed Durable Objects + Hibernation WebSocket API。
- **INF-004**：Cloudflare R2、Queues、Workflows、Turnstile 和后续 Stream。
- **INF-005**：Cloudflare WAF、Rate Limiting Rules、Secrets 和日志。

### Data Dependencies

- **DAT-DEP-001**：legacy users/memberships/media/tags/admin 的数据质量和授权清单。
- **DAT-DEP-002**：产品条款、隐私政策、社区规则和同意版本。
- **DAT-DEP-003**：商品目录、平台 SKU 和财务科目审批。

### Technology Platform Dependencies

- **PLT-001**：Kotlin Multiplatform + Compose Multiplatform，首期目标 Android/iOS，后续目标 Windows/macOS。
- **PLT-002**：Nuxt 4 Web/管理后台继续作为迁移期和长期 Web 客户端，不迁移到 Compose Web。
- **PLT-003**：pnpm monorepo 与独立 Gradle 客户端工程在仓库级 CI 编排，互不伪装为对方的 package。
- **PLT-004**：OpenAPI/JSON Schema/WebSocket event schema 为契约源，生成或校验 Kotlin 与 TypeScript 模型。
- **PLT-005**：Kotlin、Compose、Gradle、AGP、JDK 和 Xcode 必须使用经过验证并锁定的兼容矩阵。

### Compliance Dependencies

- **COM-DEP-001**：Apple/Google UGC、账号删除、交友年龄和支付政策。
- **COM-DEP-002**：中国大陆 APP 备案、真实身份、个人信息、算法和未成年人规则适用性。
- **COM-DEP-003**：Cloudflare 与外部供应商的数据位置、跨境和合同结论。

## 9. Examples & Edge Cases

### 9.1 旧会员映射

同一用户存在 vip 与 svip 两条重叠有效记录时，迁移创建两条独立 grant，权益投影在任一时点取最高有效 rank。不得合并并丢失原发放记录。

### 9.2 拉黑与消息竞态

消息已被 conversation DO 接受但安全服务随后确认更早发生的拉黑时，系统关闭会话并根据事件顺序/授权版本决定消息是否对接收者可见；不能仅凭客户端到达顺序判断。

### 9.3 退款后负余额

用户购买金币、消费后发生商店退款时，系统写退款冲正。若余额为负，冻结新消费并建立客服任务，不删除已发送礼物或修改原账本。

### 9.4 用户拒绝定位

发现 API 接受 `cityCode`，返回城市级或非位置结果；不得以拒绝定位为由阻断核心服务。

### 9.5 注销与举报证据

被举报用户注销时，公开资料和普通 UGC 进入删除流程；与未完成安全案件直接相关的最小证据按批准期限隔离保留，并停止任何其他处理。

## 10. Validation Criteria

- 文档中的所有 REQ/SEC/DAT/MSG/COM 要求都有自动化测试或人工上线证据映射。
- v2 客户端不直接查询 legacy 表或使用 v1 session。
- 迁移批次可重复执行且对账结果稳定。
- 消息在重连、休眠、重复和投影失败下保持顺序和幂等。
- 账本任何时点平衡，订单回调重复不会重复发放。
- 拉黑、举报、未成年人处置和注销完成端到端演练。
- 商店声明、隐私政策和真实 SDK/数据流一致。
- Kotlin 与 TypeScript 契约生成/兼容检查通过，Android/iOS/Windows/macOS 构建矩阵无阻断错误。
- 桌面远程登出、敏感窗口遮蔽、代码签名、更新校验和回滚完成演练后才允许桌面 Alpha。
- 中国大陆数据和备案门禁在包含大陆的发布计划中有正式批准证据。

## 11. Related Specifications / Further Reading

- [文档总览](../docs/app/README.md)
- [产品需求](../docs/app/PRODUCT_REQUIREMENTS.md)
- [技术架构](../docs/app/TECHNICAL_ARCHITECTURE.md)
- [数据迁移](../docs/app/DATA_AND_MIGRATION.md)
- [API 与实时契约](../docs/app/API_AND_REALTIME_CONTRACT.md)
- [UI/UX 设计](../docs/app/UI_UX_DESIGN.md)
- [信任安全与合规](../docs/app/TRUST_SAFETY_PRIVACY_COMPLIANCE.md)
- [商业化与账本](../docs/app/MONETIZATION_AND_LEDGER.md)
- [质量与路线图](../docs/app/QUALITY_OPERATIONS_ROADMAP.md)
- [方向基线与开放问题](../docs/app/DECISIONS_AND_OPEN_QUESTIONS.md)
- [ADR-0001：KMP 与 Compose Multiplatform 客户端](../docs/adr/adr-0001-kmp-compose-multiplatform-client.md)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Google Play User-generated content](https://support.google.com/googleplay/android-developer/answer/9876937)
- [移动互联网应用程序信息服务管理规定](https://www.cac.gov.cn/2022-06/14/c_1656821626455324.htm)
