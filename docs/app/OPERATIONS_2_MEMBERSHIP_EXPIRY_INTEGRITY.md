# Operations-2 会员到期权限完整性检测开发基线

更新时间：2026-08-20

App 版本：1.0

状态：开发闭环完成；migration 执行、调度、构建与专项测试后置

## 1. 本阶段结论

Operations-2 在 Operations-1 的事件与 Runbook 体系上补齐会员到期后的权限泄漏反向检测：

- `admin-app-operations` 检测器升级为 `operations-detectors-v2`。
- Operations-2 交付时 D1 权威事实可执行 10 类检测；当时仅 Cloudflare 平台健康等待外部来源，运行固定报告 `unavailableDetectorCount=1`。后续 Operations-3 已接入官方 Status API，这一条仅保留为历史阶段快照，当前口径见 [Operations-3](./OPERATIONS_3_CLOUDFLARE_STATUS_INTEGRATION.md)。
- `0106_app_operations_membership_expiry_detector.sql` 只增加观看者消息的局部覆盖索引，不创建业务表、不写真实数据，也不改变 grant 或消息。
- 命中后复用既有 `membership_expiry_not_revoked / membership / P1` Incident、`oprb_membership_integrity_v1` Runbook 和 `ADM-OV-01/02/03` 页面。

本阶段交付时不扩展 App API v2，也不改变当时累计 `1.25.0` 契约或向 KMP 暴露运营数据；Membership-7 后仓库当前累计为 `1.26.0`。

## 2. “自然到期”不是异常

`app_membership_grants` 以半开区间表达权限：业务动作发生时必须满足 `starts_at <= actionTime < expires_at`，并且不存在动作时刻已经生效的追加式撤销记录。到达 `expires_at` 后，服务端查询会自然排除该 grant，不要求额外创建一条 revocation。

因此检测器不会把下列情况误报为事件：

- grant 正常到期且之后没有发生需会员授权的动作；
- 账号在旧 grant 到期后取得另一条当时有效、未撤销且含对应 entitlement 的 grant；
- 管理员在自然到期前通过正式撤销流程提前终止 grant。

`membership_expiry_not_revoked` 是既有稳定事件类型名称；在 Operations-2 中它的精确定义是“会员授权失效后仍出现受限业务事实”，不是“到期后缺少撤销行”。

## 3. 两类反向事实

### 3.1 新话题创建事实

`app_conversation_quota_consumptions` 只会随新话题创建写入，并记录当次授权使用的 `membership_grant_id`。检测器先确认关联 grant 满足 `expires_at <= consumed_at`，再排除同账号、同目录在创建时刻已有另一条有效、未撤销，并具备完整可执行消息权益的替代 grant；只有无法由替代授权解释时，才按一条创建事实计一次影响。这样不会把正常续期或升级误报为到期泄漏。

正常创建路径仍在最终 D1 `INSERT ... SELECT` 中同时重验：

- grant 归属当前账号与当前目录；
- `starts_at <= now < expires_at`；
- grant 未撤销；
- `direct_message.create` 可用且为 `true`；
- 新话题日额度仍有余额。

检测器是上述门禁的只读反向校验，不替代在线授权。

### 3.2 观看者发送事实

对每条 `sender_type='viewer'` 的消息，检测器仅在同时满足以下条件时计入：

1. 账号存在一条在消息时刻之前已自然到期、且没有在自然到期前被提前撤销的 grant；
2. 消息发生时不存在另一条 `starts_at <= created_at < expires_at`、未在该时刻撤销、且 `direct_message.send` 为 `available + true` 的 grant。

这使续期、升级或重叠有效 grant 不会被误报，同时能发现到期后的发送绕过。正常发送路径仍在最终 SQL 中重新验证账号归属、会话状态、人物公开资格、运行控制、有效 grant 与 entitlement。

## 4. 事件与隐私边界

检测结果使用稳定事实：

| 字段 | 固定值 |
|------|--------|
| detector key | `membership.expiry_access` |
| incident key | `detector:membership_expiry_not_revoked:global` |
| type / domain / severity | `membership_expiry_not_revoked / membership / p1` |
| source reference | `app_managed_conversations.membership_expiry_access` |
| Runbook | `oprb_membership_integrity_v1` |

检测运行、finding、Incident 列表与审计只保存聚合数量、稳定 key、严重级别和证据摘要。不得写入账号 ID、联系方式、消息正文、消息哈希、grant 备注或个人级排行。需要调查时由受控事件详情和原业务工作台按现有权限、用途审计与最小披露规则读取权威事实。

检测器不自动编辑 grant、不补造 revocation、不删除消息、不关闭话题，也不自动暂停会员发放。是否暂停 `membership_grants` 仍由 Owner 使用未关闭 P0/P1 事件显式确认；暂停只阻断新发放和发放型批准，不阻断撤销、拒绝、调查与只读核对。

## 5. Figma 与后台页面复用

Operations-2 不新增页面、弹层或页面状态，严格复用 `20｜Admin Pages` 中已经登记的正式页面：

- `ADM-OV-01`：显示累计检测运行、未知来源和事件摘要；
- `ADM-OV-02`：按既有 `membership_expiry_not_revoked` 类型筛选、领取事件；
- `ADM-OV-03`：查看聚合影响、关联会员完整性 Runbook、记录处置和带证据关闭。

三页仍各使用原有四个正式状态和既有 Nuxt 交互。检测器只增加一种可由已有事件类型呈现的权威事实，不改变 99 个 Page ID、408 个正式状态、移动端 208 个状态或管理后台 200 个状态。

## 6. Migration 边界

`0106_app_operations_membership_expiry_detector.sql` 新增：

```sql
CREATE INDEX idx_app_conversation_messages_viewer_created
  ON app_conversation_messages (created_at, conversation_id, id)
  WHERE sender_type = 'viewer';
```

该局部索引覆盖只读反向扫描所需的消息时间、话题与消息 ID，避免把平台运营和系统消息纳入扫描。它不 seed 数据、不改变表约束、不建立自动修复 trigger，也不要求新增 Cloudflare binding。

## 7. 开发结束后统一完成

当前明确后置，不在本阶段执行：

- 在目标环境按顺序执行到 `0106_app_operations_membership_expiry_detector.sql`，核对 migration 记录和索引存在性；
- 对零命中、到期创建、到期发送、续期不误报、提前撤销、幂等重跑和事件重新打开执行 D1 专项测试；
- 运行 API 类型检查、构建和 Operations 管理 API 回归；
- 在已有 `ADM-OV-01/02/03` 页面完成窄屏、权限、筛选、并发和关闭证据验收；
- 配置受控检测调度，并验证 Operations-3 Cloudflare 官方状态读取的健康、异常与来源不可用分支；账户级指标仍不能用零值替代未配置来源。

在以上事项完成前，源码存在不等于目标环境已应用 `0106`，也不构成 production 启用或调度授权。
