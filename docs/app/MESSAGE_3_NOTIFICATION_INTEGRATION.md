# Message-3 站内通知与可靠到达跨仓交付基线

App 版本：1.0

App API：v2 / `1.9.0`

日期：2026-08-08

状态：代码闭环与本地验证完成；production/dev 默认关闭；未执行远端 migration、真实数据联调或生产发布

## 1. 本阶段目标

Message-3 建立“业务状态变化 → D1 原子 Outbox → 固定安全模板 → 账号私有通知投影 → App HTTP 拉取 → 服务端已读与偏好”的最小可靠闭环。它让平台回复、会员处理、安全结论和账号安全事件有统一的站内到达方式，同时不把通知本身当作业务权限、处理结论或资源访问凭证。

不可改变的产品与安全事实：

- App 1.0 不接入 APNs、FCM、厂商推送、短信、邮件、WebSocket 或后台常驻轮询。
- 通知由平台业务事件生成；观看者不能创建、编辑、撤回或伪造权威通知。
- 通知只使用审核过的固定文案，不复制平台话题正文、申请说明、内部备注、安全证据、IP、精确位置或 Token。
- 会员与金币、系统与安全属于必要通知，不能被消息、互动或营销偏好关闭。
- 通知动作只使用受控 `targetType + targetId + action`；打开前由服务端重新验证账号归属、目标状态和当前 capability。
- production 与 dev 的运行时开关都保持关闭；migration 自身也不会自动生成通知、回填历史或开启清理。

## 2. 分类与偏好

| category | 用户文案 | 必要性 | 默认值 | 用户可关闭 |
|----------|----------|--------|--------|------------|
| `message` | 消息 | 可选 | 开 | 是 |
| `interaction` | 互动 | 可选 | 开 | 是 |
| `membership_coin` | 会员与金币 | 必要 | 开 | 否 |
| `system_security` | 系统与安全 | 必要 | 开 | 否 |
| `marketing` | 活动 | 可选 | 关 | 是 |

偏好使用服务端 `version` 乐观并发控制。客户端只有在 PUT 成功并收到连续版本后才显示保存成功；其他设备已修改时返回 `VERSION_CONFLICT` 并重新拉取。关闭可选类别只抑制之后尚未投影的可选 Outbox，不删除既有通知，也不影响必要通知。

## 3. 事件范围

### 3.1 当前已登记并可在策略开启后生成

| 领域 | eventType | category | 目标 |
|------|-----------|----------|------|
| 平台话题 | `message.platform_reply` | `message` | 会话 |
| 会员申请 | `membership.application_information_requested`、`membership.application_rejected`、`membership.application_expired`、`membership.application_cancelled` | `membership_coin` | 会员申请 |
| 会员权益 | `membership.granted`、`membership.revoked`、`membership.expired` | `membership_coin` | 会员页/Grant |
| 举报 | `safety.report_actioned`、`safety.report_no_violation`、`safety.report_closed` | `system_security` | 本人举报 |
| 独立复核 | `safety.appeal_upheld`、`safety.appeal_changed`、`safety.appeal_closed` | `system_security` | 本人申诉 |
| 账号安全 | `account.session_logged_in`、`account.device_revoked`、`account.refresh_token_reuse_detected` | `system_security` | 本人账号安全记录 |
| 金币账本 | `wallet.entry_posted` | `membership_coin` | 本人钱包分录 |

业务表触发器只有在 D1 策略 `generation_enabled=1` 时才写 Outbox，因此默认 migration 不会对已有业务数据或新写入产生通知。会员到期没有原始写事件，由定时恢复任务按策略 `effective_at` 之后的到期记录补建稳定 Outbox；它不会扫描或补发策略生效前的历史。

### 3.2 已预留但保持 inactive

- `interaction.followed_profile_updated`
- `data.export_ready`
- `account.deletion_updated`
- `marketing.campaign`

这些定义只冻结 category、目标和 action 形状，不开放对应业务能力，不创建模板投影，也不代表金币、数据权利、关注更新或营销已经交付。未来启用前仍需完成各自业务事实、模板审批、权限、保留和验收。

## 4. D1 权威模型与可靠性

Migration：`0076_app_in_app_notifications.sql`。

| 表 | 责任 | 关键约束 |
|----|------|----------|
| `app_notification_policies` | 版本化策略与生产门禁 | 初始 `development`、generation 关闭、保留决策未决 |
| `app_notification_event_definitions` | event/category/必要性/目标/action 注册表 | 同一策略下 eventType 唯一；必要与偏好字段相互约束 |
| `app_notification_template_versions` | 固定中文安全文案 | 当前仅 development；发布版本要求审核人与生效时间 |
| `app_notification_preferences` | 账号当前可选偏好 | 账号唯一、版本单调；必要通知没有关闭字段 |
| `app_notification_preference_events` | 偏好变更审计 | 保存版本、布尔值、设备和请求，不保存敏感正文 |
| `app_notification_outbox` | 可恢复投递事实 | `account + eventType + eventRef` 防重；状态机和重试次数受约束 |
| `app_notifications` | 账号私有用户投影 | 保存当时固定模板快照，不保存任意业务正文或访问凭证 |
| `app_notification_read_events` | 单条/分类已读审计 | 已读更新和审计在同一 D1 batch 中原子收敛 |

投递规则：

1. 业务事务由 D1 trigger 同步创建稳定 Outbox，业务成功而通知投影暂时失败时仍可恢复。
2. App 拉取前会定向处理当前账号待办；Worker 每 15 分钟也执行全局有界恢复。
3. 消费者使用 5 分钟处理租约、最多 5 次尝试和指数退避；过期租约可恢复，终态进入 `dead_letter` 供诊断。
4. 通知 ID 由 Outbox ID 的 SHA-256 稳定派生；重复执行使用 `INSERT OR IGNORE`，不会生成第二条通知或重复增加未读。
5. 可选类别在投影前读取服务端偏好，关闭时把 Outbox 标为 `suppressed`；必要类别不读取可选偏好。
6. 单条已读和分类全部已读均幂等；首次读取时间保留，多设备重复请求的 `markedCount` 为 0。

本阶段不启用删除或归档。OQ-020 未关闭前 `retention_days=NULL`、`purge_enabled=0`，也不把“不清理”解释为永久保留承诺。

## 5. App API

所有接口要求有效 App Bearer 会话，使用 `Cache-Control: no-store`，并返回 App API v2 / `1.9.0` 元信息。

| 方法 | 路径 | 责任 |
|------|------|------|
| GET | `/api/v2/notifications` | 按可选 category、稳定游标和 limit 拉取本人通知 |
| GET | `/api/v2/notifications/unread-counts` | 返回五类与总未读数 |
| GET | `/api/v2/notifications/:notificationId` | 返回固定安全详情和当前目标可用性 |
| POST | `/api/v2/notifications/:notificationId/read` | 幂等标记单条已读并记录设备审计 |
| POST | `/api/v2/notifications/read-all` | 按 category 原子标记全部已读并记录计数 |
| GET | `/api/v2/me/notification-preferences` | 读取当前策略与偏好版本 |
| PUT | `/api/v2/me/notification-preferences` | 仅更新消息、互动、营销三个可选项 |

列表游标绑定账号公开 ID 与 category，不能跨账号或跨分类复用。非法通知 ID 和其他账号对象统一按不存在处理。未读数由服务端实时聚合；客户端本地更新只改善反馈，不成为权威事实。

Bootstrap 新增：

- `capabilities.notifications`
- `notifications.policyVersion`
- 固定 `transport=http_pull`
- `maxPageSize=40`
- 五类稳定 category、文案和 `optional|required` 属性

KMP 只有在 Auth、通知开关、策略 ID、HTTP 传输、分页范围和完整五类配置全部一致，且 `systemPush=false` 时才开放入口；未知或矛盾配置按关闭处理。

## 6. 受控目标动作

当前契约支持以下目标：会话、人物资料、会员、会员申请、钱包分录、举报、申诉、账号安全、数据任务和无目标。服务端在每次响应时重新验证：

- 会话、会员、申请、举报、申诉和账号安全记录必须属于当前账号。
- 人物资料必须仍是公开且可见的权威投影。
- 对应业务 capability 必须当前可用。
- Wallet-1 开启时，钱包分录必须属于当前账号且仍为 posted；数据任务尚未交付，目标继续返回不可用。

目标不可用时通知正文仍可安全读取，但 `available=false`，客户端不执行动作。客户端当前动作只进入已有权威页面；通知中的历史文案不直接改变会员、消息或安全状态。

## 7. KMP 客户端

- “消息”一级页增加“平台话题 / 站内通知”切换，不改变既有平台运营身份披露。
- 通知页覆盖 capability 关闭、未登录、加载、分类空态、错误、列表、未读和分类全部已读。
- 通知详情先拉取服务端安全详情；未读项打开后再幂等标记已读，并同步本地红点。
- 设置页只允许修改消息、互动和活动；会员与金币、系统与安全明确显示为必要通知。
- 所有请求通过 Auth-1 单航班续期和会话失效清理，不把 Token、通知正文或目标数据写入本地业务缓存。
- App 不申请系统通知权限，不声称实时到达；用户进入通知页、切换分类或手动重试时通过 HTTP 获取最新状态。

## 8. 管理后台

Nuxt 路由：`/admin/app/notifications`。

管理员 API：

- `GET /api/admin/app/notifications/overview`
- `GET /api/admin/app/notifications/events`
- `GET /api/admin/app/notifications/templates`
- `GET /api/admin/app/notifications/deliveries`

当前后台是只读运行台，展示运行时/D1 双门禁、未决保留风险、事件定义、模板状态和投递状态。投递查询只返回 Outbox/通知引用、eventType、category、必要性、账号公开 ID、状态、尝试次数、错误码和时间，不返回模板正文、平台话题正文、举报说明、证据、内部备注或 Token。策略发布、模板审批、补发、撤回和营销群发仍未开放写入口。

## 9. 运行开关与启用门禁

| 变量 | 含义 | 当前 production/dev |
|------|------|---------------------|
| `APP_NOTIFICATIONS_ENABLED` | App 用户通知能力 | `false` |
| `APP_NOTIFICATIONS_ADMIN_ENABLED` | 管理后台通知运行台 | `false` |
| `APP_NOTIFICATIONS_POLICY_VERSION` | 选择策略 ID | development ID，仅配置不启用 |
| `APP_NOTIFICATIONS_PRODUCTION_READY` | production 额外门禁 | `false` |

运行时开关和 D1 策略是两道独立门禁。production 还要求策略为 `published`、`production_ready=1`、`decision_status=approved`、已确定保留天数及生效时间，并且只使用已发布模板。任何一项缺失都 fail closed。

启用前必须完成：

1. 关闭 OQ-020，审批通知、Outbox、已读、偏好、审计和备份的保留/删除政策及数据权利处理方式。
2. 形成新的 published 策略和逐事件已审核模板，不原地提升 development 记录。
3. 明确运营值班、dead letter、必要通知积压、模板回滚和安全事件处置 Runbook。
4. 在隔离 dev 数据执行 `0076`，按事件逐项做真实 HTTP、重复消费、租约恢复、断网、多设备、目标失效和回滚演练。
5. 完成 Android/iOS 真机、大字体、屏幕阅读器、窄屏、弱网和长中文验收。
6. 先开启只读后台观察，再开启 generation 和用户 capability；production 需独立审批，不能由 dev 状态自动复制。

## 10. 验证记录与未完成项

已验证：

- migration 默认关闭、无 seed、无历史回填、无自动清理。
- 平台回复原子 Outbox、固定安全文案、稳定通知 ID、偏好抑制、必要通知不被关闭。
- 服务端未读数、单条已读、分类全部已读、重复操作计数、设备审计和账号/category 游标隔离。
- 目标 capability 关闭与目标归属失效时不执行受控动作。
- App API 路由、OpenAPI、TypeScript、Nuxt 后台类型、API/Web 全量单元测试和 Android Host Test/Debug APK。
- iOS Simulator Kotlin/Native 编译通过；本机 Framework 链接仍被未接受的 Xcode 许可导致的 `xcrun` 69 拦截，应继续由 macOS CI 完成链接门禁。

尚未完成：

- dev/production `0076` migration、远程 Worker 部署、真实 HTTP smoke、真机 UI 与多设备验收。
- OQ-020、生产模板审批、正式告警阈值、值班与数据权利 Runbook。
- 实时刷新信号、APNs/FCM、关注更新、数据导出/注销和营销事件的业务启用；Wallet-1 仍需独立完成远端 migration 与启用门禁。
- 模板/策略写后台、受控补发/撤回、统计看板和 production 发布。
