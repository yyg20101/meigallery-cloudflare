# Membership-6 会员批量发放服务端交付基线

更新时间：2026-08-20

App 版本：1.0

状态：Cloudflare 服务端源码开发完成；Figma、Nuxt 可见页面、migration、治理配置、构建、测试和环境 QA 后置

## 1. 本阶段结论

Membership-6 为 App 五级会员补齐默认关闭的批量发放编排，但没有增加第二条会员写入链路：

- 固定 CSV 先生成不可变批次和逐行预览证据，不创建 grant，不改变 rank 或 entitlement。
- 每个有效行提交时都调用 Membership-3 的普通 `app_membership_change_requests`，状态仍为 `pending_review`；只有另一位管理员逐项批准并由既有 D1 条件事务写入正式 grant 后才生效。
- 单行校验或提交失败不会回滚其他行；已关联 `change_request_id` 的成功行不会再次创建复核申请。
- 批次提交使用 10 分钟租约、执行令牌、乐观版本和逐行稳定幂等键；响应丢失或 Worker 中断后仅创建人可恢复过期任务。
- `0104_app_membership_batch_grants.sql` 只为 development 目录写入 `enabled=0` 的控制记录，不自动开放任何环境。

Membership-6 本身没有新增公共 App API v2 响应字段或路径，交付时累计 transport 版本仍为 `1.24.0`；Membership-7 后仓库当前累计版本为 `1.26.0`。

## 2. CSV 契约

文件采用 UTF-8 文本，最多 500,000 字节、200 个数据行；表头顺序固定为：

```csv
account_id,tier_id,action,starts_at,duration_days,reason_code,user_visible_note,internal_note,business_reference
```

逐行规则：

- `account_id` 只接受稳定公开账号 ID `acc_*`，不接受数据库整数 ID、邮箱或昵称。
- `tier_id` 必须属于当前运行的 App 会员目录；`action` 只允许 `grant|renew`。
- `starts_at` 可留空；预览会记录当次估算时间，提交时仍按当前账号、目录、grant 和服务端时间重新校验，留空行以实际提交时间为准。
- `duration_days` 为 `1–366`；原因只允许 `manual_review|customer_support|promotion|compensation`。
- 用户可见说明、内部备注和业务单号均必填。内部备注不会进入用户响应、通知、通用错误或分析事件。
- 表头、引号、列数或文件大小错误会拒绝整个文件；业务字段、账号、目录或重复业务单号错误只把对应行标记为 `invalid`。
- 同一批次内，同一账号的 `business_reference` 必须唯一；提交时还会复用 Membership-3 的全局活动业务单号校验。

## 3. 权威数据与状态机

Migration：`0104_app_membership_batch_grants.sql`。

- `app_membership_batch_controls`：按目录版本控制是否允许批量、最大行数和大批次阈值。启用时必须同时保存 OQ-018 决策引用、批准人和批准时间。
- `app_membership_grant_batches`：保存来源名称、规范化 CSV SHA-256、数量、风险代码、乐观版本、处理租约、提交或取消事实。
- `app_membership_grant_batch_items`：保存原始行 JSON、行 SHA-256、账号/等级快照、预览区间、必填说明、错误和普通复核申请引用。
- `app_membership_grant_batch_requests`：保存 `submit|cancel` 命令的幂等键、请求哈希和终态。

批次状态为 `draft → processing → submitted|partial_failed`，尚未提交的 `draft` 也可由创建人填写原因后进入 `cancelled`。`partial_failed` 重试只领取 `submit_failed` 行；原始 `invalid` 行属于不可变输入证据，修正后必须创建新批次。终态、原始预览字段、逐行证据和幂等结果不可修改或删除。

每个有效行使用 `membership.batch.{batchId}.{rowNumber}` 作为普通会员变更申请的稳定幂等键。若复核申请已创建但批次行回写中断，恢复时 Membership-3 返回原申请并补齐 `change_request_id`，不会产生第二份期限或通知。

## 4. 管理员 API

全部路径位于现有管理员会话和 `APP_MEMBERSHIP_ADMIN_ENABLED` 门禁下；预览、提交和取消还要求 D1 批量控制已启用。

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/admin/app/memberships/batches` | 列出当前目录批次摘要 |
| `POST` | `/api/admin/app/memberships/batches/preview` | 校验 CSV 并创建不可变预览 |
| `GET` | `/api/admin/app/memberships/batches/:batchId` | 读取逐行结果；敏感读取写审计 |
| `POST` | `/api/admin/app/memberships/batches/:batchId/submit` | 按 `expectedVersion` 提交/恢复有效行 |
| `POST` | `/api/admin/app/memberships/batches/:batchId/cancel` | 创建人按 `expectedVersion` 和原因取消 draft |

三类写命令都要求 `Idempotency-Key`。同键同请求返回原结果，同键不同操作、批次、版本或正文返回冲突。列表和详情不会直接执行会员变更。

## 5. 账号、安全、审计与数据权利

- 预览解析和单行提交都要求 `users.status='active'` 且 `app_account_security.status='active'`；不存在 App 安全账号、受限或待注销账号不能获得新复核申请。
- Membership-6 同步修正了单笔发放、申请列表和复核详情中三处错误的 `app_account_security.user_id` 关联，权威关联统一为 `account_id`。
- 审计 Action 包含 `app.membership.batch.preview`、`app.membership.batch.view`、`app.membership.batch.submit_claim`、`app.membership.batch.submit` 和 `app.membership.batch.cancel`；每行创建普通复核申请时继续写 `app.membership.change.request`。
- Audit-3 会把尚未登记的新 Action 作为治理缺口发现；本阶段不伪造 production-ready Action Registry。
- Privacy-2B 的 `membership` 法定保留域计数已包含 `app_membership_grant_batch_items`。批次原始行和内部备注属于管理员合规证据，不进入用户 Privacy-2A 导出制品。

## 6. Figma 与 Nuxt 边界

当前正式页面注册表仍为 99 个页面、408 个状态，其中移动端 208、管理后台 200；Figma 尚无会员批量发放的正式 Page ID 或状态节点。

因此本阶段没有新增 Nuxt 页面、导航项、占位按钮或自拟视觉状态：

- `ADM-MBR-04` 继续只处理单账号预览与变更申请。
- `ADM-MBR-05` 继续逐单复核，包括由批次创建的普通复核申请。
- 只有先在 Figma 建立正式页面、状态和交互并更新注册表后，才能开发可见批量工作台。

该边界不会改变 408/208/200 的当前事实，也不会把历史 3,571 个动作基线误写为最新动作总数。

## 7. 默认关闭与后置事项

- OQ-018 尚未关闭；角色职责、批量阈值、审批人、异常处置和生产启用决定仍需书面确认。
- `0104` 尚未在 local/dev/production 执行，现有数据库和真实会员数据没有变化。
- 不修改 Wrangler、目录 production-ready、会员运行开关或任何真实治理配置。
- 构建、类型检查、migration 验证、CSV/并发/租约/幂等专项测试、双管理员 E2E、Figma 后续页面和浏览器 QA 均在全部开发结束后统一执行。
