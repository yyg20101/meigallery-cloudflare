# Membership-2 站内会员申请跨仓交付基线

App 版本：1.0

App API：v2 / `1.8.0`
状态：代码闭环完成，production/dev 默认关闭，尚未执行远端 migration 或真实数据联调

## 1. 本阶段目标

Membership-2 补齐“查看五级会员 → 提交站内申请 → 平台人工处理 → 正式 grant 生效 → App 刷新权益”的最小纵向闭环。它不引入在线支付、自动续费、价格、系统推送或外部私聊渠道。

不可改变的产品事实：

- 注册账号只是观看者，不会因提交申请成为人物、运营或会员。
- 申请与会员权限严格分离；申请状态为已提交、处理中或待补充时，rank 和 entitlement 不变化。
- 联系方式固定复用已验证登录邮箱，申请表不再采集手机号、微信号或任意联系文本。
- 平台人工处理不等于真人本人接收或回复，也不承诺固定时效、必然通过、线下见面或关系结果。
- “已发放”只能在 Membership-1 正式 grant 成功后出现，不能由管理员单独修改申请状态伪造。

## 2. 用户流程与状态机

客户端未提交表单只属于进程内草稿，不写 D1。服务端状态为：

```text
submitted ──领取──> processing ──要求补充──> needs_information
    │                    │                          │
    │                    ├─提交独立复核────────────┤（仍为 processing）
    │                    ├─复核批准且 grant 成功──> approved
    │                    ├─拒绝────────────────────> rejected
    │                    ├─过期────────────────────> expired
    │                    └─平台取消────────────────> cancelled
    │
    ├─用户取消──────────> cancelled
    └─过期──────────────> expired

needs_information ──用户补充并重新确认说明──> submitted
needs_information ──用户取消────────────────> cancelled
```

约束：

- 一个账号同时最多一条 `submitted|processing|needs_information` 申请。
- 申请绑定提交时的目录版本与 tier 快照；后台队列跨版本保留。尚未取得发放锁的旧目录申请不得在新目录下提交复核，应结束旧申请并要求重新提交；已经锁定的复核操作必须复用原键和原目录恢复，不能留下 grant、复核结果与申请终态分叉。
- 用户只能取消 `submitted|needs_information`；`processing` 和发放锁定阶段禁止取消，避免 grant 与申请终态分叉。
- 用户补充时不能更换原意向等级；如需改等级，应取消后重新提交。
- 每次状态变化增加单调 `version`，并追加同序号用户可见事件。
- `approved` 当且仅当 `grant_id` 非空；其他状态不得关联 grant。

## 3. 用户 API

所有写接口都要求 App Bearer 会话，且 capability `membership.applications=true`：

| 方法 | 路径 | 责任 |
|------|------|------|
| GET | `/api/v2/me/membership-applications` | 最近 20 条本人申请与时间线 |
| GET | `/api/v2/membership-applications/:applicationId` | 读取本人单条申请；越权统一按不存在处理 |
| POST | `/api/v2/membership-applications` | 选择 tier、联系偏好、可选说明并确认当前披露版本 |
| POST | `/api/v2/membership-applications/:applicationId/resubmit` | 仅待补充状态，携带 `expectedVersion` 重新入队 |
| POST | `/api/v2/membership-applications/:applicationId/cancel` | 仅可取消状态，携带 `expectedVersion` 取消 |

提交、补充和取消必须携带 16–128 位安全 `Idempotency-Key`。同键同正文返回原申请；同键不同正文返回 `IDEMPOTENCY_CONFLICT`。提交时若已存在进行中申请，即使使用新键也返回该申请，不创建第二个工单。

用户投影包含：申请 ID、提交目录版本、意向 tier 快照、脱敏邮箱、联系偏好、申请说明、披露版本、状态说明、版本、允许操作、grant 引用、时间和用户可见时间线。不得包含处理人、内部备注、原因内部分类、发放锁或审计记录。

## 4. 管理员 API 与控制台

Nuxt 路由：`/admin/app/membership/applications`。

| 方法 | 路径 | 责任 |
|------|------|------|
| GET | `/api/admin/app/memberships/applications` | 按状态、tier、提交时间、处理人筛选队列；邮箱脱敏 |
| GET | `/api/admin/app/memberships/applications/:applicationId` | 处理所需完整账号、当前 App 会员、申请和时间线 |
| POST | `.../:applicationId/claim` | 领取待处理申请 |
| POST | `.../:applicationId/request-information` | 要求补充，原因与说明对用户可见 |
| POST | `.../:applicationId/reject` | 标准原因拒绝 |
| POST | `.../:applicationId/expire` | 标准原因过期 |
| POST | `.../:applicationId/cancel` | 平台取消 |
| POST | `.../:applicationId/approve` | 锁定申请并提交 Membership-3 发放独立复核 |

管理员写操作均写 `admin_audit_logs`。通用审计只保存申请引用、前后状态、版本、标准原因、grant ID 和“是否存在说明/内部备注”，不保存邮箱、申请说明或用户可见自由文本正文。

复核与恢复规则：

1. 先执行 Membership-1 grant 预览，验证账号、tier、时间、业务单、目录门禁和 Membership-3 风险策略。
2. 使用请求幂等键在同一 D1 批次创建 `pending_review` 申请并写入 `approval_request_key`；其他申请终态操作随即被拒绝。
3. 申请继续显示 `processing`，rank、grant 与 entitlement 均不变化；发起管理员不得自行复核。
4. 另一管理员批准时重新核对账号、当前最高有效 grant、业务单与申请锁；全部一致才原子创建正式 grant、把申请改为 `approved`、关联 `grant_id`、追加事件和审计。
5. 复核拒绝或账号状态变化会释放发放锁，原处理人可修正后使用新幂等键重新提交；重复请求必须复用原键，不能生成第二条进行中复核或第二个 grant。

## 5. 数据模型

Migration：`0075_app_membership_applications.sql`。

| 表 | 内容 | 隐私/一致性约束 |
|----|------|----------------|
| `app_membership_applications` | 意向 tier 快照、联系偏好、可选说明、状态、版本、处理人、原因、发放锁、grant 引用 | 不复制邮箱；进行中账号部分唯一；approved/grant 双向 CHECK |
| `app_membership_application_events` | 用户可见状态时间线 | sequence 唯一；不保存申请正文或内部备注 |
| `app_membership_application_requests` | 用户写操作幂等结果 | 账号 + key 唯一；绑定 operation、请求 SHA-256 和申请 |

OQ-020 尚未关闭。本 migration 只建立逻辑字段和索引，不创建 TTL、定时清理、R2 归档或对外保留承诺；不得因此把真实申请导入 production。

## 6. Bootstrap 与开关

新增环境变量：

| 变量 | 含义 | 当前 production/dev |
|------|------|---------------------|
| `APP_MEMBERSHIP_APPLICATIONS_ENABLED` | 站内会员申请用户能力 | `false` |

实际 capability 还要求：

```text
Auth 安全可用
AND APP_MEMBERSHIP_ENABLED=true
AND APP_MEMBERSHIP_APPLICATIONS_ENABLED=true
AND 已选择目录版本
AND production-ready 门禁满足
```

bootstrap 同时下发披露版本、披露正文、`verified_email`、300 字上限和四个联系偏好。客户端只有在 capability 与配置都合法且彼此一致时显示申请入口；未知或矛盾字段按关闭处理。

OQ-010 未关闭，因此正文固定说明人工处理但不承诺固定 SLA。不得显示“通常一个工作日”“10:00–22:00 必定回复”等尚未确认文案。

## 7. KMP 客户端

- 会员页只在登录、application capability 和策略同时安全可用时显示申请入口。
- 独立申请页支持五级选择、联系偏好、300 字说明、当前披露确认和提交；不显示价格、购买、付款凭证或站外联系方式。
- 进行中申请优先进入状态页；待补充可编辑联系偏好与说明，意向等级锁定。
- 取消必须二次确认；提交期间按钮禁用，失败保留输入并显示可理解错误。
- 同一逻辑写入在失败后继续复用原请求 token；只有输入、版本或操作发生变化才生成新 token，避免响应丢失后把安全重试误判为第二次操作。
- 已拒绝、已取消、已过期或已发放属于历史终态，用户可查看原时间线并重新发起新申请；进行中申请仍优先进入原状态页。
- 状态和时间线完全读取服务端；客户端不根据本地时间推导过期，不根据 `approved` 之外的状态开放权限。
- 客户端对比申请目录与当前目录；旧目录进行中申请只允许服务端仍声明安全的取消，不允许按新目录补充或本地替换意向。
- 会员页同时刷新申请与 `/me/entitlements`；即使申请显示已发放，受限功能仍逐请求由服务端 entitlement 授权。

## 8. 已验证与未完成

已验证：

- D1：单活跃申请、重复提交、用户取消、待补充/重新入队、版本冲突、正式发放、幂等恢复、grant 唯一和审计隐私。
- App API：v2 / `1.8.0` bootstrap 开关与不承诺 SLA 的配置。
- KMP：授权路径、请求头、独立幂等键、严格 DTO 映射、capability 关闭零请求、Host Test 和 Android 编译。
- Nuxt：申请队列与详情页面通过类型检查和 Worker build 门禁。

尚未完成：

- dev/production `0075` migration、远程 HTTP smoke、Android/iOS 真机 UI 与辅助功能验收。
- OQ-010 服务时段和运营排班确认；当前不得承诺 SLA。
- OQ-020 申请、事件、审计和备份保留/删除政策；当前不得创建生产清理任务。
- Message-3 站内通知；当前状态依赖用户主动刷新，不伪装系统推送或实时到达。
- Membership-3 `0088` migration、真实风险策略、专项测试和环境联调。
- 批量发放、旧会员迁移、在线支付、礼物和虚拟商品。

## 9. 启用前门禁

1. 完成客户对申请字段、状态文案、拒绝原因和服务边界的需求确认。
2. 关闭 OQ-010/OQ-020，形成运营排班、保留政策、数据主体请求和事故处置 Runbook。
3. 创建新的 `published + production_ready` 会员目录，不原地提升开发目录。
4. 在隔离 dev 数据连续执行 `0075` 与 `0088`、API/后台部署、真实 HTTP smoke、双人隔离、并发/断网/重复提交与回滚演练。
5. 完成 Android/iOS 真机、大字体、屏幕阅读器、软键盘、长中文、窄屏和弱网验收。
6. 先开启后台能力验证，再小范围开启用户申请；production 必须独立审批，不因 dev 成功自动开启。
