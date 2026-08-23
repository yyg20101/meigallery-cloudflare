# Message-8 文本消息审核与结果通知开发基线

日期：2026-08-20

状态：Cloudflare 源码开发完成；策略、规则、migration、构建、测试和环境验证后置；production 默认关闭

## 1. 本次完成范围

Message-8 交付时在不改变当时累计 App API v2 `1.25.0` 公共 DTO 的前提下，让既有消息状态 `accepted | review_pending | rejected | recalled` 第一次具备服务端审核语义：

- `0112_app_message_moderation.sql` 新增默认关闭的版本化审核策略、不可变规则、无正文评估事实、人工复核案件、追加式案件事件和独立幂等结果。
- 观看者与平台运营文本发送先完成原有 entitlement、会话、安全、assignment 和频控校验，再按显式选择的审核策略判定；消息、评估、待审案件、幂等结果和会话 sequence 在同一 D1 `batch()` 收敛。
- 未配置 `APP_MESSAGE_MODERATION_POLICY_VERSION` 时保持原有 `accepted` 行为；显式策略缺失、失效或未通过 production 门禁时 fail closed。development seed 为 `evaluation_enabled=0`，且 migration 不写任何规则。
- `review_pending` 与 `rejected` 只占用内部原始 sequence，不改变正常会话的 `queue_status/last_message_at/updated_at`，不计入未读和自动分配，也不进入普通运营正文工作台；人工最终 `accepted` 时把消息原子重排到当前末尾，再按该已交付参与方推进 `awaiting_operator | awaiting_viewer`。
- 观看者仍可在本人 HTTP 消息列表看到本人 `review_pending/rejected` 状态；待审或拒绝的平台运营消息不会提前暴露给观看者。
- 观看者会话摘要、分页游标、活动时间与普通运营摘要均使用各自可见消息投影；质检只抽取 `accepted` 运营回复及相邻已接受上下文。本人数据导出保留本人所有发送状态，但不会导出从未交付的运营待审/拒绝正文。
- 新增内部管理接口 `/api/admin/app/message-moderation/cases*`，提供无正文队列、10 分钟领取租约、领取后专用正文访问、独立通过/拒绝和幂等重放。正文访问目的固定为 `message_moderation_review` 并写审计。
- 平台运营发送者不能领取或裁决自己的待审消息；D1 trigger 与服务层同时执行作者隔离。
- Privacy-2B 关闭账号话题前会把该账号所有 `pending/in_review` 案件收敛为系统 `cancelled`：清除正文租约与审核命令重放记录、追加 `account_deletion` 事件，但不改写合规保留的原消息正文或触发审核结果通知。
- Message-3 增加消息审核通过/拒绝、管理员会话只读/关闭四类固定安全模板。运营待审消息只在最终通过后生成 `message.platform_reply`；管理员“先限制、后关闭”会分别形成两条结果，观看者主动关闭不会误生成管理员限制通知。

## 2. 默认关闭与生产门禁

审核能力没有独立“自动启用”捷径。运行时必须显式选择策略 ID，且策略本身满足 `evaluation_enabled=1` 与生效时间；production 还必须同时满足：

- `state=published`
- `decision_status=approved`
- `production_ready=1`
- `effective_at` 已到达

`0112` 的 development seed 为 `unresolved + production_ready=0 + evaluation_enabled=0`。migration 不修改 Wrangler、不启用消息或通知能力、不回填历史消息、不创建通知 Outbox，也不授权 Alpha/Beta。

OQ-021 未关闭前只能保留规则接口、人工队列和测试数据，不能配置真实 production 规则或开放用户流量。规则只在数据库存在有效记录时执行；URL、邮箱和电话检测也必须由显式规则启用，不存在隐藏的硬编码业务处罚。

## 3. 数据与隐私边界

消息正文继续只保存在 `app_conversation_messages.body_text`：

- `app_message_moderation_evaluations` 只保存消息引用、策略/规则引用、结论、原因代码、正文 SHA-256 与长度。
- `app_message_moderation_cases` 只保存状态、版本、租约、复核人和原因代码，不复制正文。
- 队列列表不返回正文；只有当前领取人且租约有效时可读取原消息正文，每次读取写 `app_message_moderation.body_access`。
- 通用审计只保存消息/案件引用、正文哈希、长度、状态和原因，不保存正文、规则阈值或内部备注。
- 通过与拒绝均使用 `expectedVersion + Idempotency-Key`，案件事件追加写；重复请求返回原冻结裁决，并重新尝试可幂等的自动分配与实时刷新，弥补数据库已提交但首次异步调度未发生的窗口。

## 4. 状态与队列语义

| 消息状态 | 发送者可见 | 正常接收方可见 | 普通运营工作台 | 队列/自动分配 |
|----------|------------|----------------|----------------|---------------|
| `accepted` | 是 | 是 | 是 | 按交付后的发送方推进 |
| `review_pending` | 是 | 否 | 否，仅审核案件可领取 | 不改变 |
| `rejected` | 是 | 否 | 否，终态元数据留在审核队列 | 不改变 |
| `recalled` | 占位 | 占位 | 占位 | 本次未新增召回写入口 |

待审消息对接收方尚未形成交付。人工通过时，服务端在同一条件批次把该消息重排到当前 `last_sequence + 1`，更新业务活跃时间，再按发送方形成新的队列方向；因此不会把后来才可见的旧 sequence 落到接收方已经推进的分页游标或已读水位之前。观看者消息最终通过并形成 `awaiting_operator` 时，才异步尝试既有自动分配。

待审/拒绝消息仍保留内部序号缺口，客户端不得从缺口推断正文、发送方或交付事实；对外摘要只返回当前主体可见的最大 sequence。消息身份始终以 `messageId` 为准，发送者刷新后接受最终 sequence/status。

## 5. 内部管理 API

| 方法 | 路径 | 约束 |
|------|------|------|
| GET | `/api/admin/app/message-moderation/cases` | 默认只列 `pending/in_review`；不返回正文 |
| POST | `/api/admin/app/message-moderation/cases/:caseId/claim` | `expectedVersion + Idempotency-Key`；10 分钟租约；禁止作者自领 |
| GET | `/api/admin/app/message-moderation/cases/:caseId?accessReason=message_moderation_review` | 仅当前有效领取人读取正文并审计 |
| POST | `/api/admin/app/message-moderation/cases/:caseId/decision` | 独立通过/拒绝；条件更新消息、案件、事件、审计和幂等结果 |

这些接口属于 Nuxt 管理内部契约，不进入 KMP 公共 transport，也不提升 App API v2 版本。

案件另有只读终态 `cancelled`，仅由 Privacy-2B 账号注销执行器写入；管理员不能用审核 API 主动取消案件，也不能恢复已取消租约。

## 6. Figma 与页面边界

本次没有新增 Page ID、页面状态或视觉实现：

- 移动端 `APP-MSG-03` 已有正式“审核中”状态 `159:68997`，现有消息 DTO/KMP 映射已支持 `review_pending/rejected/recalled`，无需新增客户端页面。
- `APP-MSG-03` 消息操作正式节点 `505:2` 只有“举报此消息 / 取消”，没有召回动作。OQ-033 未关闭且 Figma 未提供正式入口，因此本次不新增召回 API、KMP 按钮或自定义 UI。
- 管理后台 `ADM-MSG-01/02` 的正式页面没有独立文本审核队列/详情设计。本次只提供受保护 API 和数据闭环，不新增 Nuxt 页面、导航或非 Figma 状态；待正式 Figma Node ID 后再接 UI。

当前注册表事实保持 99 个 Page ID / 408 个正式状态；Mobile 保持 50/208，Admin 保持 49/200。

## 7. 通知行为

- `message.review_accepted`、`message.review_rejected`：可选消息通知，受消息偏好和单会话免打扰约束，不包含正文或内部原因。
- `message.conversation_restricted`、`message.conversation_closed`：管理员/安全动作产生的必要系统安全通知；观看者本人关闭不触发。
- 同一话题从 `active -> restricted -> closed` 时使用不同 Outbox 身份，限制和关闭不会相互去重。
- 待审平台回复从 `review_pending -> accepted` 时补写一次既有 `message.platform_reply`；直接 `accepted` 继续使用原 INSERT trigger，二者不会重复。
- 所有 trigger 仍要求当前通知策略 `generation_enabled=1`；运行时投递还需通过 Message-3 现有环境与 production-ready 门禁。

## 8. 已编写但未执行的验证

`app-message-moderation.d1.test.ts` 已覆盖：

- 未选择策略时保持 accepted 且没有审核事实；
- 命中 review 规则后进入专用队列、普通工作台无正文；
- 独立领取、用途化正文访问、通过后队列重算和幂等重放；
- 人工通过后的末尾重排、重放副作用恢复与拒绝时原 sequence 保持；
- 运营作者不能自审；
- 人工拒绝与规则直接拒绝均仅对发送者状态可见并生成安全摘要通知；
- 待审平台回复只在最终通过后通知；
- 管理员限制、后续关闭通知与观看者自关抑制。
- 账号注销取消待审案件、清租约/重放记录且不生成审核结果通知。

按当前开发顺序，本轮不执行 `0112`、不运行构建或测试、不写环境配置，也不做模拟器/真机 QA。全部开发结束后统一验证。
